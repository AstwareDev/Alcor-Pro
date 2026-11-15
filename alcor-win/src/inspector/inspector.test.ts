import { describe, expect, it } from "vitest";
import { makeEffect, makeEffectParam, makeGradeCurve } from "../model";
import { Fixtures, clipById, makeEditor } from "../editor/mutations/testFixtures";
import { grabPoint, movePoint, nearestIndex, pointsToStore, removeNearestPoint } from "./curveEditing";
import { readGradeCurve, setDenoise, setInvert, upsertControl, upsertCurve } from "./effectEdit";
import {
  activeTab, adjustSectionState, aspectDisplayLabel, availableTabs, formatDuration, inspectorClipCount,
  preferredTabAfterSelection, qualityResolution, resolutionForAspectText, resolveInspectorSelection,
} from "./inspectorLogic";

describe("InspectorClipSelection", () => {
  it("resolvesSelectedClipsByInspectorCategory", () => {
    const text = Fixtures.clip({ id: "text", mediaType: "text", start: 0, duration: 30 });
    const video = Fixtures.clip({ id: "video", mediaType: "video", start: 30, duration: 30 });
    const audio = Fixtures.clip({ id: "audio", mediaType: "audio", start: 0, duration: 60 });
    const other = Fixtures.clip({ id: "other", mediaType: "text", start: 60, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [text, video, other] }), Fixtures.audioTrack({ clips: [audio] })]);
    const s = resolveInspectorSelection(e.timeline, new Set(["text", "video", "audio"]));
    expect(s.textClips.map((c) => c.id)).toEqual(["text"]);
    expect(s.nonTextVisualClips.map((c) => c.id)).toEqual(["video"]);
    expect(s.audioClips.map((c) => c.id)).toEqual(["audio"]);
    expect(s.firstVisualClip?.id).toBe("text");
    expect(inspectorClipCount(s)).toBe(3);
  });

  it("largeCaptionSelectionResolvesWithinInteractionBudget", () => {
    const clips = Array.from({ length: 10_000 }, (_, i) => Fixtures.clip({ id: `c${i}`, mediaType: "text", start: i * 30, duration: 30 }));
    const e = makeEditor([Fixtures.videoTrack({ clips })]);
    const t0 = performance.now();
    const s = resolveInspectorSelection(e.timeline, new Set(clips.map((c) => c.id)));
    expect(s.textClips.length).toBe(10_000);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("decidesTabsPerClipType", () => {
    const mk = (types: ("text" | "video" | "audio")[]) => {
      const clips = types.map((t, i) => Fixtures.clip({ id: `${t}${i}`, mediaType: t, start: i * 10, duration: 10 }));
      const e = makeEditor([Fixtures.videoTrack({ clips: clips.filter((c) => c.mediaType !== "audio") }), Fixtures.audioTrack({ clips: clips.filter((c) => c.mediaType === "audio") })]);
      return availableTabs(resolveInspectorSelection(e.timeline, new Set(clips.map((c) => c.id))));
    };
    expect(mk(["text"])).toEqual(["text", "textAnimate"]);
    expect(mk(["video"])).toEqual(["video", "effects"]);
    expect(mk(["video", "audio"])).toEqual(["video", "effects", "audio"]);
    expect(mk(["text", "video"])).toEqual(["video", "effects"]);
    expect(activeTab(["video", "effects"], "audio")).toBe("video");
    expect(preferredTabAfterSelection(["text"], "video")).toBe("text");
    expect(preferredTabAfterSelection(["video"], "text")).toBe("video");
  });
});

describe("AdjustSectionState", () => {
  const ids = new Set(["blur.gaussian", "key.chroma", "stylize.invert"]);
  const state = (effects: ReturnType<typeof makeEffect>[], sampling = false) => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    clip.effects = effects;
    return adjustSectionState(ids, [clip], sampling ? "clip" : null);
  };
  it("sectionInteractionDistinguishesBypassMixedAndSamplingStates", () => {
    expect(state([makeEffect({ type: "blur.gaussian", enabled: false })]).isEnabled).toBe(false);
    expect(state([makeEffect({ type: "blur.gaussian", enabled: false }), makeEffect({ type: "stylize.invert" })]).isEnabled).toBe(true);
    expect(state([makeEffect({ type: "key.chroma", enabled: false })], true).isEnabled).toBe(true);
  });
});

describe("project settings presets", () => {
  it("computesResolutionFromAspectText", () => {
    expect(resolutionForAspectText("3:2", 1080)).toEqual({ ok: true, value: { width: 1620, height: 1080 } });
    expect(resolutionForAspectText("9:16", 1080)).toEqual({ ok: true, value: { width: 1080, height: 1920 } });
    expect(resolutionForAspectText("abc", 1080)).toEqual({ ok: false, code: "invalidFormat" });
    expect(resolutionForAspectText("100:1", 1080)).toEqual({ ok: false, code: "resolutionTooLarge" });
    expect(resolutionForAspectText("1:1", 1)).toEqual({ ok: false, code: "resolutionTooSmall" });
  });
  it("labelsAspectAndQuality", () => {
    expect(aspectDisplayLabel(1920, 1080)).toBe("16:9");
    expect(aspectDisplayLabel(2592, 1080)).toBe("12:5");
    expect(aspectDisplayLabel(0, 1)).toBe("—");
    expect(qualityResolution(2160, 1920, 1080)).toEqual({ width: 3840, height: 2160 });
    expect(qualityResolution(720, 1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(65)).toBe("1:05");
  });
});

describe("effect edits", () => {
  it("insertsInCanonicalOrderAndPrunesWhenAllDefault", () => {
    const effects = [makeEffect({ type: "blur.gaussian", params: { radius: makeEffectParam({ value: 8 }) } })];
    upsertControl(effects, "color.exposure", "ev", 1);
    expect(effects.map((e) => e.type)).toEqual(["color.exposure", "blur.gaussian"]);
    upsertControl(effects, "color.exposure", "ev", 0);
    expect(effects.map((e) => e.type)).toEqual(["blur.gaussian"]);
    upsertControl(effects, "color.contrast", "amount", 1);
    expect(effects.length).toBe(1);
  });
  it("storesAndClearsCurves", () => {
    const effects: ReturnType<typeof makeEffect>[] = [];
    upsertCurve(effects, makeGradeCurve({ master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }] }));
    expect(readGradeCurve(effects).master.length).toBe(3);
    upsertCurve(effects, makeGradeCurve());
    expect(effects.length).toBe(0);
  });
  it("togglesInvert", () => {
    const effects: ReturnType<typeof makeEffect>[] = [];
    setInvert(effects, true);
    expect(effects[0]?.type).toBe("stylize.invert");
    setInvert(effects, false);
    expect(effects.length).toBe(0);
  });
  it("denoiseEnablesAndUndoesAsOneAction", () => {
    const e = makeEditor([Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 30 })] })]);
    setDenoise(e, new Set(["a"]), true, undefined, "Enable Denoise");
    expect(clipById(e, "a").effects?.[0]?.params["amount"]?.value).toBe(0.6);
    setDenoise(e, new Set(["a"]), true, 2, "Change Denoise Strength");
    expect(clipById(e, "a").effects?.[0]?.params["amount"]?.value).toBe(1);
    e.undo();
    expect(clipById(e, "a").effects?.[0]?.params["amount"]?.value).toBe(0.6);
  });
});

describe("curve point editing", () => {
  const size = { width: 100, height: 100 };
  const identity = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  it("addsPointWhenNothingNearAndGrabsExisting", () => {
    const added = grabPoint(identity, 50, 50, size);
    expect(added.points.length).toBe(3);
    expect(added.points[added.index]).toEqual({ x: 0.5, y: 0.5 });
    const grabbed = grabPoint(added.points, 52, 52, size);
    expect(grabbed.points.length).toBe(3);
    expect(grabbed.index).toBe(1);
    expect(nearestIndex(0, 100, identity, size)).toBe(0);
  });
  it("endpointsMoveVerticallyInteriorStaysBetweenNeighbours", () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(movePoint(pts, 0, 30, 20, size)[0]).toEqual({ x: 0, y: 0.8 });
    expect(movePoint(pts, 1, 200, 20, size)[1]).toEqual({ x: 0.999, y: 0.8 });
    expect(movePoint(pts, 1, -50, 100, size)[1]).toEqual({ x: 0.001, y: 0 });
  });
  it("removesOnlyInteriorPointsAndKeepsTwo", () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(removeNearestPoint(pts, 50, 50, size)?.length).toBe(2);
    expect(removeNearestPoint(pts, 0, 100, size)).toBeUndefined();
    expect(removeNearestPoint(identity, 0, 100, size)).toBeUndefined();
  });
  it("storesIdentityAsEmpty", () => {
    expect(pointsToStore(identity)).toEqual([]);
    expect(pointsToStore([{ x: 0, y: 0 }, { x: 1, y: 0.9 }]).length).toBe(2);
  });
});
