import { describe, expect, it } from "vitest";
import { TrackSize } from "../../model";
import { makeTimelineGeometry } from "../timelineGeometry";
import { clampedHeaderWidth, resizeHandleTrackAt, resizedTrackHeight, trackHeaderLayout } from "./headerLayout";

const geometry = makeTimelineGeometry({ pixelsPerFrame: 4, trackHeights: [44, 60] });

describe("Timeline header layout", () => {
  it("placesControlsRightToLeftWithFourPointGaps", () => {
    const l = trackHeaderLayout(geometry, 0, 160);
    expect(l.visibility.x).toBe(160 - 14 - 6);
    expect(l.sync.x).toBe(l.visibility.x - 18);
    expect(l.keyframe.x).toBe(l.sync.x - 18);
    expect(l.grip.x).toBe(9);
    expect(l.label.x).toBe(29);
    expect(l.label.width).toBe(l.keyframe.x - 4 - 29);
    expect(l.grip.y).toBe(60 + (44 - 14) / 2);
  });

  it("secondTrackFollowsFirst", () => {
    const l = trackHeaderLayout(geometry, 1, 200);
    expect(l.row).toEqual({ x: 0, y: 104, width: 200, height: 60 });
    expect(l.label.height).toBe(22);
  });

  it("resizeHandleSitsOnTrackBottom", () => {
    expect(resizeHandleTrackAt(geometry, 104)).toBe(0);
    expect(resizeHandleTrackAt(geometry, 98)).toBe(0);
    expect(resizeHandleTrackAt(geometry, 90)).toBeUndefined();
    expect(resizeHandleTrackAt(geometry, 164)).toBe(1);
  });

  it("resizeClampsToTrackSize", () => {
    expect(resizedTrackHeight(geometry, 0, 70, 0, 24)).toBe(TrackSize.minHeight);
    expect(resizedTrackHeight(geometry, 0, 1000, 0, 24)).toBe(TrackSize.maxHeight);
    expect(resizedTrackHeight(geometry, 0, 160, 1, 24)).toBe(76);
  });

  it("headerWidthClampsAndWidensForKeyframeLanes", () => {
    expect(clampedHeaderWidth(50, false)).toBe(112);
    expect(clampedHeaderWidth(500, false)).toBe(320);
    expect(clampedHeaderWidth(150, true)).toBe(220);
  });
});
