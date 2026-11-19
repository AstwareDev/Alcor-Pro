import { describe, expect, it } from "vitest";
import { clipTypes } from "../model/clipType";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { decodeProjectFile, makeProjectFile } from "../model/projectFile";
import { lottieFrameIndex, lottieRasterSize, lottieSampleTimes } from "./lottieFrames";

describe("lottieFrameIndex", () => {
  // 60 frames over 2 s = 30 fps
  it("maps seconds to the frame whose interval contains them", () => {
    expect(lottieFrameIndex(0, 60, 2)).toBe(0);
    expect(lottieFrameIndex(1 / 30 - 0.001, 60, 2)).toBe(0);
    expect(lottieFrameIndex(1 / 30, 60, 2)).toBe(1);
    expect(lottieFrameIndex(1, 60, 2)).toBe(30);
  });

  it("absorbs float error at exact frame boundaries", () => {
    expect(lottieFrameIndex(0.1 * 3, 60, 2)).toBe(9);
    expect(lottieFrameIndex(29 / 30, 60, 2)).toBe(29);
  });

  it("clamps to the first and last frame", () => {
    expect(lottieFrameIndex(-1, 60, 2)).toBe(0);
    expect(lottieFrameIndex(2, 60, 2)).toBe(59);
    expect(lottieFrameIndex(99, 60, 2)).toBe(59);
  });

  it("returns 0 for degenerate animations", () => {
    expect(lottieFrameIndex(1, 0, 2)).toBe(0);
    expect(lottieFrameIndex(1, 60, 0)).toBe(0);
  });
});

describe("lottieSampleTimes", () => {
  it("samples the middle of evenly sized slices", () => {
    expect(lottieSampleTimes(2, 4)).toEqual([0.25, 0.75, 1.25, 1.75]);
    expect(lottieSampleTimes(3, 1)).toEqual([1.5]);
  });
});

describe("lottieRasterSize", () => {
  it("keeps small animations and scales large ones down by the longest edge", () => {
    expect(lottieRasterSize(512, 256)).toEqual({ width: 512, height: 256 });
    expect(lottieRasterSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(lottieRasterSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe("lottie project compatibility", () => {
  it("uses the Swift ClipType raw value", () => {
    expect(clipTypes).toContain("lottie");
  });

  it("round-trips a lottie clip through the project file", () => {
    const clip = fixtureClip({ mediaType: "lottie", start: 5, duration: 60 });
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] });
    const file = makeProjectFile({ timelines: [t], activeTimelineId: t.id, openTimelineIds: [t.id] });
    const text = JSON.stringify(file);
    expect(text).toContain('"mediaType":"lottie"');
    const decoded = decodeProjectFile(JSON.parse(text) as unknown);
    const back = decoded.timelines[0]?.tracks[0]?.clips[0];
    expect(back?.mediaType).toBe("lottie");
    expect(back?.startFrame).toBe(5);
    expect(back?.durationFrames).toBe(60);
  });
});
