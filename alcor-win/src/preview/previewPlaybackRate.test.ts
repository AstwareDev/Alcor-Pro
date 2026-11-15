import { describe, expect, it } from "vitest";
import {
  frameCountForDuration, previewPlaybackRateAllowsAudioMetering, previewPlaybackRateLabel, previewPlaybackRates,
} from "./previewPlaybackRate";

describe("Preview playback rate", () => {
  it("presetsMatchReviewSpeeds", () => {
    expect([...previewPlaybackRates]).toEqual([0.5, 0.75, 1, 1.5, 2, 4, 10]);
    expect(previewPlaybackRates.map(previewPlaybackRateLabel)).toEqual(["0.5×", "0.75×", "1×", "1.5×", "2×", "4×", "10×"]);
  });

  it("frameAlignedDurationPreservesItsExactFrameCount", () => {
    expect(frameCountForDuration(123 / 30, 30)).toBe(123);
  });

  it("audioMeteringStopsAboveDoubleSpeed", () => {
    expect(previewPlaybackRates.filter(previewPlaybackRateAllowsAudioMetering)).toEqual([0.5, 0.75, 1, 1.5, 2]);
  });
});
