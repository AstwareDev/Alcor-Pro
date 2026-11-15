import { describe, expect, it } from "vitest";
import {
  clipClampFadesToDuration, clipClampKeyframesToDuration, clipEndFrame, clipFadeMultiplier, clipOpacityAt,
  clipRawOpacityAt, clipRescaleKeyframes, clipSetDuration, clipSetFade, clipSourceDurationFrames,
  clipSourceFramesConsumed, clipTimelineFrame, clipVolumeAt, cropAspectLockLockedTo, cropAspectLockPixelAspect,
  cropAspectLockLabel, cropAspectLockR16x9, cropAspectLockFree, cropAspectLockOriginal, cropAspectLockR1x1,
  cropAspectLockR21x9, cropAspectLockR3x4, cropAspectLockR4x3, cropAspectLockR9x16, cropAspectRatioFromPixels,
  cropIsIdentity, cropMinimumVisibleFraction, cropSetInset, cropVisibleHeightFraction, cropVisibleWidthFraction,
  decodeClip, decodeTimeline, decodeTrack, decodeTransform, encodeTransform, makeClip, makeCrop, makeCropAspectRatio,
  makeTransform, makeTransformFromCenter, makeTransformFromTopLeft, timelineTotalFrames, trackEndFrame,
  trackNameNormalized, TrackNameValidationError, transformSnapCenterToCanvasCenter, transformSnapToBoundary,
  transformSnapToCanvasEdges, transformTopLeft, trackContiguousClipIds, timelineReachableTimelines,
  timelineDisplayFrames, timelineHasAudioClips, VolumeScale, clipSetFadeInterpolation, clipFreshenIds,
} from "./timeline";
import { clipContainsTimelineFrame, clipUpsertKeyframe, clipSetInterpolation, makeKeyframe, makeKeyframeTrack, makeAnimPair } from "./keyframe";
import { clipSetBlurKeyframeTrack, clipSetStaticBlurRadius, clipUpsertBlurKeyframe, clipBlurRadius } from "./clipEffectKeyframes";
import { makeTextStyle } from "./textStyle";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack, roundTrip } from "./fixtures";
import { makeTimelineMarker } from "./timelineMarker";

describe("Clip math", () => {
  it("endFrameIsStartPlusDuration", () => {
    expect(clipEndFrame(fixtureClip({ start: 100, duration: 50 }))).toBe(150);
  });

  it("sourceFramesConsumedScalesByspeed", () => {
    expect(clipSourceFramesConsumed(fixtureClip({ start: 0, duration: 100, speed: 2.0 }))).toBe(200);
  });

  it("sourceFramesConsumedRoundsForFractionalSpeed", () => {
    expect(clipSourceFramesConsumed(fixtureClip({ start: 0, duration: 33, speed: 0.75 }))).toBe(25);
  });

  it("sourceDurationIncludesBothTrims", () => {
    expect(clipSourceDurationFrames(fixtureClip({ start: 0, duration: 100, trimStart: 10, trimEnd: 5 }))).toBe(115);
  });

  it("containsIsHalfOpen", () => {
    const clip = fixtureClip({ start: 50, duration: 30 });
    expect(clipContainsTimelineFrame(clip, 50)).toBe(true);
    expect(clipContainsTimelineFrame(clip, 79)).toBe(true);
    expect(clipContainsTimelineFrame(clip, 80)).toBe(false);
    expect(clipContainsTimelineFrame(clip, 49)).toBe(false);
  });

  it("timelineFrameMapsSourceSecondsThroughTrim", () => {
    const clip = fixtureClip({ start: 100, duration: 60, trimStart: 30 });
    expect(clipTimelineFrame(clip, 2.0, 30)).toBe(130);
  });

  it("timelineFrameDividesByspeed", () => {
    const clip = fixtureClip({ start: 0, duration: 100, speed: 2.0 });
    expect(clipTimelineFrame(clip, 2.0, 30)).toBe(30);
  });

  it("timelineFrameBeforeTrimReturnsNil", () => {
    const clip = fixtureClip({ start: 100, duration: 60, trimStart: 30 });
    expect(clipTimelineFrame(clip, 0.5, 30)).toBeUndefined();
  });

  it("timelineFrameAtOrPastEndFrameReturnsNil", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    expect(clipTimelineFrame(clip, 1.0, 30)).toBeUndefined();
    expect(clipTimelineFrame(clip, 2.0, 30)).toBeUndefined();
  });

  it("fadeMultiplierIsOneEverywhereWithNoFades", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    expect(clipFadeMultiplier(clip, 0)).toBe(1.0);
    expect(clipFadeMultiplier(clip, 50)).toBe(1.0);
    expect(clipFadeMultiplier(clip, 100)).toBe(1.0);
  });

  it("fadeMultiplierIsZeroOutsideClipRange", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.fadeInFrames = 10;
    expect(clipFadeMultiplier(clip, -1)).toBe(0);
    expect(clipFadeMultiplier(clip, 101)).toBe(0);
  });

  it("linearFadeInRampsZeroToOne", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    expect(clipFadeMultiplier(clip, 0)).toBe(0);
    expect(clipFadeMultiplier(clip, 5)).toBe(0.5);
    expect(clipFadeMultiplier(clip, 10)).toBe(1.0);
    expect(clipFadeMultiplier(clip, 50)).toBe(1.0);
  });

  it("smoothFadeInUsesSmoothstep", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "smooth";
    expect(clipFadeMultiplier(clip, 0)).toBe(0);
    expect(clipFadeMultiplier(clip, 5)).toBe(0.5);
    expect(clipFadeMultiplier(clip, 10)).toBe(1.0);
  });

  it("combinedFadesTakeMinimumOfInAndOut", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.fadeInFrames = 20;
    clip.fadeOutFrames = 20;
    clip.fadeInInterpolation = "linear";
    clip.fadeOutInterpolation = "linear";
    expect(clipFadeMultiplier(clip, 0)).toBe(0);
    expect(clipFadeMultiplier(clip, 100)).toBe(0);
    expect(clipFadeMultiplier(clip, 50)).toBe(1.0);
  });

  it("volumeAtReturnsStaticVolumeWithoutFadeOrKfs", () => {
    const clip = fixtureClip({ start: 0, duration: 100, volume: 0.5 });
    expect(clipVolumeAt(clip, 50)).toBe(0.5);
  });

  it("volumeAtMultipliesStaticVolumeByFade", () => {
    const clip = fixtureClip({ start: 0, duration: 100, volume: 0.5 });
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    expect(Math.abs(clipVolumeAt(clip, 5) - 0.25)).toBeLessThan(1e-9);
  });

  it("opacityAtReturnsStaticOpacityWithoutFade", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacity = 0.5;
    expect(clipOpacityAt(clip, 50)).toBe(0.5);
  });

  it("opacityAtMultipliesStaticOpacityByFade", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacity = 0.5;
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    expect(Math.abs(clipOpacityAt(clip, 5) - 0.25)).toBeLessThan(1e-9);
  });

  it("opacityAtMultipliesKeyframedOpacityByFade", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacity = 1.0;
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.4), makeKeyframe(100, 0.4)]);
    clip.fadeOutFrames = 20;
    clip.fadeOutInterpolation = "linear";
    expect(Math.abs(clipOpacityAt(clip, 90) - 0.2)).toBeLessThan(1e-9);
  });

  it("opacityAtIgnoresFadeForAudioClips", () => {
    const clip = fixtureClip({ mediaType: "audio", start: 0, duration: 100 });
    clip.opacity = 1.0;
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    expect(clipOpacityAt(clip, 5)).toBe(1.0);
  });

  it("rawOpacityAtIgnoresFade", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacity = 1.0;
    clip.fadeInFrames = 10;
    clip.fadeInInterpolation = "linear";
    expect(clipRawOpacityAt(clip, 0)).toBe(1.0);
    expect(clipRawOpacityAt(clip, 5)).toBe(1.0);
    expect(clipOpacityAt(clip, 5)).toBe(0.5);
  });

  it("clampClipsFadesToDuration", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.fadeInFrames = 80;
    clip.fadeOutFrames = 80;
    clipClampFadesToDuration(clip);
    expect(clip.fadeInFrames).toBe(80);
    expect(clip.fadeOutFrames).toBe(20);
  });

  it("setFadeWritesEdgeFields", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clipSetFade(clip, "left", 25);
    clipSetFade(clip, "right", 30);
    expect(clip.fadeInFrames).toBe(25);
    expect(clip.fadeOutFrames).toBe(30);
  });

  it("setDurationClampsAllKeyframeTracks", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(90, 0.5)]);
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(90, makeAnimPair(0.1, 0.2))]);
    clip.scaleTrack = makeKeyframeTrack([makeKeyframe(90, makeAnimPair(0.5, 0.5))]);
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(90, 15)]);
    clip.cropTrack = makeKeyframeTrack([makeKeyframe(90, makeCrop({ left: 0.1 }))]);
    clip.volumeTrack = makeKeyframeTrack([makeKeyframe(90, -6)]);

    clipSetDuration(clip, 30);

    expect(clip.opacityTrack).toBeUndefined();
    expect(clip.positionTrack).toBeUndefined();
    expect(clip.scaleTrack).toBeUndefined();
    expect(clip.rotationTrack).toBeUndefined();
    expect(clip.cropTrack).toBeUndefined();
    expect(clip.volumeTrack).toBeUndefined();
  });

  it("durationClampMovesBoundaryKeyframeToLastFrame", () => {
    const clip = fixtureClip({ start: 0, duration: 10 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(9, 0.5), makeKeyframe(10, 1)]);
    clipClampKeyframesToDuration(clip);
    expect(clip.opacityTrack?.keyframes.map((k) => k.frame)).toEqual([9]);
    expect(clip.opacityTrack?.keyframes[0]?.value).toBe(1);
  });

  it("keyframeRescalingClampsRoundingToLastFrame", () => {
    const clip = fixtureClip({ start: 0, duration: 10 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(9, 0.5)]);
    clip.durationFrames = 4;
    clipRescaleKeyframes(clip, 0.4);
    expect(clip.opacityTrack?.keyframes.map((k) => k.frame)).toEqual([3]);
  });
});

describe("Clip math — adversarial", () => {
  it("clipContainsAndTimelineFrameAgreeAtEndFrame", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    const containsEnd = clipContainsTimelineFrame(clip, 30);
    const mappedEnd = clipTimelineFrame(clip, 1.0, 30);
    if (containsEnd) expect(mappedEnd).toBe(30);
    else expect(mappedEnd).toBeUndefined();
  });

  it("endFrameIsExclusive", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    expect(clipContainsTimelineFrame(clip, 30)).toBe(false);
  });

  it("zeroDurationClipDoesNotCrashFadeMultiplier", () => {
    const clip = fixtureClip({ start: 0, duration: 0 });
    clip.fadeInFrames = 5;
    clip.fadeInInterpolation = "linear";
    clipFadeMultiplier(clip, 0);
    clipFadeMultiplier(clip, -1);
    clipFadeMultiplier(clip, 1);
  });

  it("zeroSpeedDoesNotDivideByZeroInTimelineFrame", () => {
    const clip = fixtureClip({ start: 0, duration: 100, speed: 0 });
    clipTimelineFrame(clip, 1.0, 30);
  });

  it("negativeStartFrameProducesNegativeEndFrame", () => {
    const clip = fixtureClip({ start: -50, duration: 30 });
    expect(clipEndFrame(clip)).toBe(-20);
    expect(clipContainsTimelineFrame(clip, -40)).toBe(true);
    expect(clipContainsTimelineFrame(clip, 0)).toBe(false);
  });
});

describe("Timeline — invariants", () => {
  it("timelineTotalFramesEqualsMaximumTrackEndFrame", () => {
    const timeline = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 50 })] }),
        fixtureAudioTrack({ clips: [fixtureClip({ start: 100, duration: 80 })] }),
      ],
    });
    const manualMax = Math.max(...timeline.tracks.map(trackEndFrame), 0);
    expect(timelineTotalFrames(timeline)).toBe(manualMax);
  });

  it("emptyTimelineHasZeroTotalFrames", () => {
    expect(timelineTotalFrames(fixtureTimeline({ tracks: [] }))).toBe(0);
  });

  it("displayFramesIncludesMarkers and hasAudioClips", () => {
    const t = fixtureTimeline({
      tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 30 })] }), fixtureAudioTrack()],
    });
    t.markers = [makeTimelineMarker({ name: "m", startFrame: 40, durationFrames: 10 })];
    expect(timelineDisplayFrames(t)).toBe(50);
    expect(timelineHasAudioClips(t)).toBe(false);
    (t.tracks[1] as { clips: unknown[] }).clips.push(fixtureClip({ mediaType: "audio", start: 0, duration: 5 }));
    expect(timelineHasAudioClips(t)).toBe(true);
  });

  it("contiguousClipIds follows the chain from fromEnd", () => {
    const a = fixtureClip({ id: "a", start: 0, duration: 10 });
    const b = fixtureClip({ id: "b", start: 10, duration: 10 });
    const c = fixtureClip({ id: "c", start: 25, duration: 10 });
    const track = fixtureVideoTrack({ clips: [c, b, a] });
    expect([...trackContiguousClipIds(track, 10, "a")]).toEqual(["b"]);
  });

  it("reachableTimelines walks nested sequences breadth-first without cycles", () => {
    const root = fixtureTimeline();
    const child = fixtureTimeline();
    const grand = fixtureTimeline();
    const seq = (ref: string) => makeClip({ mediaRef: ref, mediaType: "sequence", sourceClipType: "sequence", startFrame: 0, durationFrames: 5 });
    root.tracks = [fixtureVideoTrack({ clips: [seq(child.id)] })];
    child.tracks = [fixtureVideoTrack({ clips: [seq(grand.id), seq(root.id)] })];
    const byId = new Map([root, child, grand].map((t) => [t.id, t]));
    const found = timelineReachableTimelines(root, (id) => byId.get(id));
    expect(found.map((t) => t.id)).toEqual([child.id, grand.id]);
    expect(timelineReachableTimelines(root, (id) => byId.get(id), 1).map((t) => t.id)).toEqual([child.id]);
  });
});

describe("Project JSON roundtrip", () => {
  it("emptyTimelineSurvivesRoundTrip", () => {
    const t = fixtureTimeline();
    expect(roundTrip(t, decodeTimeline)).toEqual(t);
  });

  it("timelineWithSimpleClipsSurvivesRoundTrip", () => {
    const timeline = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 50 })] }),
        fixtureAudioTrack({ clips: [fixtureClip({ mediaType: "audio", start: 0, duration: 100 })] }),
      ],
    });
    expect(roundTrip(timeline, decodeTimeline)).toEqual(timeline);
  });

  it("clipPreservesFadeAndSpeedAndTrimAcrossRoundTrip", () => {
    const clip = fixtureClip({ start: 0, duration: 60, trimStart: 10, trimEnd: 5, speed: 1.5, volume: 0.75 });
    clip.fadeInFrames = 12;
    clip.fadeOutFrames = 8;
    clip.fadeInInterpolation = "linear";
    clip.fadeOutInterpolation = "hold";
    clip.opacity = 0.5;
    const decoded = roundTrip(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), decodeTimeline);
    const dc = decoded.tracks[0]?.clips[0];
    expect(dc?.trimStartFrame).toBe(10);
    expect(dc?.trimEndFrame).toBe(5);
    expect(dc?.speed).toBe(1.5);
    expect(dc?.volume).toBe(0.75);
    expect(dc?.fadeInFrames).toBe(12);
    expect(dc?.fadeOutFrames).toBe(8);
    expect(dc?.fadeInInterpolation).toBe("linear");
    expect(dc?.fadeOutInterpolation).toBe("hold");
    expect(dc?.opacity).toBe(0.5);
  });

  it("clipTransformAndCropSurviveRoundTrip", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    clip.transform = makeTransform({
      centerX: 0.4, centerY: 0.6, width: 0.5, height: 0.5, rotation: 45, rotationX: 20, rotationY: -30,
      flipHorizontal: true, flipVertical: false,
    });
    clip.crop = makeCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 });
    clip.edgeRounding = 0.35;
    clip.edgeSoftness = 0.2;
    const decoded = roundTrip(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), decodeTimeline);
    const dc = decoded.tracks[0]?.clips[0];
    expect(dc?.transform.centerX).toBe(0.4);
    expect(dc?.transform.centerY).toBe(0.6);
    expect(dc?.transform.rotation).toBe(45);
    expect(dc?.transform.rotationX).toBe(20);
    expect(dc?.transform.rotationY).toBe(-30);
    expect(dc?.transform.flipHorizontal).toBe(true);
    expect(dc?.crop).toEqual(makeCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 }));
    expect(dc?.edgeRounding).toBe(0.35);
    expect(dc?.edgeSoftness).toBe(0.2);
  });

  it("clipKeyframesSurviveRoundTrip", () => {
    const clip = fixtureClip({ start: 100, duration: 100 });
    clipUpsertKeyframe(clip, "opacityTrack", 100, 0.0);
    clipUpsertKeyframe(clip, "opacityTrack", 150, 1.0);
    clipSetInterpolation(clip, "opacity", 100, "hold");
    clipUpsertKeyframe(clip, "scaleTrack", 120, makeAnimPair(0.5, 0.5));
    clipUpsertKeyframe(clip, "rotationTrack", 110, 30);
    clipUpsertKeyframe(clip, "cropTrack", 100, makeCrop({ left: 0.1, right: 0.1 }));
    clipUpsertKeyframe(clip, "volumeTrack", 130, -6);

    const decoded = roundTrip(fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] }), decodeTimeline);
    const dc = decoded.tracks[0]?.clips[0];
    expect(dc?.opacityTrack?.keyframes.length).toBe(2);
    expect(dc?.opacityTrack?.keyframes[0]?.interpolationOut).toBe("hold");
    expect(dc?.scaleTrack?.keyframes.length).toBe(1);
    expect(dc?.rotationTrack?.keyframes[0]?.value).toBe(30);
    expect(dc?.cropTrack?.keyframes[0]?.value.left).toBe(0.1);
    expect(dc?.volumeTrack?.keyframes[0]?.value).toBe(-6);
  });

  it("clipLinkGroupAndTextContentSurviveRoundTrip", () => {
    const video = fixtureClip({ id: "v1", start: 0, duration: 50 });
    video.linkGroupId = "group-1";
    const audio = fixtureClip({ id: "a1", mediaType: "audio", start: 0, duration: 50 });
    audio.linkGroupId = "group-1";
    const text = fixtureClip({ id: "t1", mediaRef: "text-1", mediaType: "text", start: 100, duration: 30 });
    text.textContent = "Hello, world!";
    text.textStyle = makeTextStyle({ fontName: "Helvetica-Bold", fontSize: 48, color: { r: 1, g: 0, b: 0, a: 1 } });

    const decoded = roundTrip(
      fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [video, text] }), fixtureAudioTrack({ clips: [audio] })] }),
      decodeTimeline,
    );
    expect(decoded.tracks[0]?.clips[0]?.linkGroupId).toBe("group-1");
    expect(decoded.tracks[1]?.clips[0]?.linkGroupId).toBe("group-1");
    const dt = decoded.tracks[0]?.clips.find((c) => c.id === "t1");
    expect(dt?.textContent).toBe("Hello, world!");
    expect(dt?.textStyle?.fontSize).toBe(48);
    expect(dt?.textStyle?.color.r).toBe(1);
  });

  it("trackMutedAndHiddenFlagsSurviveRoundTrip", () => {
    const v = fixtureVideoTrack();
    v.hidden = true;
    v.name = "B-roll";
    const a = fixtureAudioTrack();
    a.muted = true;
    const decoded = roundTrip(fixtureTimeline({ tracks: [v, a] }), decodeTimeline);
    expect(decoded.tracks[0]?.hidden).toBe(true);
    expect(decoded.tracks[0]?.name).toBe("B-roll");
    expect(decoded.tracks[1]?.muted).toBe(true);
  });

  it("trackMissingMutedFieldDecodesAsFalse", () => {
    const track = decodeTrack({ id: "t1", type: "video", label: "V1", clips: [] });
    expect(track.muted).toBe(false);
    expect(track.hidden).toBe(false);
    expect(track.syncLocked).toBe(true);
    expect(track.name).toBeUndefined();
  });

  it("clipMissingNewFieldsDecodesWithDefaults", () => {
    const clip = decodeClip({ id: "c1", mediaRef: "media-1", startFrame: 0, durationFrames: 30 });
    expect(clip.speed).toBe(1.0);
    expect(clip.volume).toBe(1.0);
    expect(clip.opacity).toBe(1.0);
    expect(clip.fadeInFrames).toBe(0);
    expect(clip.fadeInInterpolation).toBe("linear");
    expect(clip.transform).toEqual(makeTransform());
    expect(clip.crop).toEqual(makeCrop());
    expect(clip.edgeRounding).toBe(0);
    expect(clip.edgeSoftness).toBe(0);
    expect(clip.linkGroupId).toBeUndefined();
    expect(clip.textContent).toBeUndefined();
  });

  it.each([-0.1, 1.1])("clipInvalidEdgeRoundingDecodesAsDefault %s", (value) => {
    const clip = decodeClip({ mediaRef: "media-1", startFrame: 0, durationFrames: 30, edgeRounding: value });
    expect(clip.edgeRounding).toBe(0);
  });

  it.each([-0.1, 1.1])("clipInvalidEdgeSoftnessDecodesAsDefault %s", (value) => {
    const clip = decodeClip({ mediaRef: "media-1", startFrame: 0, durationFrames: 30, edgeSoftness: value });
    expect(clip.edgeSoftness).toBe(0);
  });

  it("transformMigratesLegacyXYToCenterXY", () => {
    const t = decodeTransform({ x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
    expect(t.width).toBe(0.4);
    expect(t.height).toBe(0.3);
    expect(t.centerX !== 0.5 || t.centerY !== 0.5).toBe(true);
    expect(t.centerX).toBeCloseTo(0.1 + 0.4 - 0.5, 12);
    expect(t.centerY).toBeCloseTo(0.2 + 0.3 - 0.5, 12);
  });

  it("transform encode writes only the canonical keys", () => {
    const encoded = encodeTransform(makeTransform({ centerX: 0.2 })) as Record<string, unknown>;
    expect(Object.keys(encoded).sort()).toEqual(
      ["centerX", "centerY", "flipHorizontal", "flipVertical", "height", "rotation", "rotationX", "rotationY", "width"],
    );
  });

  it("clip with an invalid transform falls back to the default transform", () => {
    const clip = decodeClip({ mediaRef: "m", startFrame: 0, durationFrames: 1, transform: { width: "wide" } });
    expect(clip.transform).toEqual(makeTransform());
  });

  it("clip with a partial crop falls back to the default crop (synthesized decode needs every key)", () => {
    const clip = decodeClip({ mediaRef: "m", startFrame: 0, durationFrames: 1, crop: { left: 0.2 } });
    expect(clip.crop).toEqual(makeCrop());
  });

  it("timelineFolderIdPersists", () => {
    const t = fixtureTimeline();
    t.folderId = "f1";
    expect(roundTrip(t, decodeTimeline).folderId).toBe("f1");
  });

  it("track displayHeight is clamped on decode", () => {
    expect(decodeTrack({ type: "video", displayHeight: 5000 }).displayHeight).toBe(200);
    expect(decodeTrack({ type: "video", displayHeight: 1 }).displayHeight).toBe(32);
    expect(decodeTrack({ type: "video" }).displayHeight).toBe(44);
  });
});

describe("Blend modes", () => {
  it("clipBlendModeRoundTrips", () => {
    const clip = makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 30 });
    clip.blendMode = "overlay";
    expect(roundTrip(clip, decodeClip).blendMode).toBe("overlay");
  });

  it("oldClipJSONDecodesWithNilBlendMode", () => {
    const clip = decodeClip(JSON.parse('{"mediaRef":"m","startFrame":0,"durationFrames":30}'));
    expect(clip.blendMode).toBeUndefined();
  });
});

describe("Transform", () => {
  it("topLeftIsCenterMinusHalfSize", () => {
    const t = makeTransform({ centerX: 0.6, centerY: 0.4, width: 0.4, height: 0.2 });
    expect(Math.abs(transformTopLeft(t).x - 0.4)).toBeLessThan(1e-9);
    expect(Math.abs(transformTopLeft(t).y - 0.3)).toBeLessThan(1e-9);
  });

  it("centerInitializerComputesCenterX", () => {
    const t = makeTransformFromCenter({ x: 0.7, y: 0.3 }, 0.2, 0.2);
    expect(t.centerX).toBe(0.7);
    expect(t.centerY).toBe(0.3);
  });

  it("topLeftInitializerComputesCenter", () => {
    const t = makeTransformFromTopLeft({ x: 0.2, y: 0.4 }, 0.4, 0.2);
    expect(t.centerX).toBe(0.4);
    expect(t.centerY).toBe(0.5);
  });

  it("snapToBoundaryClampsToZeroWithinThreshold", () => {
    expect(transformSnapToBoundary(0.01, 0.05)).toBe(0);
    expect(transformSnapToBoundary(-0.01, 0.05)).toBe(0);
  });

  it("snapToBoundaryClampsToOneWithinThreshold", () => {
    expect(transformSnapToBoundary(0.97, 0.05)).toBe(1);
    expect(transformSnapToBoundary(1.02, 0.05)).toBe(1);
  });

  it("snapToBoundaryLeavesMidRangeAlone", () => {
    expect(transformSnapToBoundary(0.5, 0.05)).toBe(0.5);
    expect(transformSnapToBoundary(0.1, 0.05)).toBe(0.1);
  });

  it("snapToCanvasEdgesSnapsLeftEdgeWhenNearZero", () => {
    const t = makeTransform({ centerX: 0.252, centerY: 0.5, width: 0.5, height: 0.5 });
    transformSnapToCanvasEdges(t, 0.05);
    expect(Math.abs(t.centerX - 0.25)).toBeLessThan(1e-9);
  });

  it("snapToCanvasEdgesSnapsRightEdgeWhenNearOne", () => {
    const t = makeTransform({ centerX: 0.748, centerY: 0.5, width: 0.5, height: 0.5 });
    transformSnapToCanvasEdges(t, 0.05);
    expect(Math.abs(t.centerX - 0.75)).toBeLessThan(1e-9);
  });

  it("snapToCanvasEdgesLeavesCenteredTransformAlone", () => {
    const t = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 });
    transformSnapToCanvasEdges(t, 0.05);
    expect(t.centerX).toBe(0.5);
    expect(t.centerY).toBe(0.5);
  });

  it("snapCenterToCanvasCenterSnapsWithinThreshold", () => {
    const t = makeTransform({ centerX: 0.51, centerY: 0.49 });
    const r = transformSnapCenterToCanvasCenter(t, 0.05, 0.05);
    expect(t.centerX).toBe(0.5);
    expect(t.centerY).toBe(0.5);
    expect(r).toEqual({ x: true, y: true });
  });

  it("snapCenterToCanvasCenterReportsPerAxisSnap", () => {
    const t = makeTransform({ centerX: 0.51, centerY: 0.7 });
    const r = transformSnapCenterToCanvasCenter(t, 0.05, 0.05);
    expect(t.centerX).toBe(0.5);
    expect(t.centerY).toBe(0.7);
    expect(r).toEqual({ x: true, y: false });
  });
});

describe("Crop", () => {
  it("identityCropHasAllZeroInsets", () => {
    expect(cropIsIdentity(makeCrop())).toBe(true);
    expect(cropIsIdentity(makeCrop({ left: 0.1 }))).toBe(false);
    expect(cropIsIdentity(makeCrop({ top: 0.1 }))).toBe(false);
    expect(cropIsIdentity(makeCrop({ right: 0.1 }))).toBe(false);
    expect(cropIsIdentity(makeCrop({ bottom: 0.1 }))).toBe(false);
  });

  it("visibleFractionsSubtractInsets", () => {
    const crop = makeCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 });
    expect(Math.abs(cropVisibleWidthFraction(crop) - 0.6)).toBeLessThan(1e-9);
    expect(Math.abs(cropVisibleHeightFraction(crop) - 0.4)).toBeLessThan(1e-9);
  });

  it("visibleFractionsClampNegativeToZero", () => {
    const crop = makeCrop({ left: 0.6, top: 0.5, right: 0.6, bottom: 0.6 });
    expect(cropVisibleWidthFraction(crop)).toBe(0);
    expect(cropVisibleHeightFraction(crop)).toBe(0);
  });

  it("cropInsetsPreserveMinimumVisibleArea", () => {
    const crop = makeCrop({ right: 0.4, bottom: 0.25 });
    cropSetInset(crop, 1, "left");
    cropSetInset(crop, 1, "top");
    expect(Math.abs(cropVisibleWidthFraction(crop) - cropMinimumVisibleFraction)).toBeLessThan(1e-12);
    expect(Math.abs(cropVisibleHeightFraction(crop) - cropMinimumVisibleFraction)).toBeLessThan(1e-12);
  });

  it("cropInsetsIgnoreNonFiniteValues", () => {
    const crop = makeCrop({ left: 0.1 });
    cropSetInset(crop, Number.NaN, "left");
    expect(crop.left).toBe(0.1);
  });
});

describe("CropAspectLock", () => {
  it("freeAndOriginalHaveNoFixedAspect", () => {
    expect(cropAspectLockPixelAspect(cropAspectLockFree)).toBeUndefined();
    expect(cropAspectLockPixelAspect(cropAspectLockOriginal)).toBeUndefined();
  });

  it("namedAspectsProduceExpectedRatios", () => {
    expect(cropAspectLockPixelAspect(cropAspectLockR1x1)).toBe(1.0);
    expect(cropAspectLockPixelAspect(cropAspectLockR16x9)).toBe(16.0 / 9.0);
    expect(cropAspectLockPixelAspect(cropAspectLockR9x16)).toBe(9.0 / 16.0);
    expect(cropAspectLockPixelAspect(cropAspectLockR4x3)).toBe(4.0 / 3.0);
    expect(cropAspectLockPixelAspect(cropAspectLockR3x4)).toBe(3.0 / 4.0);
    expect(cropAspectLockPixelAspect(cropAspectLockR21x9)).toBe(21.0 / 9.0);
  });

  it("customAspectUsesEnteredComponents", () => {
    const ratio = makeCropAspectRatio(2.39, 1);
    expect(ratio).toBeDefined();
    const lock = cropAspectLockLockedTo(ratio as NonNullable<typeof ratio>);
    expect(lock).toEqual({ kind: "fixed", ratio });
    expect(cropAspectLockPixelAspect(lock)).toBe(2.39);
    expect(cropAspectLockLabel(lock)).toBe("2.39:1");
  });

  it("customAspectMatchingPresetUsesPresetLock", () => {
    const ratio = makeCropAspectRatio(16, 9);
    expect(cropAspectLockLockedTo(ratio as NonNullable<typeof ratio>)).toBe(cropAspectLockR16x9);
  });
});

describe("CropAspectRatio", () => {
  it("pixelDimensionsReduceToRatioComponents", () => {
    const ratio = cropAspectRatioFromPixels(3840, 2160);
    expect(ratio?.horizontal).toBe(16);
    expect(ratio?.vertical).toBe(9);
  });

  it("invalidComponentsAreRejected", () => {
    expect(makeCropAspectRatio(0, 1)).toBeUndefined();
    expect(makeCropAspectRatio(-1, 1)).toBeUndefined();
    expect(makeCropAspectRatio(1, 0)).toBeUndefined();
    expect(makeCropAspectRatio(Number.POSITIVE_INFINITY, 1)).toBeUndefined();
    expect(makeCropAspectRatio(1, Number.NaN)).toBeUndefined();
  });
});

describe("Transform — adversarial", () => {
  it("topLeftInitRoundtrips", () => {
    const t = makeTransformFromTopLeft({ x: 0.2, y: 0.4 }, 0.4, 0.2);
    expect(Math.abs(transformTopLeft(t).x - 0.2)).toBeLessThan(1e-9);
    expect(Math.abs(transformTopLeft(t).y - 0.4)).toBeLessThan(1e-9);
  });

  it("snapToBoundaryWithNaNValueDoesNotCrashOrSnap", () => {
    expect(Number.isNaN(transformSnapToBoundary(Number.NaN, 0.05))).toBe(true);
  });

  it("snapToBoundaryWithInfinityIsLeftAlone", () => {
    expect(transformSnapToBoundary(Number.POSITIVE_INFINITY, 0.05)).toBe(Number.POSITIVE_INFINITY);
  });

  it("snapCenterToCanvasCenterWithNaNCenterDoesNotCrash", () => {
    const t = makeTransform();
    t.centerX = Number.NaN;
    t.centerY = 0.5;
    const r = transformSnapCenterToCanvasCenter(t, 0.05, 0.05);
    expect(r.x).toBe(false);
    expect(r.y).toBe(true);
  });
});

describe("TrackName", () => {
  it("normalizes and validates", () => {
    expect(trackNameNormalized(undefined)).toBeUndefined();
    expect(trackNameNormalized("  B-roll  ")).toBe("B-roll");
    expect(trackNameNormalized("   ")).toBeUndefined();
    expect(() => trackNameNormalized("a\nb")).toThrow(TrackNameValidationError);
    expect(() => trackNameNormalized("x".repeat(81))).toThrow(TrackNameValidationError);
    expect(trackNameNormalized("x".repeat(80))).toBe("x".repeat(80));
  });

  it("an invalid stored name decodes as no name", () => {
    expect(decodeTrack({ type: "video", name: "a\tb" }).name).toBeUndefined();
  });
});

describe("Volume and blur helpers", () => {
  it("VolumeScale maps linear and dB", () => {
    expect(VolumeScale.dbFromLinear(0)).toBe(-60);
    expect(VolumeScale.dbFromLinear(1)).toBe(0);
    expect(VolumeScale.linearFromDb(-60)).toBe(0);
    expect(VolumeScale.linearFromDb(0)).toBe(1);
    expect(VolumeScale.linearFromDb(100)).toBeCloseTo(Math.pow(10, 15 / 20), 12);
  });

  it("static blur creates, removes and clamps the gaussian effect", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    clipSetStaticBlurRadius(clip, 500);
    expect(clip.effects?.[0]?.params["radius"]?.value).toBe(100);
    clipSetStaticBlurRadius(clip, 0);
    expect(clip.effects).toBeUndefined();
  });

  it("blur keyframes sample relative to the clip start", () => {
    const clip = fixtureClip({ start: 100, duration: 30 });
    clipUpsertBlurKeyframe(clip, 100, 0);
    clipUpsertBlurKeyframe(clip, 110, 10);
    clipSetBlurKeyframeTrack(clip, clip.effects?.[0]?.params["radius"]?.track);
    expect(clipBlurRadius(clip, 110)).toBe(10);
  });

  it("freshenIds remaps group ids consistently", () => {
    const a = fixtureClip({ id: "a", start: 0, duration: 1 });
    const b = fixtureClip({ id: "b", start: 0, duration: 1 });
    a.linkGroupId = "g";
    b.linkGroupId = "g";
    const groups = new Map<string, string>();
    clipFreshenIds(a, groups);
    clipFreshenIds(b, groups);
    expect(a.id).not.toBe("a");
    expect(a.linkGroupId).toBe(b.linkGroupId);
    expect(a.linkGroupId).not.toBe("g");
  });

  it("fade interpolation setter", () => {
    const clip = fixtureClip({ start: 0, duration: 10 });
    clipSetFadeInterpolation(clip, "left", "hold");
    expect(clip.fadeInInterpolation).toBe("hold");
  });
});
