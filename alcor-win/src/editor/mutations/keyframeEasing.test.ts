import { describe, expect, it } from "vitest";
import { clipHasSpeedRamp, makeKeyframe, makeKeyframeTrack, makeAnimPair } from "../../model";
import { applySpeedRampPreset, setFrameBlending, setSpeedRampPoints } from "./speedRamp";
import { commitClipSpeed } from "./clipMutations";
import { easyEaseSelectedKeyframes, selectedKeyframeRefs, setInterpolation, setInterpolations } from "./keyframes";
import { Fixtures, clipById, makeEditor } from "./testFixtures";

function editorWithKeyframes() {
  const clip = Fixtures.clip({ id: "c1", start: 10, duration: 60 });
  clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0), makeKeyframe(30, 1), makeKeyframe(59, 0)]);
  clip.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0, 0)), makeKeyframe(30, makeAnimPair(0.5, 0.5))]);
  const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
  e.ui.selectedClipIds = new Set(["c1"]);
  return e;
}

describe("keyframe easing mutations", () => {
  it("setInterpolation stores a custom curve as one undo entry", () => {
    const e = editorWithKeyframes();
    setInterpolation(e, "c1", "opacity", 40, "bezier", [0.1, 0.2, 0.3, 1.4]);
    const kf = clipById(e, "c1").opacityTrack?.keyframes[1];
    expect(kf?.interpolationOut).toBe("bezier");
    expect(kf?.bezier).toEqual([0.1, 0.2, 0.3, 1.4]);
    e.undo();
    expect(clipById(e, "c1").opacityTrack?.keyframes[1]?.interpolationOut).toBe("smooth");
    expect(clipById(e, "c1").opacityTrack?.keyframes[1]?.bezier).toBeUndefined();
  });

  it("switching away from a custom curve drops the handles", () => {
    const e = editorWithKeyframes();
    setInterpolation(e, "c1", "opacity", 40, "bezier", [0.1, 0.2, 0.3, 1.4]);
    setInterpolation(e, "c1", "opacity", 40, "easeIn");
    const kf = clipById(e, "c1").opacityTrack?.keyframes[1];
    expect(kf?.interpolationOut).toBe("easeIn");
    expect("bezier" in (kf ?? {})).toBe(false);
  });

  it("setInterpolations eases several keyframes across properties in one undo entry", () => {
    const e = editorWithKeyframes();
    setInterpolations(e, [
      { clipId: "c1", property: "opacity", frame: 10 },
      { clipId: "c1", property: "position", frame: 10 },
    ], "easeOut");
    expect(clipById(e, "c1").opacityTrack?.keyframes[0]?.interpolationOut).toBe("easeOut");
    expect(clipById(e, "c1").positionTrack?.keyframes[0]?.interpolationOut).toBe("easeOut");
    e.undo();
    expect(clipById(e, "c1").opacityTrack?.keyframes[0]?.interpolationOut).toBe("smooth");
    expect(clipById(e, "c1").positionTrack?.keyframes[0]?.interpolationOut).toBe("smooth");
    expect(e.store.canUndo).toBe(false);
  });

  it("F9 eases the keyframes at the playhead, else all keyframes of the selected clips", () => {
    const e = editorWithKeyframes();
    e.ui.currentFrame = 40;
    expect(selectedKeyframeRefs(e).map((r) => r.property).sort()).toEqual(["opacity", "position"]);
    expect(easyEaseSelectedKeyframes(e)).toBe(true);
    expect(clipById(e, "c1").opacityTrack?.keyframes.map((k) => k.interpolationOut)).toEqual(["smooth", "easeInOut", "smooth"]);
    e.undo();
    e.ui.currentFrame = 12;
    expect(selectedKeyframeRefs(e)).toHaveLength(5);
    easyEaseSelectedKeyframes(e);
    expect(clipById(e, "c1").opacityTrack?.keyframes.every((k) => k.interpolationOut === "easeInOut")).toBe(true);
    e.ui.selectedClipIds = new Set();
    expect(easyEaseSelectedKeyframes(e)).toBe(false);
  });
});

describe("speed ramp mutations", () => {
  const rampEditor = () => {
    const clip = Fixtures.clip({ id: "v", start: 0, duration: 120, trimStart: 30, trimEnd: 0 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    return e;
  };

  it("a preset is one undo entry and keeps length, mean speed and source range", () => {
    const e = rampEditor();
    expect(applySpeedRampPreset(e, ["v"], "hero")).toEqual(["v"]);
    const c = clipById(e, "v");
    expect(clipHasSpeedRamp(c)).toBe(true);
    expect(c.durationFrames).toBe(120);
    expect(c.speed).toBeCloseTo(1, 1);
    e.undo();
    expect(clipHasSpeedRamp(clipById(e, "v"))).toBe(false);
    expect(e.store.canUndo).toBe(false);
  });

  it("removing the ramp keeps the mean speed", () => {
    const e = rampEditor();
    applySpeedRampPreset(e, ["v"], "montage");
    const mean = clipById(e, "v").speed;
    applySpeedRampPreset(e, ["v"], undefined);
    expect(clipHasSpeedRamp(clipById(e, "v"))).toBe(false);
    expect(clipById(e, "v").speed).toBe(mean);
  });

  it("unknown presets change nothing", () => {
    const e = rampEditor();
    expect(applySpeedRampPreset(e, ["v"], "nope")).toEqual([]);
    expect(e.store.canUndo).toBe(false);
  });

  it("explicit keyframes and frame blending", () => {
    const e = rampEditor();
    setSpeedRampPoints(e, ["v"], [{ frame: 0, speed: 0.5 }, { frame: 119, speed: 2, interpolation: "linear" }]);
    expect(clipById(e, "v").speedTrack?.keyframes).toHaveLength(2);
    setFrameBlending(e, ["v"], true);
    expect(clipById(e, "v").frameBlending).toBe(true);
    setFrameBlending(e, ["v"], false);
    expect("frameBlending" in clipById(e, "v")).toBe(false);
  });

  it("a constant speed change rescales the ramp with the clip", () => {
    const e = rampEditor();
    applySpeedRampPreset(e, ["v"], "smoothSlowMo");
    const before = clipById(e, "v").speedTrack?.keyframes.map((k) => k.value) ?? [];
    commitClipSpeed(e, ["v"], 2);
    const c = clipById(e, "v");
    expect(c.durationFrames).toBe(60);
    const after = c.speedTrack?.keyframes.map((k) => k.value) ?? [];
    expect(after[1]).toBeCloseTo((before[1] ?? 0) * 2, 6);
    expect(Math.max(...(c.speedTrack?.keyframes.map((k) => k.frame) ?? []))).toBeLessThan(60);
  });
});
