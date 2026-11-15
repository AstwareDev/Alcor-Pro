import { describe, expect, it } from "vitest";
import {
  clipTopLeftAt,
  clipRotationAt,
  makeAnimPair,
  makeCrop,
  makeKeyframe,
  makeKeyframeTrack,
  makeTextStyle,
  makeTransform,
} from "../../model";
import { commitClipProperty } from "./clipMutations";
import {
  applyOpacity,
  applyRotation,
  applyTextSize,
  commitOpacity,
  commitPositions,
  commitRotation,
  hasKeyframe,
  nextKeyframeFrame,
  previousKeyframeFrame,
  stampKeyframe,
  toggleKeyframe,
  applyCrop,
  commitCrop,
  commitVolume,
  commitScalarProperty,
  applyVolume,
} from "./keyframes";
import { Fixtures, clipById, makeEditor } from "./testFixtures";

describe("EditorViewModel - stampKeyframe", () => {
  it("opacityStoresAuthoredValueNotFadedValue", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 100 });
    clip.opacity = 1.0;
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    stampKeyframe(e, "c1", "opacity", 5);
    const kf = e.timeline.tracks[0].clips[0].opacityTrack?.keyframes[0];
    expect(kf?.frame).toBe(5);
    expect(kf?.value).toBe(1.0);
  });

  it("refusesFramesOutsideTheClip", () => {
    const clip = Fixtures.clip({ id: "c1", start: 10, duration: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    stampKeyframe(e, "c1", "opacity", 5);
    expect(e.timeline.tracks[0].clips[0].opacityTrack).toBeUndefined();
    expect(e.store.canUndo).toBe(false);
  });

  it("navigatesBetweenKeyframes", () => {
    const clip = Fixtures.clip({ id: "c1", start: 10, duration: 40 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1), makeKeyframe(10, 0.5), makeKeyframe(30, 0)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    expect(previousKeyframeFrame(e, "c1", "opacity", 20)).toBe(10);
    expect(nextKeyframeFrame(e, "c1", "opacity", 20)).toBe(40);
    expect(nextKeyframeFrame(e, "c1", "opacity", 40)).toBeUndefined();
    expect(hasKeyframe(e, "c1", "opacity", 20)).toBe(true);
  });
});

describe("Timeline keyframe lanes - writes", () => {
  it("togglingExistingVolumeKeyframeRemovesIt", () => {
    const audio = Fixtures.clip({ id: "audio", mediaType: "audio", start: 10, duration: 30 });
    audio.volumeTrack = makeKeyframeTrack([makeKeyframe(5, -8, "linear")]);
    const e = makeEditor([Fixtures.audioTrack({ clips: [audio] })]);

    toggleKeyframe(e, audio.id, "volume", 15);

    expect(clipById(e, audio.id).volumeTrack).toBeUndefined();
    expect(e.store.canUndo).toBe(true);
    e.undo();
    expect(clipById(e, audio.id).volumeTrack).toEqual(audio.volumeTrack);
  });

  it("opacityWriteUpdatesTextKeyframeAtPlayhead", () => {
    const text = Fixtures.clip({ id: "text", mediaType: "text", start: 10, duration: 30 });
    text.opacity = 0.8;
    text.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.2)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [text] })]);
    e.ui.currentFrame = 20;

    applyOpacity(e, text.id, 0.6);

    const result = clipById(e, text.id);
    expect(result.opacity).toBe(0.8);
    expect(result.opacityTrack?.keyframes.find((k) => k.frame === 10)?.value).toBe(0.6);
  });

  it("sizeWriteKeepsTextScaleAnimation", () => {
    const text = Fixtures.clip({ id: "text", mediaType: "text", start: 0, duration: 30 });
    text.transform = makeTransform({ width: 0.2, height: 0.1 });
    text.textStyle = makeTextStyle();
    text.scaleTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0.2, 0.1))]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [text] })]);
    e.ui.currentFrame = 10;

    applyTextSize(e, text.id, 144);

    const keyframe = clipById(e, text.id).scaleTrack?.keyframes.find((k) => k.frame === 10);
    expect(Math.abs((keyframe?.value.a ?? 0) - 0.3)).toBeLessThan(0.000001);
    expect(Math.abs((keyframe?.value.b ?? 0) - 0.15)).toBeLessThan(0.000001);
  });

  it("animatedFieldEditUndoesAsOneAction", () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.2)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    e.ui.currentFrame = 10;

    applyOpacity(e, clip.id, 0.6);
    commitOpacity(e, clip.id, 0.6);

    expect(e.store.canUndo).toBe(true);
    e.undo();
    expect(clipById(e, clip.id).opacityTrack?.keyframes).toEqual([makeKeyframe(0, 0.2)]);
    expect(e.store.canUndo).toBe(false);
  });

  it("animatedFieldEditOutsideClipDoesNotCreateOutOfRangeKeyframe", () => {
    const clip = Fixtures.clip({ id: "clip", start: 10, duration: 20 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.2)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    e.ui.currentFrame = 0;

    applyOpacity(e, clip.id, 0.6);

    expect(clipById(e, clip.id)).toEqual(clip);
  });
});

describe("EditorViewModel - rotation mutation", () => {
  it("batchRotationCommitUndoesAllClipsTogether", () => {
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "first", start: 0, duration: 20 }), Fixtures.clip({ id: "second", start: 20, duration: 20 })] }),
    ]);

    applyRotation(e, ["first", "second"], 90);
    commitRotation(e, ["first", "second"], 90);

    expect(clipById(e, "first").transform.rotation).toBe(90);
    expect(clipById(e, "second").transform.rotation).toBe(90);
    expect(e.store.undoActionName).toBe("Change Rotation");
    e.undo();
    expect(clipById(e, "first").transform.rotation).toBe(0);
    expect(clipById(e, "second").transform.rotation).toBe(0);
    expect(e.store.canUndo).toBe(false);
  });

  it("batchRotationWritesActiveKeyframeTracks", () => {
    const staticClip = Fixtures.clip({ id: "static", start: 0, duration: 20 });
    const animated = Fixtures.clip({ id: "animated", start: 0, duration: 20 });
    animated.rotationTrack = makeKeyframeTrack([makeKeyframe(0, 0)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [staticClip] }), Fixtures.videoTrack({ clips: [animated] })]);
    e.ui.currentFrame = 10;

    applyRotation(e, ["static", "animated"], 45);
    commitRotation(e, ["static", "animated"], 45);

    expect(clipById(e, "static").transform.rotation).toBe(45);
    expect(clipById(e, "static").rotationTrack).toBeUndefined();
    expect(clipById(e, "animated").transform.rotation).toBe(0);
    expect(clipRotationAt(clipById(e, "animated"), 10)).toBe(45);
  });
});

describe("EditorViewModel - writePosition", () => {
  it("writePositionWithActiveKeyframesPreservesFallbackTransform", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.transform = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 });
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0.1, 0.1))]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    e.ui.currentFrame = 0;

    commitPositions(e, ["c1"], 0.4, 0.4);

    const updated = clipById(e, "c1");
    expect(updated.positionTrack?.keyframes.find((k) => k.frame === 0)?.value).toEqual(makeAnimPair(0.4, 0.4));
    expect(updated.transform.centerX).toBe(0.5);
    expect(updated.transform.centerY).toBe(0.5);
  });

  it("batchPositionUpdatesAllClips", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 60 });
    const b = Fixtures.clip({ id: "b", start: 10, duration: 60 });
    a.transform = makeTransform({ width: 0.2, height: 0.2 });
    b.transform = makeTransform({ width: 0.4, height: 0.4 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] })]);
    e.ui.currentFrame = 0;

    commitPositions(e, ["a", "b"], 0.3, 0.4);

    for (const id of ["a", "b"]) {
      const tl = clipTopLeftAt(clipById(e, id), 0);
      expect(Math.abs(tl.x - 0.3)).toBeLessThan(0.000001);
      expect(Math.abs(tl.y - 0.4)).toBeLessThan(0.000001);
    }
  });
});

describe("crop and volume writes", () => {
  it("cropLiveApplyThenCommitIsOneUndo", () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyCrop(e, "c", makeCrop({ left: 0.1 }));
    applyCrop(e, "c", makeCrop({ left: 0.2 }));
    expect(e.store.canUndo).toBe(false);
    commitCrop(e, "c", makeCrop({ left: 0.2 }));
    expect(clipById(e, "c").crop.left).toBe(0.2);
    e.undo();
    expect(clipById(e, "c").crop.left).toBe(0);
    expect(e.store.canUndo).toBe(false);
  });

  it("volumeWritesLinearGainWhenNotKeyframed", () => {
    const clip = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
    commitVolume(e, "a", 0);
    expect(clipById(e, "a").volume).toBe(1);
    commitVolume(e, "a", -60);
    expect(clipById(e, "a").volume).toBe(0);
  });

  it("commitClipPropertyIsStillAvailable", () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitClipProperty(e, "c", (c) => { c.opacity = 0.5; });
    expect(clipById(e, "c").opacity).toBe(0.5);
  });
});

describe("batch scalar commit", () => {
  it("liveApplyThenBatchCommitUndoesToThePreGestureState", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 30 });
    const b = Fixtures.clip({ id: "b", start: 30, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] })]);
    applyOpacity(e, "a", 0.5);
    applyOpacity(e, "b", 0.5);
    commitScalarProperty(e, ["a", "b"], "opacity", 0.5, "Change Opacity");
    expect(clipById(e, "a").opacity).toBe(0.5);
    e.undo();
    expect(clipById(e, "a").opacity).toBe(1);
    expect(clipById(e, "b").opacity).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("volumeBatchCommitWritesLinearGain", () => {
    const a = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [a] })]);
    applyVolume(e, "a", -6);
    commitScalarProperty(e, ["a"], "volume", -6, "Change Volume");
    expect(clipById(e, "a").volume).toBeCloseTo(0.501, 2);
    e.undo();
    expect(clipById(e, "a").volume).toBe(1);
  });
});
