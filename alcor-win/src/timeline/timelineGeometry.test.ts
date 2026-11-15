import { describe, expect, it } from "vitest";
import { Layout, type AnimatableProperty } from "../model";
import { fixtureClip } from "../model/fixtures";
import {
  clipRectFor,
  contentBottom,
  dropTargetAt,
  frameAt,
  insertionLineY,
  makeTimelineGeometry,
  rowLocationAt,
  timelineKeyframeLaneHeight,
  trackAt,
  trackHeightAt,
  trackYAt,
  xForFrame,
} from "./timelineGeometry";

// Three tracks of 50 each start at rulerHeight (28) + dropZoneHeight (32) = 60.
function geometry(pxPerFrame = 4, header = 0, lanes: AnimatableProperty[][] = []) {
  return makeTimelineGeometry({ pixelsPerFrame: pxPerFrame, headerWidth: header, trackHeights: [50, 50, 50], laneProperties: lanes });
}

describe("TimelineGeometry", () => {
  // MARK: - Frame <-> X

  it("frameAtAndXForFrameRoundtrip", () => {
    const g = geometry();
    expect(xForFrame(g, 100)).toBe(400);
    expect(frameAt(g, 400)).toBe(100);
  });

  it("xForFrameIncludesHeaderWidth", () => {
    const g = geometry(4, 100);
    expect(xForFrame(g, 50)).toBe(300);
    expect(frameAt(g, 300)).toBe(50);
  });

  it("frameAtBeforeHeaderClampsToZero", () => {
    const g = geometry(4, 100);
    expect(frameAt(g, 0)).toBe(0);
  });

  // MARK: - Track Y

  it("trackYReturnsCumulativeOffsets", () => {
    const g = geometry();
    expect(trackYAt(g, 0)).toBe(60);
    expect(trackYAt(g, 1)).toBe(110);
    expect(trackYAt(g, 2)).toBe(160);
  });

  it("trackYOutOfBoundsReturnsRulerHeight", () => {
    const g = geometry();
    expect(trackYAt(g, 99)).toBe(Layout.rulerHeight);
  });

  it("expandedLanesShiftFollowingTracksAndContentBottom", () => {
    const laneHeight = timelineKeyframeLaneHeight;
    const g = geometry(4, 0, [["position", "opacity"], [], ["volume"]]);

    expect(trackYAt(g, 0)).toBe(60);
    expect(trackYAt(g, 1)).toBe(110 + laneHeight * 2);
    expect(trackYAt(g, 2)).toBe(160 + laneHeight * 2);
    expect(contentBottom(g)).toBe(210 + laneHeight * 3);
  });

  it("rowLocationDistinguishesTrackAndPropertyLanes", () => {
    const g = geometry(4, 0, [["position", "opacity"], [], []]);
    const firstLaneY = trackYAt(g, 0) + trackHeightAt(g, 0);

    expect(rowLocationAt(g, trackYAt(g, 0) + 10)).toEqual({ kind: "track", index: 0 });
    expect(rowLocationAt(g, firstLaneY + 2)).toEqual({ kind: "keyframeLane", trackIndex: 0, property: "position" });
    expect(rowLocationAt(g, firstLaneY + timelineKeyframeLaneHeight + 2)).toEqual({
      kind: "keyframeLane",
      trackIndex: 0,
      property: "opacity",
    });
  });

  // MARK: - Clip rect

  it("clipRectInsetsTwoPxTopAndBottom", () => {
    const g = geometry();
    const clip = fixtureClip({ start: 100, duration: 50 });
    const rect = clipRectFor(g, clip, 0);
    // x = 100*4 = 400. y = 60 + 2 = 62. w = 50*4 = 200. h = 50 - 4 = 46.
    expect(rect.x).toBe(400);
    expect(rect.y).toBe(62);
    expect(rect.width).toBe(200);
    expect(rect.height).toBe(46);
  });

  // MARK: - trackAt

  it("trackAtReturnsCorrectTrackIndex", () => {
    const g = geometry();
    expect(trackAt(g, 100)).toBe(0);
    expect(trackAt(g, 140)).toBe(1);
    expect(trackAt(g, 200)).toBe(2);
  });

  it("trackAtBelowLastTrackClampsToLast", () => {
    const g = geometry();
    expect(trackAt(g, 1000)).toBe(2);
  });

  // MARK: - dropTargetAt

  it("dropTargetAboveFirstTrackIsNewTrackAtZero", () => {
    expect(dropTargetAt(geometry(), 50)).toEqual({ kind: "newTrackAt", index: 0 });
  });

  it("dropTargetBetweenTracksWithinThresholdIsNewTrack", () => {
    const g = geometry();
    expect(dropTargetAt(g, 106)).toEqual({ kind: "newTrackAt", index: 1 });
    expect(dropTargetAt(g, 110)).toEqual({ kind: "newTrackAt", index: 1 });
  });

  it("dropTargetOnExistingTrackBodyIsExistingTrack", () => {
    const g = geometry();
    expect(dropTargetAt(g, 90)).toEqual({ kind: "existingTrack", index: 0 });
    expect(dropTargetAt(g, 200)).toEqual({ kind: "existingTrack", index: 2 });
  });

  it("dropTargetOnExpandedLaneTargetsOwningTrack", () => {
    const g = geometry(4, 0, [["position", "opacity"], [], []]);
    const y = trackYAt(g, 0) + trackHeightAt(g, 0) + 2;
    expect(dropTargetAt(g, y)).toEqual({ kind: "existingTrack", index: 0 });
  });

  it("dropTargetBelowLastTrackIsNewTrackAtCount", () => {
    expect(dropTargetAt(geometry(), 250)).toEqual({ kind: "newTrackAt", index: 3 });
  });

  it("dropTargetWithEmptyTimelineIsNewTrackAtZero", () => {
    const g = makeTimelineGeometry({ pixelsPerFrame: 4, trackHeights: [] });
    expect(dropTargetAt(g, 100)).toEqual({ kind: "newTrackAt", index: 0 });
  });

  // MARK: - insertionLineY

  it("insertionLineYIsNilForExistingTrack", () => {
    expect(insertionLineY(geometry(), { kind: "existingTrack", index: 1 })).toBeUndefined();
  });

  it("insertionLineYAtTopReturnsFirstCumulative", () => {
    expect(insertionLineY(geometry(), { kind: "newTrackAt", index: 0 })).toBe(60);
  });

  it("insertionLineYBetweenTracksReturnsBoundary", () => {
    const g = geometry();
    expect(insertionLineY(g, { kind: "newTrackAt", index: 1 })).toBe(110);
    expect(insertionLineY(g, { kind: "newTrackAt", index: 2 })).toBe(160);
  });

  it("insertionLineYAtBottomReturnsLastBottom", () => {
    expect(insertionLineY(geometry(), { kind: "newTrackAt", index: 3 })).toBe(210);
  });
});
