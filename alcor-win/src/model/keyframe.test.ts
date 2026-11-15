import { describe, expect, it } from "vitest";
import {
  animPairInterpolator, clipInterpolation, clipKeyframeFrames, clipMoveKeyframe, clipRemoveKeyframe, clipSetInterpolation,
  clipSupportsKeyframes, clipUpsertKeyframe, animatablePropertyLanes, cropInterpolator, doubleInterpolator,
  keyframeTrackFramesIn, keyframeTrackIsActive, keyframeTrackMove, keyframeTrackRemove, keyframeTrackSample,
  keyframeTrackUpsert, makeAnimPair, makeKeyframe, makeKeyframeTrack, smoothstep, keyframeTrackRebased,
  type KeyframeTrack,
} from "./keyframe";
import { clipTransformAt, makeCrop, makeTransform, type Clip } from "./timeline";
import { fixtureClip, fixtureVideoTrack, fixtureAudioTrack } from "./fixtures";

const sample = (t: KeyframeTrack<number>, frame: number, fallback: number) =>
  keyframeTrackSample(t, frame, fallback, doubleInterpolator);

describe("KeyframeTrack mutations", () => {
  it("upsertIntoEmptyAppends", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    expect(track.keyframes.length).toBe(1);
    expect(track.keyframes[0]?.frame).toBe(10);
    expect(keyframeTrackIsActive(track)).toBe(true);
  });

  it("upsertMaintainsSortedOrder", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(20, 2.0));
    keyframeTrackUpsert(track, makeKeyframe(5, 0.5));
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    expect(track.keyframes.map((k) => k.frame)).toEqual([5, 10, 20]);
  });

  it("upsertReplacesKeyframeAtSameFrame", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackUpsert(track, makeKeyframe(10, 99.0));
    expect(track.keyframes.length).toBe(1);
    expect(track.keyframes[0]?.value).toBe(99.0);
  });

  it("removeDeletesAtFrame", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(5, 0.5));
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackRemove(track, 5);
    expect(track.keyframes.map((k) => k.frame)).toEqual([10]);
  });

  it("removeAtMissingFrameIsNoOp", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackRemove(track, 99);
    expect(track.keyframes.length).toBe(1);
  });

  it("emptyTrackIsNotActive", () => {
    expect(keyframeTrackIsActive(makeKeyframeTrack<number>())).toBe(false);
  });

  it("moveRelocatesKeyframeAndMaintainsOrder", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(5, 0.5));
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackUpsert(track, makeKeyframe(20, 2.0));
    keyframeTrackMove(track, 5, 15);
    expect(track.keyframes.map((k) => k.frame)).toEqual([10, 15, 20]);
    expect(track.keyframes[1]?.value).toBe(0.5);
  });

  it("moveFromMissingFrameIsNoOp", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackMove(track, 99, 5);
    expect(track.keyframes.map((k) => k.frame)).toEqual([10]);
  });

  it("moveOntoExistingFrameIsRefused", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(5, 0.5));
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackMove(track, 5, 10);
    expect(track.keyframes.length).toBe(2);
    expect(track.keyframes.find((k) => k.frame === 5)?.value).toBe(0.5);
    expect(track.keyframes.find((k) => k.frame === 10)?.value).toBe(1.0);
  });

  it("moveOntoSameFrameIsNoOp", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 0.5));
    keyframeTrackMove(track, 10, 10);
    expect(track.keyframes.length).toBe(1);
    expect(track.keyframes[0]?.value).toBe(0.5);
  });

  it("framesInRangeReturnsOnlyInclusiveWindow", () => {
    const track = makeKeyframeTrack([makeKeyframe(5, 0.5), makeKeyframe(10, 1), makeKeyframe(20, 2), makeKeyframe(30, 3)]);
    expect(keyframeTrackFramesIn(track, 10, 20)).toEqual([10, 20]);
    expect(keyframeTrackFramesIn(track, 21, 29)).toEqual([]);
  });
});

describe("KeyframeTrack.sample", () => {
  it("emptyTrackReturnsFallback", () => {
    expect(sample(makeKeyframeTrack<number>(), 10, 42.0)).toBe(42.0);
  });

  it("singleKeyframeReturnsItsValueEverywhere", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 7.0));
    expect(sample(track, 0, 0)).toBe(7.0);
    expect(sample(track, 10, 0)).toBe(7.0);
    expect(sample(track, 100, 0)).toBe(7.0);
  });

  it("samplesBeforeFirstClampToFirstValue", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackUpsert(track, makeKeyframe(20, 2.0));
    expect(sample(track, 5, 0)).toBe(1.0);
    expect(sample(track, 10, 0)).toBe(1.0);
  });

  it("samplesAfterLastClampToLastValue", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(10, 1.0));
    keyframeTrackUpsert(track, makeKeyframe(20, 2.0));
    expect(sample(track, 20, 0)).toBe(2.0);
    expect(sample(track, 100, 0)).toBe(2.0);
  });

  it("linearInterpolatesBetweenKeyframes", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(0, 0, "linear"));
    keyframeTrackUpsert(track, makeKeyframe(10, 10));
    expect(sample(track, 3, 0)).toBe(3.0);
    expect(sample(track, 5, 0)).toBe(5.0);
    expect(sample(track, 7, 0)).toBe(7.0);
  });

  it("holdReturnsLeftKeyframeUntilNextStarts", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(0, 0, "hold"));
    keyframeTrackUpsert(track, makeKeyframe(10, 10));
    expect(sample(track, 1, 0)).toBe(0.0);
    expect(sample(track, 9, 0)).toBe(0.0);
    expect(sample(track, 10, 0)).toBe(10.0);
  });

  it("smoothUsesSmoothstepEasing", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(0, 0, "smooth"));
    keyframeTrackUpsert(track, makeKeyframe(10, 10));
    expect(sample(track, 5, 0)).toBe(5.0);
    const early = sample(track, 1, 0);
    expect(early).toBeLessThan(1.0);
    expect(early).toBeGreaterThan(0);
  });

  it("interpolationOutBelongsToLeftKeyframe", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(0, 0, "linear"));
    keyframeTrackUpsert(track, makeKeyframe(10, 10, "hold"));
    expect(sample(track, 5, 0)).toBe(5.0);
  });
});

describe("KeyframeTrack.rebased", () => {
  it("inserts a boundary keyframe at 0 carrying the sampled value", () => {
    const track = makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(10, 10, "linear")]);
    const rebased = keyframeTrackRebased(track, 4, 0, doubleInterpolator);
    expect(rebased?.keyframes).toEqual([
      { frame: 0, value: 4, interpolationOut: "linear" },
      { frame: 6, value: 10, interpolationOut: "linear" },
    ]);
  });

  it("returns undefined for an inactive track", () => {
    expect(keyframeTrackRebased(makeKeyframeTrack<number>(), 3, 0, doubleInterpolator)).toBeUndefined();
  });
});

describe("Clip transform sampling", () => {
  it("sampledTransformPreservesStaticOrientation", () => {
    const clip = fixtureClip({ start: 10, duration: 60 });
    clip.transform = makeTransform({
      centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.3, rotation: 15, flipHorizontal: true, flipVertical: true,
    });
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(5, makeAnimPair(0.2, 0.25))]);
    clip.scaleTrack = makeKeyframeTrack([makeKeyframe(5, makeAnimPair(0.5, 0.4))]);
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(5, 90)]);

    const transform = clipTransformAt(clip, 15);

    expect(transform.centerX).toBe(0.45);
    expect(transform.centerY).toBe(0.45);
    expect(transform.width).toBe(0.5);
    expect(transform.height).toBe(0.4);
    expect(transform.rotation).toBe(90);
    expect(transform.flipHorizontal).toBe(true);
    expect(transform.flipVertical).toBe(true);
  });
});

describe("Interpolation primitives", () => {
  it("smoothstepEndpointsAreZeroAndOne", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
  });

  it("smoothstepMidpointIsHalf", () => {
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it("smoothstepFlattensNearEdges", () => {
    expect(smoothstep(0.1)).toBeLessThan(0.1);
    expect(smoothstep(0.9)).toBeGreaterThan(0.9);
  });

  it("doubleInterpolationIsLinear", () => {
    expect(doubleInterpolator.interpolate(0, 10, 0.25)).toBe(2.5);
    expect(doubleInterpolator.interpolate(-5, 5, 0.5)).toBe(0);
  });

  it("animPairInterpolatesBothComponentsIndependently", () => {
    const result = animPairInterpolator.interpolate(makeAnimPair(0, 100), makeAnimPair(10, 200), 0.5);
    expect(result.a).toBe(5);
    expect(result.b).toBe(150);
  });

  it("cropInterpolatesAllFourInsets", () => {
    const result = cropInterpolator.interpolate(
      makeCrop({ left: 0, top: 0, right: 0, bottom: 0 }),
      makeCrop({ left: 1, top: 1, right: 1, bottom: 1 }),
      0.25,
    );
    expect(result).toEqual({ left: 0.25, top: 0.25, right: 0.25, bottom: 0.25 });
  });
});

describe("Keyframes — adversarial", () => {
  it("trackStaysSortedAcrossScrambledUpserts", () => {
    const track = makeKeyframeTrack<number>();
    for (const f of [50, 10, 90, 30, 70, 0, 40, 20, 80, 60]) keyframeTrackUpsert(track, makeKeyframe(f, f));
    const frames = track.keyframes.map((k) => k.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
  });

  it("upsertCollapsesRepeatedSameFrameWrites", () => {
    const track = makeKeyframeTrack<number>();
    for (const v of [1.0, 2.0, 3.0, 4.0]) keyframeTrackUpsert(track, makeKeyframe(10, v));
    expect(track.keyframes.length).toBe(1);
    expect(track.keyframes[0]?.value).toBe(4.0);
  });

  it("smoothstepStaysInUnitIntervalForUnitInputs", () => {
    for (let i = 0; i <= 20; i++) {
      const s = smoothstep(i * 0.05);
      expect(s >= 0 && s <= 1).toBe(true);
    }
  });

  it("smoothstepIsMonotonicallyNonDecreasingOnUnitInterval", () => {
    let prev = smoothstep(0);
    for (let i = 1; i <= 100; i++) {
      const s = smoothstep(i / 100.0);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("trackAcceptsNegativeFramesAndStaysSorted", () => {
    const track = makeKeyframeTrack<number>();
    keyframeTrackUpsert(track, makeKeyframe(-10, 0));
    keyframeTrackUpsert(track, makeKeyframe(10, 1));
    keyframeTrackUpsert(track, makeKeyframe(-5, 0.5));
    expect(track.keyframes.map((k) => k.frame)).toEqual([-10, -5, 10]);
  });
});

describe("Clip keyframe extensions", () => {
  const upsertOpacity = (clip: Clip, frame: number, value: number) => clipUpsertKeyframe(clip, "opacityTrack", frame, value);

  it("keyframeFramesAreAbsoluteNotClipRelative", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    upsertOpacity(clip, 150, 1.0);
    expect(clipKeyframeFrames(clip, "opacity")).toEqual([10, 50].map((x) => x + clip.startFrame));
  });

  it("keyframeFramesReturnsEmptyForUntouchedProperty", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    expect(clipKeyframeFrames(clip, "opacity")).toEqual([]);
    expect(clipKeyframeFrames(clip, "position")).toEqual([]);
  });

  it("upsertCreatesTrackIfAbsent", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    expect(clip.opacityTrack).toBeUndefined();
    upsertOpacity(clip, 10, 0.5);
    expect(clip.opacityTrack?.keyframes.length).toBe(1);
  });

  it("upsertOnSameFrameReplacesValue", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 130, 0.5);
    upsertOpacity(clip, 130, 0.9);
    expect(clip.opacityTrack?.keyframes.length).toBe(1);
    expect(clip.opacityTrack?.keyframes[0]?.value).toBe(0.9);
  });

  it("removeKeyframeDropsByAbsoluteFrame", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    upsertOpacity(clip, 150, 1.0);
    clipRemoveKeyframe(clip, "opacity", 110);
    expect(clipKeyframeFrames(clip, "opacity")).toEqual([150]);
  });

  it("removeLastKeyframeNilsTheTrack", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    clipRemoveKeyframe(clip, "opacity", 110);
    expect(clip.opacityTrack).toBeUndefined();
  });

  it("removeKeyframeAtMissingFrameIsNoOp", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    clipRemoveKeyframe(clip, "opacity", 999);
    expect(clip.opacityTrack?.keyframes.length).toBe(1);
  });

  it("setInterpolationChangesNamedKeyframeOnly", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    upsertOpacity(clip, 150, 1.0);
    clipSetInterpolation(clip, "opacity", 110, "hold");
    expect(clipInterpolation(clip, "opacity", 110)).toBe("hold");
    expect(clipInterpolation(clip, "opacity", 150)).not.toBe("hold");
  });

  it("setInterpolationAtMissingFrameIsNoOp", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    clipSetInterpolation(clip, "opacity", 999, "linear");
    expect(clipInterpolation(clip, "opacity", 110)).toBe("smooth");
  });

  it("moveKeyframeRelocatesByAbsoluteFrame", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    clipMoveKeyframe(clip, "opacity", 110, 140);
    expect(clipKeyframeFrames(clip, "opacity")).toEqual([140]);
  });

  it("moveKeyframeOntoExistingFrameIsRefused", () => {
    const clip = fixtureClip({ start: 100, duration: 60 });
    upsertOpacity(clip, 110, 0.5);
    upsertOpacity(clip, 140, 1.0);
    clipMoveKeyframe(clip, "opacity", 110, 140);
    expect(clip.opacityTrack?.keyframes.length).toBe(2);
    expect(clipKeyframeFrames(clip, "opacity")).toEqual([110, 140]);
  });
});

describe("Timeline keyframe lanes", () => {
  it("textSupportsScaleButNotCropOrVolume", () => {
    const text = fixtureClip({ mediaType: "text", start: 0, duration: 30 });
    expect(clipSupportsKeyframes(text, "position")).toBe(true);
    expect(clipSupportsKeyframes(text, "rotation")).toBe(true);
    expect(clipSupportsKeyframes(text, "opacity")).toBe(true);
    expect(clipSupportsKeyframes(text, "blur")).toBe(true);
    expect(clipSupportsKeyframes(text, "scale")).toBe(true);
    expect(clipSupportsKeyframes(text, "crop")).toBe(false);
    expect(clipSupportsKeyframes(text, "volume")).toBe(false);
  });

  it("mixedVisualTrackUsesUnionOfSupportedLanes", () => {
    const track = fixtureVideoTrack({
      clips: [fixtureClip({ mediaType: "text", start: 0, duration: 30 }), fixtureClip({ mediaType: "video", start: 30, duration: 30 })],
    });
    expect(animatablePropertyLanes(track)).toEqual(["position", "scale", "rotation", "opacity", "blur", "crop"]);
  });

  it("textOnlyAndAudioTracksExposeTheirOwnLaneSets", () => {
    const textTrack = fixtureVideoTrack({ clips: [fixtureClip({ mediaType: "text", start: 0, duration: 30 })] });
    const audioTrack = fixtureAudioTrack({ clips: [fixtureClip({ mediaType: "audio", start: 0, duration: 30 })] });
    expect(animatablePropertyLanes(textTrack)).toEqual(["position", "scale", "rotation", "opacity", "blur"]);
    expect(animatablePropertyLanes(audioTrack)).toEqual([]);
  });
});
