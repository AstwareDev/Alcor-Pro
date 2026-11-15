import { describe, expect, it } from "vitest";
import {
  exportEstimatedFileBytes, exportResolutionRenderSize, exportResolutionShortSidePixels, exportTargetVideoBitrate,
  formatFileSize, resolveExportRange, validateVideoExport, videoCodecContainer, videoCodecExportFormat,
  videoCodecFromFormat, videoCodecs,
} from "./exportOptions";

describe("ExportResolution.renderSize", () => {
  it("shortSidePixelsForEachPreset", () => {
    expect(exportResolutionShortSidePixels("720p")).toBe(720);
    expect(exportResolutionShortSidePixels("1080p")).toBe(1080);
    expect(exportResolutionShortSidePixels("4K")).toBe(2160);
    expect(exportResolutionShortSidePixels("2K")).toBe(1440);
    expect(exportResolutionShortSidePixels("Match Timeline")).toBeUndefined();
  });
  it("landscapeCanvas1080pPreservesAspect", () => {
    expect(exportResolutionRenderSize("1080p", { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });
  it("landscape4kScalesShortSideTo2160", () => {
    expect(exportResolutionRenderSize("4K", { width: 1920, height: 1080 })).toEqual({ width: 3840, height: 2160 });
  });
  it("landscape720pDownscalesShortSideTo720", () => {
    expect(exportResolutionRenderSize("720p", { width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
  });
  it("portraitCanvasUsesWidthAsShortSide", () => {
    expect(exportResolutionRenderSize("1080p", { width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
  });
  it("portrait4kScalesWidthTo2160", () => {
    expect(exportResolutionRenderSize("4K", { width: 1080, height: 1920 })).toEqual({ width: 2160, height: 3840 });
  });
  it("squareCanvasScalesBothDimensions", () => {
    expect(exportResolutionRenderSize("720p", { width: 1080, height: 1080 })).toEqual({ width: 720, height: 720 });
  });
  it("resultDimensionsAreAlwaysEven", () => {
    const s = exportResolutionRenderSize("720p", { width: 1081, height: 1081 });
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
  });
  it("tightlyOddCanvasProducesEvenScaledOutput", () => {
    const s = exportResolutionRenderSize("720p", { width: 1921, height: 1080 });
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
  });
  it("zeroShortSideReturnsCanvasUntouched", () => {
    const canvas = { width: 1920, height: 0 };
    expect(exportResolutionRenderSize("1080p", canvas)).toEqual(canvas);
  });
  it("tinyCanvasClampsToMinimumOfTwo", () => {
    const s = exportResolutionRenderSize("720p", { width: 1, height: 1 });
    expect(s.width).toBeGreaterThanOrEqual(2);
    expect(s.height).toBeGreaterThanOrEqual(2);
  });
  it("matchTimelineRoundsToEven", () => {
    expect(exportResolutionRenderSize("Match Timeline", { width: 1081, height: 607 })).toEqual({ width: 1080, height: 606 });
  });
});

describe("codec mapping", () => {
  it("round trips format and codec", () => {
    for (const c of videoCodecs) expect(videoCodecFromFormat(videoCodecExportFormat(c))).toBe(c);
    expect(videoCodecFromFormat("xml")).toBeUndefined();
    expect(videoCodecContainer("VP9")).toBe("webm");
    expect(videoCodecContainer("H.265")).toBe("mp4");
  });
  it("estimates file size like the Swift table", () => {
    const t = { totalFrames: 300, fps: 30, width: 1920, height: 1080 };
    // 10 s * 0.63e6 B/s/MP * 2.0736 MP
    expect(exportEstimatedFileBytes("H.264", "Match Timeline", t)).toBe(Math.trunc(0.63e6 * 2.0736 * 10));
    expect(exportTargetVideoBitrate("H.264", { width: 1920, height: 1080 })).toBe(Math.round(0.63e6 * 2.0736 * 8));
  });
  it("formats file sizes", () => {
    expect(formatFileSize(0)).toBe("Zero KB");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(12_345_678)).toBe("12 MB");
    expect(formatFileSize(1_234_567)).toBe("1.2 MB");
  });
});

describe("validation", () => {
  const tl = { width: 1920, height: 1080, fps: 30, totalFrames: 100 };
  it("rejects empty timelines and bad ranges", () => {
    expect(validateVideoExport({ codec: "H.264", resolution: "1080p" }, tl).ok).toBe(true);
    expect(validateVideoExport({ codec: "H.264", resolution: "1080p" }, { ...tl, totalFrames: 0 }).ok).toBe(false);
    expect(validateVideoExport({ codec: "H.264", resolution: "1080p", range: { startFrame: 10, endFrame: 10 } }, tl).ok).toBe(false);
    expect(validateVideoExport({ codec: "H.264", resolution: "1080p", range: { startFrame: 100, endFrame: 120 } }, tl).ok).toBe(false);
  });
  it("clamps the range to the timeline", () => {
    expect(resolveExportRange({ range: { startFrame: 20, endFrame: 500 } }, 100)).toEqual({ startFrame: 20, endFrame: 100 });
    expect(resolveExportRange({}, 100)).toEqual({ startFrame: 0, endFrame: 100 });
  });
});
