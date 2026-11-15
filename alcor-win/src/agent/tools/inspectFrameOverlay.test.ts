import { describe, expect, it } from "vitest";
import {
  inspectCaptionLayout, inspectGridStrokes, inspectOverlayMetadataNote, inspectTickFontSize, inspectTickLabels, inspectTickText,
  type GridStroke,
} from "./inspectFrameOverlay";
import {
  lumaGridFromRGBA, lumaGridMeanDiff, overviewCandidateTimes, overviewGrid, overviewTileOrigin, overviewTimeLabel, thinOverviewTiles,
} from "./overviewRenderer";
import { fitLongestEdge, sourceFrameRequest } from "../../preview/offlineRender";

// Port of InspectFrameOverlayTests: pixel assertions become assertions on the pure layout the canvas draws.

const measure = (text: string, fontSize: number): number => text.length * fontSize * 0.6;

/** True when a stroked line (width/2 reach) covers the point. */
function covered(strokes: readonly GridStroke[], x: number, y: number, minWidth = 0): boolean {
  return strokes.some((s) => s.lineWidth >= minWidth && s.lines.some((l) =>
    l.x1 === l.x2
      ? Math.abs(x - l.x1) <= s.lineWidth / 2 && y >= l.y1 && y <= l.y2
      : Math.abs(y - l.y1) <= s.lineWidth / 2 && x >= l.x1 && x <= l.x2));
}

describe("InspectFrameOverlay", () => {
  it("documents the coordinate grid", () => {
    expect(inspectOverlayMetadataNote).toBe("0-1, origin top-left");
  });

  it("paintsGridAtHalfAndLeavesInterior", () => {
    const strokes = inspectGridStrokes(200, 200);
    expect(covered(strokes, 100, 100)).toBe(true);
    expect(covered(strokes, 100, 60)).toBe(true);
    expect(covered(strokes, 60, 100)).toBe(true);
    expect(covered(strokes, 10, 80)).toBe(true);
    expect(covered(strokes, 80, 10)).toBe(true);
    expect(covered(strokes, 35, 75)).toBe(false);
  });

  it("yZeroIsTheTopEdge", () => {
    const strokes = inspectGridStrokes(200, 200);
    expect(covered(strokes, 100, 0.5, 2)).toBe(true);
    expect(covered(strokes, 0.5, 100, 2)).toBe(true);
    const topLine = strokes[3].lines.find((l) => l.y1 === l.y2 && l.y1 < 1);
    expect(topLine).toEqual({ x1: 0, y1: 0.5, x2: 200, y2: 0.5 });
  });

  it("strokes minor lines under major lines, dark under light", () => {
    const strokes = inspectGridStrokes(200, 100);
    expect(strokes.map((s) => [s.lineWidth, s.gray, s.alpha, s.lines.length])).toEqual([
      [2, 0, 0.55, 36], [1, 1, 0.75, 36], [2.5, 0, 0.65, 6], [1.5, 1, 0.95, 6],
    ]);
    const major = strokes[3].lines;
    expect(major.filter((l) => l.x1 === l.x2).map((l) => l.x1)).toEqual([0.5, 100, 199.5]);
    expect(major.filter((l) => l.y1 === l.y2).map((l) => l.y1)).toEqual([0.5, 50, 99.5]);
  });

  it("labels the 0-1 ticks along the bottom and right edges", () => {
    const labels = inspectTickLabels(200, 200, measure);
    expect(labels.length).toBe(21);
    expect(labels.slice(0, 4).map((l) => l.text)).toEqual(["0", "0", "0.1", "0.1"]);
    expect(labels[labels.length - 1].text).toBe("1");
    expect(inspectTickText(0.5)).toBe("0.5");
    expect(inspectTickFontSize(200, 200)).toBe(8);
    expect(inspectTickFontSize(1920, 1080)).toBe(11);
    for (const l of labels) {
      expect(l.chip.x).toBeGreaterThanOrEqual(0);
      expect(l.chip.y).toBeGreaterThanOrEqual(0);
      expect(l.chip.y + l.chip.height).toBeLessThanOrEqual(200);
    }
    // x labels sit on the bottom edge; y=0 label sits at the top.
    expect(labels[0].baselineY).toBe(196);
    expect(labels[1].chip.y).toBeLessThanOrEqual(4);
  });

  it("captionMarksTopLeft", () => {
    const layout = inspectCaptionLayout(18);
    expect(layout.chip).toEqual({ x: 0, y: 0, width: 28, height: 16 });
    expect(layout.baselineY).toBe(12);
  });
});

describe("OverviewRenderer layout", () => {
  it("formats timestamps m:ss and h:mm:ss", () => {
    expect(overviewTimeLabel(0)).toBe("0:00");
    expect(overviewTimeLabel(65.4)).toBe("1:05");
    expect(overviewTimeLabel(59.5)).toBe("1:00");
    expect(overviewTimeLabel(3725)).toBe("1:02:05");
  });

  it("samples candidates at interval midpoints, at least one second apart", () => {
    expect(overviewCandidateTimes(0, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(overviewCandidateTimes(0, 0.4)).toEqual([]);
    const long = overviewCandidateTimes(0, 600);
    expect(long.length).toBe(120);
    expect(long[0]).toBe(2.5);
  });

  it("lays tiles row-major and thins to 36", () => {
    expect(overviewGrid(4)).toEqual({ columns: 4, rows: 1, width: 640, height: 90 });
    expect(overviewGrid(13)).toEqual({ columns: 6, rows: 3, width: 960, height: 270 });
    expect(overviewTileOrigin(7, 6)).toEqual({ x: 160, y: 90 });
    const thinned = thinOverviewTiles(Array.from({ length: 72 }, (_, i) => i));
    expect(thinned.length).toBe(36);
    expect(thinned.slice(0, 3)).toEqual([0, 2, 4]);
    expect(thinOverviewTiles([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("fingerprints luma and compares grids", () => {
    const white = new Uint8Array(256).fill(255);
    const black = new Uint8Array(256);
    expect(lumaGridMeanDiff(lumaGridFromRGBA(white), lumaGridFromRGBA(black))).toBeCloseTo(255, 3);
    expect(lumaGridMeanDiff(lumaGridFromRGBA(white), lumaGridFromRGBA(white))).toBe(0);
  });
});

describe("FrameCaptureRenderer source timing", () => {
  it("sourceSecondsUseVideoTrackTimeRange", () => {
    const request = sourceFrameRequest(2, { start: 1, duration: 2 }, 1 / 5);
    expect(request.capturesLastFrame).toBe(true);
    expect(request.time).toBeCloseTo(14 / 5, 9);
  });

  it("sourcePreviewAndCaptureUseSameTrackRelativeTime", () => {
    const request = sourceFrameRequest(1, { start: 1, duration: 10 }, 1 / 30);
    expect(request.capturesLastFrame).toBe(false);
    expect(request.time).toBe(2);
  });

  it("rejects times outside the video", () => {
    expect(() => sourceFrameRequest(3, { start: 0, duration: 2 }, 0.2)).toThrow("Source time 3.000s is outside 0…2.000s.");
    expect(() => sourceFrameRequest(-1, { start: 0, duration: 2 }, 0.2)).toThrow("outside");
    expect(() => sourceFrameRequest(0, { start: 0, duration: 0 }, 0.2)).toThrow("The video has no finite duration.");
    expect(sourceFrameRequest(2.0005, { start: 0, duration: 2 }, 0.2).capturesLastFrame).toBe(true);
  });

  it("fits the longest edge without upscaling", () => {
    expect(fitLongestEdge(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
    expect(fitLongestEdge(300, 200, 512)).toEqual({ width: 300, height: 200 });
    expect(fitLongestEdge(1920, 1080, undefined)).toEqual({ width: 1920, height: 1080 });
  });
});
