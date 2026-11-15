import { describe, expect, it } from "vitest";
import {
  keepValidTimelineRangeOrClear,
  makeTimelineRange,
  markTimelineRangeEnd,
  markTimelineRangeStart,
  timelineRangeContains,
  timelineRangeIsValid,
  timelineRangeNormalized,
  validSelectedTimelineRange,
} from "./timelineRangeSelection";

describe("Timeline range selection", () => {
  it("normalizesReversedRanges", () => {
    const range = timelineRangeNormalized({ startFrame: 90, endFrame: 30 });

    expect(range.startFrame).toBe(30);
    expect(range.endFrame).toBe(90);
    expect(timelineRangeIsValid(range)).toBe(true);
  });

  it("containsUsesHalfOpenBounds", () => {
    const range = { startFrame: 30, endFrame: 90 };

    expect(timelineRangeContains(range, 30)).toBe(true);
    expect(timelineRangeContains(range, 89)).toBe(true);
    expect(timelineRangeContains(range, 90)).toBe(false);
  });
});

describe("EditorViewModel - timeline range", () => {
  it("markStartAndEndUsePlayhead", () => {
    let selected = markTimelineRangeStart(null, 30);
    selected = markTimelineRangeEnd(selected, 90);

    expect(selected).toEqual({ startFrame: 30, endFrame: 90 });
  });

  it("invalidRangeClearsOnCommit", () => {
    const selected = makeTimelineRange(30, 30);

    expect(keepValidTimelineRangeOrClear(selected)).toBeNull();
  });

  it("validSelectedTimelineRangeNormalizesAndRejectsInvalidRanges", () => {
    expect(validSelectedTimelineRange(makeTimelineRange(90, 30))).toEqual({ startFrame: 30, endFrame: 90 });
    expect(validSelectedTimelineRange(makeTimelineRange(30, 30))).toBeNull();
  });
});
