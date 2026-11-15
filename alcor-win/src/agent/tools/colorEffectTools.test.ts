import { describe, expect, it } from "vitest";
import { makeEffect, makeEffectParam, makeKeyframe, makeKeyframeTrack, type Clip } from "../../model";
import { inspectorServices } from "../../inspector/services";
import { Fixtures } from "../../editor/mutations/testFixtures";
import "./colorGroup";
import { colorFrameIO } from "./colorFrames";
import { colorObject } from "./colorTools";
import { ToolHarness } from "./testHarness";
import { ToolExecutor } from "./toolExecutor";
import { resultText } from "./toolResult";

type Json = Record<string, unknown>;

function harness(): { h: ToolHarness; a: string; b: string; mediaId: string } {
  const h = new ToolHarness();
  const asset = h.addAsset({ type: "video", duration: 10 });
  const a = Fixtures.clip({ id: "clipA", start: 0, duration: 60, mediaRef: asset.id });
  const b = Fixtures.clip({ id: "clipB", start: 60, duration: 60, mediaRef: asset.id });
  h.editor.withoutRegistration(() => {
    h.tracks().push(Fixtures.videoTrack({ clips: [a, b] }));
  });
  return { h, a: a.id, b: b.id, mediaId: asset.id };
}

const firstClip = (payload: Json): Json => (payload.clips as Json[])[0] as Json;
const stack = (h: ToolHarness, id: string): string[] => (h.editor.clipFor(id)?.effects ?? []).map((e) => e.type);

describe("apply_color", () => {
  it("applyColorEchoesGradeAndRoundTrips", async () => {
    const { h, a, b } = harness();
    const graded = await h.runOK("apply_color", { clipIds: [a], exposure: 0.4, temperature: 7200, masterCurve: [[0, 0.05], [1, 0.95]] });
    const color = firstClip(graded).color as Json;
    expect(color.exposure).toBe(0.4);
    expect(color.temperature).toBe(7200);
    expect((color.masterCurve as number[][]).length).toBe(2);
    // color.* effects live in `color`, not `effects`.
    expect(firstClip(graded).effects).toBeUndefined();

    const pasted = await h.runOK("apply_color", { clipIds: [b], color });
    const bColor = firstClip(pasted).color as Json;
    expect(bColor.exposure).toBe(0.4);
    expect(bColor.temperature).toBe(7200);

    const mixed = await h.runRaw("apply_color", { clipIds: [b], color, exposure: 1 });
    expect(mixed.isError).toBe(true);

    // Touching one wheel doesn't leak the other zones' neutral values into the echo.
    const wheels = await h.runOK("apply_color", { clipIds: [a], shadowsHue: 180, shadowsAmount: 0.12 });
    const wColor = firstClip(wheels).color as Json;
    expect(wColor.shadowsHue).toBe(180);
    expect(wColor.shadowsAmount).toBe(0.12);
    expect(wColor.midsGamma).toBeUndefined();
    expect(wColor.highsGain).toBeUndefined();
    expect(wColor.midsHue).toBeUndefined();
    // The earlier knobs were merged, not replaced.
    expect(wColor.exposure).toBe(0.4);
  });

  it("reset starts from neutral, keeps non-color effects and orders the stack canonically", async () => {
    const { h, a } = harness();
    h.editor.withoutRegistration(() => {
      const clip = h.editor.clipFor(a) as Clip;
      clip.effects = [makeEffect({ type: "blur.gaussian", params: { radius: makeEffectParam({ value: 5 }) } })];
    });
    await h.runOK("apply_color", { clipIds: [a], saturation: 1.2, exposure: 0.1, tint: 5 });
    expect(stack(h, a)).toEqual(["blur.gaussian", "color.exposure", "color.temperature", "color.saturation"]);
    await h.runOK("apply_color", { clipIds: [a], reset: true, contrast: 1.1 });
    expect(stack(h, a)).toEqual(["blur.gaussian", "color.contrast"]);
  });

  it("compiles hueCurves targets one-way and reads them back raw", async () => {
    const { h, a, b } = harness();
    const res = await h.runOK("apply_color", { clipIds: [a], hueCurves: { targets: [{ targetHue: 120, satScale: 0.5, hueShift: 10 }] } });
    const color = firstClip(res).color as { hueCurvesRaw: { hueVsHue: number[][]; hueVsSat: number[][]; hueVsLum?: unknown } };
    expect(color.hueCurvesRaw.hueVsLum).toBeUndefined();
    expect(color.hueCurvesRaw.hueVsHue.map((p) => p[0])).toEqual([0.273, 0.333, 0.393]);
    expect(color.hueCurvesRaw.hueVsHue[1]?.[1]).toBeCloseTo(0.5 + 10 / 60, 3);
    expect(color.hueCurvesRaw.hueVsSat[1]?.[1]).toBeCloseTo(0.25, 3);
    // The raw hue curves paste onto another clip.
    await h.runOK("apply_color", { clipIds: [b], color });
    expect(stack(h, b)).toEqual(["color.hueCurves"]);
  });

  it("keeps bypassed color effects disabled and validates input", async () => {
    const { h, a } = harness();
    await h.runOK("apply_color", { clipIds: [a], exposure: 0.5 });
    h.editor.withoutRegistration(() => {
      const e = h.editor.clipFor(a)?.effects?.[0];
      if (e) e.enabled = false;
    });
    await h.runOK("apply_color", { clipIds: [a], exposure: 0.7 });
    expect(h.editor.clipFor(a)?.effects?.[0]?.enabled).toBe(false);

    for (const bad of [{ clipIds: [] }, { clipIds: [a] }, { clipIds: ["nope"], exposure: 1 }, { clipIds: [a], bogus: 1 }, { clipIds: [a], masterCurve: [["x"]] }]) {
      expect((await h.runRaw("apply_color", bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(resultText(await h.runRaw("apply_color", { clipIds: [a] }))).toBe("No grade parameters provided.");
    expect(resultText(await h.runRaw("apply_color", { clipIds: [a], color: { bogus: 1 } }))).toContain("apply_color.color: unknown field(s) 'bogus'");
  });

  it("stores a LUT through the inspector service and clamps its strength", async () => {
    const { h, a } = harness();
    expect((await h.runRaw("apply_color", { clipIds: [a], lut: { path: "C:/x.cube" } })).isError).toBe(true);
    inspectorServices.storeLut = async (p) => {
      if (p.endsWith("bad.cube")) throw new Error("Not a valid .cube 3D LUT: bad.cube");
      return `stored/${p}`;
    };
    try {
      const res = await h.runOK("apply_color", { clipIds: [a], lut: { path: "C:/film.cube", strength: 3 } });
      expect((firstClip(res).color as Json).lut).toEqual({ path: "stored/C:/film.cube", strength: 1 });
      const bad = await h.runRaw("apply_color", { clipIds: [a], lut: { path: "C:/bad.cube" } });
      expect(resultText(bad)).toBe("Not a valid .cube 3D LUT: bad.cube");
      const reblend = await h.runOK("apply_color", { clipIds: [a], lut: { strength: 0.25 } });
      expect((firstClip(reblend).color as Json).lut).toEqual({ path: "stored/C:/film.cube", strength: 0.25 });
    } finally {
      delete inspectorServices.storeLut;
    }
  });

  it("colorObject is undefined without color effects", () => {
    expect(colorObject(undefined)).toBeUndefined();
    expect(colorObject([makeEffect({ type: "blur.gaussian" })])).toBeUndefined();
  });

  it("get_timeline reports the grade", async () => {
    const { h, a } = harness();
    await h.runOK("apply_color", { clipIds: [a], exposure: 0.4 });
    const tl = await h.runOK("get_timeline");
    const clips = (tl.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
    expect((clips.find((c) => c.id === a)?.color as Json).exposure).toBe(0.4);
  });
});

describe("apply_effect", () => {
  it("applyEffectEchoesCleanEffectShape", async () => {
    const { h, a } = harness();
    const json = await h.runOK("apply_effect", { clipIds: [a], effects: [{ type: "blur.gaussian", params: { radius: 12 } }] });
    const fx = (firstClip(json).effects as Json[])[0] as Json;
    expect(fx.type).toBe("blur.gaussian");
    expect((fx.params as Json).radius).toBe(12);
    expect(fx.id).toBeUndefined();
    expect(fx.enabled).toBeUndefined();
  });

  it("merges, clamps, bypasses, removes and clears blur keyframes", async () => {
    const { h, a, b } = harness();
    await h.runOK("apply_effect", { clipIds: [a, b], effects: [{ type: "stylize.glow", params: { intensity: 5 } }, { type: "blur.sharpen", enabled: false }] });
    expect(stack(h, a)).toEqual(["blur.sharpen", "stylize.glow"]);
    const glow = h.editor.clipFor(a)?.effects?.find((e) => e.type === "stylize.glow");
    expect(glow?.params.intensity?.value).toBe(1);
    expect(glow?.params.radius?.value).toBe(20);
    expect(h.editor.clipFor(a)?.effects?.[0]?.enabled).toBe(false);

    h.editor.withoutRegistration(() => {
      const clip = h.editor.clipFor(b) as Clip;
      clip.effects = [makeEffect({ type: "blur.gaussian", params: { radius: makeEffectParam({ value: 4, track: makeKeyframeTrack([makeKeyframe(0, 1), makeKeyframe(10, 9)]) }) } })];
    });
    const res = await h.runOK("apply_effect", { clipIds: [b], effects: [{ type: "blur.gaussian", params: { radius: 7.12349 } }], remove: ["stylize.glow"] });
    expect(res.notes).toEqual([`Static blur cleared existing blur keyframes on: ${b}.`]);
    expect(h.editor.clipFor(b)?.effects?.[0]?.params.radius).toEqual({ value: 7.123 });

    await h.runOK("apply_effect", { clipIds: [a], remove: ["stylize.glow", "blur.sharpen"] });
    expect(h.editor.clipFor(a)?.effects).toBeUndefined();
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(stack(h, a)).toEqual(["blur.sharpen", "stylize.glow"]);
  });

  it("rejects bad input without mutating", async () => {
    const { h, a } = harness();
    const cases: [Json, string][] = [
      [{ clipIds: [] }, "clipIds is empty."],
      [{ clipIds: [a] }, "Provide effects to add/update or remove types to delete."],
      [{ clipIds: [a], effects: [{ type: "nope.x" }] }, "Unknown effect 'nope.x'. See the apply_effect description for available types."],
      [{ clipIds: [a], effects: [{ type: "color.exposure" }] }, "'color.exposure' is a color grade — use apply_color, not apply_effect."],
      [{ clipIds: [a], effects: [{ type: "blur.motion", params: { zzz: 1, aaa: 2 } }] }, "blur.motion: unknown param(s) 'aaa', 'zzz'. Allowed: angle, radius."],
      [{ clipIds: ["ghost"], remove: ["blur.gaussian"] }, "Clip not found: ghost"],
      [{ clipIds: [a], effects: [{ params: {} }] }, "apply_effect.effects[0]: missing required field 'type'"],
    ];
    for (const [args, message] of cases) expect(resultText(await h.runRaw("apply_effect", args))).toBe(message);
    expect(h.editor.clipFor(a)?.effects).toBeUndefined();
  });
});

describe("inspect_color", () => {
  function sessionExecutor(h: ToolHarness, render: (frame: number) => Promise<string | null>): ToolExecutor {
    return ToolExecutor.forSession({
      currentEditor: () => h.editor,
      listProjects: async () => [],
      openProject: async () => h.editor,
      createProject: async () => h.editor,
      closeProject: async () => {},
      displayName: () => "Test",
      renderTimelineFrame: async (_editor, frame) => render(frame),
    });
  }

  const flat = (n: number, value: number): Uint8ClampedArray => new Uint8ClampedArray(Array.from({ length: n * n * 4 }, (_, i) => (i % 4 === 3 ? 255 : value)));

  it("fails like Swift when no frame can be rendered", async () => {
    const { h, a } = harness();
    expect(resultText(await h.runRaw("inspect_color", { clipId: a }))).toBe(`Could not decode a frame for clip ${a}.`);
    expect(resultText(await h.runRaw("inspect_color", {}))).toBe("Provide either clipId (measures the graded clip) or mediaRef (measures the raw asset).");
    expect(resultText(await h.runRaw("inspect_color", { clipId: "ghost" }))).toBe("Clip not found: ghost");
    expect(resultText(await h.runRaw("inspect_color", { mediaRef: "ghost" }))).toBe("Media not found: ghost");
  });

  it("measures the rendered clip frame at the midpoint (or atFrame) and the reference gap", async () => {
    const { h, a } = harness();
    const asset = h.addAsset({ type: "image" });
    const original = { ...colorFrameIO };
    const sampled: number[] = [];
    colorFrameIO.gridFromJpeg = async (_b64, n) => flat(n, 200);
    colorFrameIO.rawAssetFrame = async (_asset, n) => ({ rgba: flat(n, 100), jpegBase64: "UkVG" });
    try {
      const executor = sessionExecutor(h, async (frame) => {
        sampled.push(frame);
        return "SlBFRw==";
      });
      const res = await executor.execute("inspect_color", { clipId: a, reference: asset.id });
      expect(res.isError, resultText(res)).toBe(false);
      expect(sampled).toEqual([30]);
      expect(res.content.map((c) => c.kind)).toEqual(["image", "image", "text"]);
      const payload = JSON.parse(resultText(res)) as { clip: { luma: { mean: number } }; reference: { luma: { mean: number } }; gap: { lumaMean: number } };
      expect(payload.clip.luma.mean).toBeCloseTo(0.784, 2);
      expect(payload.reference.luma.mean).toBeCloseTo(0.392, 2);
      expect(payload.gap.lumaMean).toBeCloseTo(0.392, 2);

      await executor.execute("inspect_color", { clipId: a, atFrame: 500 });
      await executor.execute("inspect_color", { clipId: a, atFrame: 10 });
      expect(sampled.slice(1)).toEqual([59, 10]);

      const media = await executor.execute("inspect_color", { mediaRef: asset.id });
      expect(Object.keys(JSON.parse(resultText(media)) as Json)).toEqual(["media"]);
    } finally {
      Object.assign(colorFrameIO, original);
    }
  });
});
