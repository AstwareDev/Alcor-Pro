import { describe, expect, it } from "vitest";
import { ClipSizes, formatClipDuration, showsFadeControls, showsVolumeKeyframes, trimEdgeAt } from "./clipRendererRules";

// Port of ClipRendererPerformanceTests (the rendering-budget cases have no canvas in node and are not ported).
describe("ClipRenderer rules", () => {
  it("volumeKeyframesUseTheSameVisibilityRulesAsRendering", () => {
    const narrow = { x: 0, y: 0, width: ClipSizes.controlsMinWidth - 0.5, height: 64 };
    const controls = { x: 0, y: 0, width: ClipSizes.controlsMinWidth, height: 64 };
    expect(showsFadeControls(true, true, narrow)).toBe(false);
    expect(showsVolumeKeyframes(true, true, narrow)).toBe(false);
    expect(showsFadeControls(false, true, controls)).toBe(true);
    expect(showsVolumeKeyframes(false, true, controls)).toBe(false);
    expect(showsVolumeKeyframes(true, false, controls)).toBe(true);
  });

  it("narrowClipsUseTheirWholeWidthForMoveDragging", () => {
    const narrow = ClipSizes.controlsMinWidth - 0.5;
    const w = ClipSizes.controlsMinWidth;
    expect(trimEdgeAt(0, narrow)).toBeUndefined();
    expect(trimEdgeAt(narrow, narrow)).toBeUndefined();
    expect(trimEdgeAt(0, w)).toBe("left");
    expect(trimEdgeAt(w, w)).toBe("right");
    expect(trimEdgeAt(w / 2, w)).toBeUndefined();
  });

  it("clipDurationDropsHoursBelowOneHour", () => {
    expect(formatClipDuration(95, 30)).toBe("00:03:05");
    expect(formatClipDuration(30 * 3600, 30)).toBe("01:00:00:00");
  });
});
