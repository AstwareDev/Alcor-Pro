import { describe, expect, it } from "vitest";
import { makeClip, makeEffect, makeEffectParam, makeStaticEffect, makeTextStyle, makeTextAnimation, type Clip } from "../../model";
import type { EffectPreset, LookPreset, TextAnimationPreset, TextStylePreset, TitlePreset } from "../../library/presetFormat";
import { fakeMeasure } from "../../captions/testSupport";
import {
  applyEffectPreset, applyTextAnimationPreset, applyTextStylePreset, beginEffectPresetPreview, buildPresetEffects,
  placeTitlePreset, removeLookFromClips,
} from "./presets";
import { Fixtures, makeEditor, clipById } from "./testFixtures";

const base = { id: "p", name: "Preset", category: "c", tags: [] };
const look = (effects: LookPreset["effects"]): LookPreset => ({ ...base, kind: "look", effects });
const fx = (effects: EffectPreset["effects"]): EffectPreset => ({ ...base, kind: "effect", effects });

function textClip(id: string, start = 0): Clip {
  return makeClip({
    id, mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: start, durationFrames: 60, textContent: "Hello",
    textStyle: makeTextStyle({ fontSize: 120 }),
  });
}

function setup() {
  const a = Fixtures.clip({ id: "a", start: 0, duration: 60 });
  const b = Fixtures.clip({ id: "b", start: 60, duration: 60 });
  a.effects = [makeStaticEffect("color.contrast", { amount: 1.3 }), makeStaticEffect("blur.gaussian", { radius: 5 })];
  const audio = Fixtures.clip({ id: "au", start: 0, duration: 60, mediaType: "audio" });
  const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] }), Fixtures.audioTrack({ clips: [audio] })]);
  return e;
}

describe("applyEffectPreset (look = replace)", () => {
  it("replaces look-managed effects, keeps others, in one undo entry", () => {
    const e = setup();
    const result = applyEffectPreset(e, new Set(["a"]), look([
      { type: "color.saturation", params: { amount: 0.8 } }, { type: "stylize.vignette", params: { amount: -0.4 } },
    ]));
    expect(result.clipIds).toEqual(["a"]);
    expect(clipById(e, "a").effects?.map((x) => x.type)).toEqual(["color.saturation", "blur.gaussian", "stylize.vignette"]);
    expect(e.undo()).toBe("Apply Preset");
    expect(clipById(e, "a").effects?.map((x) => x.type)).toEqual(["color.contrast", "blur.gaussian"]);
    expect(clipById(e, "a").effects?.[0].params["amount"]?.value).toBe(1.3);
  });

  it("applies to several clips atomically with a single undo, skipping audio clips", () => {
    const e = setup();
    const r = applyEffectPreset(e, new Set(["a", "b", "au"]), look([{ type: "color.saturation", params: { amount: 1.4 } }]));
    expect(r.clipIds.sort()).toEqual(["a", "b"]);
    expect(clipById(e, "b").effects).toHaveLength(1);
    expect(clipById(e, "au").effects).toBeUndefined();
    e.undo();
    expect(clipById(e, "b").effects).toBeUndefined();
    expect(clipById(e, "a").effects).toHaveLength(2);
    expect(e.undo()).toBeNull();
  });

  it("clamps params and warns on unknown effects / params without throwing", () => {
    const { effects, warnings } = buildPresetEffects([
      { type: "color.saturation", params: { amount: 9, bogus: 1 } }, { type: "nope.effect", params: {} },
    ]);
    expect(effects).toHaveLength(1);
    expect(effects[0].params["amount"]?.value).toBe(2);
    expect(warnings.join("\n")).toContain('unknown effect "nope.effect"');
    expect(warnings.join("\n")).toContain("color.saturation.bogus");
  });

  it("a preset with only unknown effects changes nothing and records nothing", () => {
    const e = setup();
    const r = applyEffectPreset(e, new Set(["a"]), look([{ type: "nope", params: {} }]));
    expect(r.clipIds).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(e.undo()).toBeNull();
  });

  it("skips a LUT effect whose file is not installed", () => {
    const e = setup();
    const lut = look([{ type: "color.lut", params: { intensity: 0.8 }, resource: "pack/a.cube" }, { type: "color.saturation", params: { amount: 1.1 } }]);
    const r = applyEffectPreset(e, new Set(["b"]), lut, { resolveResource: () => undefined });
    expect(clipById(e, "b").effects?.map((x) => x.type)).toEqual(["color.saturation"]);
    expect(r.warnings[0]).toContain("not installed");
    const ok = applyEffectPreset(e, new Set(["b"]), lut, { resolveResource: (res) => `C:/lib/${res}` });
    expect(ok.warnings).toEqual([]);
    expect(clipById(e, "b").effects?.find((x) => x.type === "color.lut")?.params["path"]?.string).toBe("C:/lib/pack/a.cube");
  });
});

describe("applyEffectPreset (effect = add)", () => {
  it("adds in canonical order and updates same-type effects without touching the rest", () => {
    const e = setup();
    applyEffectPreset(e, new Set(["a"]), fx([{ type: "blur.gaussian", params: { radius: 20 } }, { type: "stylize.glow", params: { intensity: 0.5 } }]));
    const types = clipById(e, "a").effects?.map((x) => x.type);
    expect(types).toEqual(["color.contrast", "blur.gaussian", "stylize.glow"]);
    expect(clipById(e, "a").effects?.[1].params["radius"]?.value).toBe(20);
  });
});

describe("removeLookFromClips", () => {
  it("removes only look-managed effects", () => {
    const e = setup();
    expect(removeLookFromClips(e, new Set(["a", "b"]))).toEqual(["a"]);
    expect(clipById(e, "a").effects?.map((x) => x.type)).toEqual(["blur.gaussian"]);
    e.undo();
    expect(clipById(e, "a").effects).toHaveLength(2);
  });
});

describe("beginEffectPresetPreview", () => {
  it("applies temporarily with no undo entry and restores on revert", () => {
    const e = setup();
    const revert = beginEffectPresetPreview(e, new Set(["a", "b"]), look([{ type: "color.saturation", params: { amount: 0.1 } }]));
    expect(clipById(e, "a").effects?.some((x) => x.type === "color.saturation")).toBe(true);
    expect(clipById(e, "b").effects).toHaveLength(1);
    revert();
    revert();
    expect(clipById(e, "a").effects?.map((x) => x.type)).toEqual(["color.contrast", "blur.gaussian"]);
    expect(clipById(e, "b").effects).toBeUndefined();
    expect(e.undo()).toBeNull();
  });
});

describe("text presets", () => {
  const style: TextStylePreset = {
    ...base, kind: "textStyle", fillMode: "footage",
    style: makeTextStyle({ fontName: "Impact", fontSize: 40, isBold: true }),
  };

  it("applies a text style to text clips only, keeping font size, undoable as one entry", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [textClip("t1"), textClip("t2", 60), Fixtures.clip({ id: "v", start: 120, duration: 30 })] })]);
    const r = applyTextStylePreset(e, new Set(["t1", "t2", "v"]), style, { measure: fakeMeasure });
    expect(r.clipIds.sort()).toEqual(["t1", "t2"]);
    expect(clipById(e, "t1").textStyle?.fontName).toBe("Impact");
    expect(clipById(e, "t1").textStyle?.fontSize).toBe(120);
    expect(clipById(e, "t2").textFillMode).toBe("footage");
    expect(clipById(e, "v").textStyle).toBeUndefined();
    e.undo();
    expect(clipById(e, "t1").textStyle?.fontName).toBe("Helvetica");
    expect(clipById(e, "t2").textFillMode).toBeUndefined();
    expect(e.undo()).toBeNull();
  });

  it("applies and clears animations", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [textClip("t1")] })]);
    const anim: TextAnimationPreset = { ...base, kind: "textAnimation", animation: makeTextAnimation({ preset: "popIn" }) };
    applyTextAnimationPreset(e, new Set(["t1"]), anim);
    expect(clipById(e, "t1").textAnimation?.preset).toBe("popIn");
    applyTextAnimationPreset(e, new Set(["t1"]), { ...anim, animation: makeTextAnimation({ preset: "none" }) });
    expect(clipById(e, "t1").textAnimation).toBeUndefined();
    e.undo();
    expect(clipById(e, "t1").textAnimation?.preset).toBe("popIn");
  });
});

describe("placeTitlePreset", () => {
  const title: TitlePreset = {
    ...base, kind: "title", durationSeconds: 3,
    items: [
      { text: "Big", style: makeTextStyle(), layer: 0, startOffsetSeconds: 0, animation: makeTextAnimation({ preset: "popIn" }), box: { centerX: 0.5, centerY: 0.4 } },
      { text: "Small", style: makeTextStyle(), layer: 1, startOffsetSeconds: 0.5, durationSeconds: 1 },
    ],
  };

  it("places clips at the playhead on new tracks above the timeline as one undo entry", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "v", start: 0, duration: 300 })] })]);
    e.ui.currentFrame = 45;
    const r = placeTitlePreset(e, title, { measure: fakeMeasure });
    expect(r.clipIds).toHaveLength(2);
    expect(e.timeline.tracks).toHaveLength(3);
    const [big, small] = [e.timeline.tracks[0].clips[0], e.timeline.tracks[1].clips[0]];
    expect(big.textContent).toBe("Big");
    expect(big.startFrame).toBe(45);
    expect(big.durationFrames).toBe(90);
    expect(big.transform.centerY).toBe(0.4);
    expect(big.textAnimation?.preset).toBe("popIn");
    expect(small.startFrame).toBe(60);
    expect(small.durationFrames).toBe(30);
    expect(e.ui.selectedClipIds).toEqual(new Set(r.clipIds));
    expect(e.undo()).toBe("Add Preset");
    expect(e.timeline.tracks).toHaveLength(1);
    expect(e.timeline.tracks[0].clips[0].id).toBe("v");
  });
});

describe("makeEffect param helpers", () => {
  it("keeps untouched params at their defaults", () => {
    const { effects } = buildPresetEffects([{ type: "stylize.vignette", params: { amount: -0.5 } }]);
    expect(effects[0].params["midpoint"]).toEqual(makeEffectParam({ value: 0.5 }));
    expect(makeEffect({ type: "x" }).enabled).toBe(true);
  });
});
