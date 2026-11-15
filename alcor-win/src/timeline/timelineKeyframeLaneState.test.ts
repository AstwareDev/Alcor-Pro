import { describe, expect, it } from "vitest";
import {
  clipClampKeyframesToDuration,
  clipRescaleKeyframes,
  cropMinimumVisibleFraction,
  cropSetInset,
  cropVisibleHeightFraction,
  cropVisibleWidthFraction,
  makeCrop,
  makeKeyframe,
  makeKeyframeTrack,
} from "../model";
import { fixtureClip } from "../model/fixtures";
import {
  laneStatePrune,
  laneStateToggle,
  makeTimelineKeyframeLaneState,
} from "./timelineKeyframeLaneState";

describe("Timeline keyframe lanes", () => {
  it("expansionStateKeepsMultipleTracksOpenAndPrunesDeletedTracks", () => {
    const state = makeTimelineKeyframeLaneState();
    laneStateToggle(state, "video");
    laneStateToggle(state, "audio");

    expect(state.expandedTrackIds).toEqual(new Set(["video", "audio"]));

    laneStatePrune(state, new Set(["audio"]));

    expect(state.expandedTrackIds).toEqual(new Set(["audio"]));
  });

  // textSupportsScaleButNotCropOrVolume, mixedVisualTrackUsesUnionOfSupportedLanes and
  // textOnlyAndAudioTracksExposeTheirOwnLaneSets are covered in src/model/keyframe.test.ts.

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
