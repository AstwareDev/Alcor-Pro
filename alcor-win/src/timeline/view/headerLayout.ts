import { TrackSize, type Rect } from "../../model";
import { trackBlockBottomAt, trackHeightAt, trackYAt, type TimelineGeometry } from "../timelineGeometry";

// Control placement of TimelineHeaderView.draw (y in document space, x from the header's left edge).

export const HeaderMetrics = {
  stripWidth: 3,
  reorderInset: 9,
  iconSize: 14,
  hitInset: 4,
  fieldMinHeight: 22,
  minimumWidth: 112,
  maximumWidth: 320,
  defaultWidth: 160,
  keyframeMinimumWidth: 220,
} as const;

export interface TrackHeaderLayout {
  row: Rect;
  grip: Rect;
  label: Rect;
  keyframe: Rect;
  sync: Rect;
  /** Mute for audio tracks, hide for visual tracks. */
  visibility: Rect;
}

export function trackHeaderLayout(geometry: TimelineGeometry, trackIndex: number, headerWidth: number): TrackHeaderLayout {
  const { iconSize, reorderInset } = HeaderMetrics;
  const y = trackYAt(geometry, trackIndex);
  const h = trackHeightAt(geometry, trackIndex);
  const iconY = y + (h - iconSize) / 2;
  const rightmostX = headerWidth - iconSize - 6;
  const syncX = rightmostX - iconSize - 4;
  const keyframeX = syncX - iconSize - 4;
  const labelX = reorderInset + iconSize + 6;
  const labelHeight = Math.min(Math.max(0, h - 8), HeaderMetrics.fieldMinHeight);
  const icon = (x: number): Rect => ({ x, y: iconY, width: iconSize, height: iconSize });
  return {
    row: { x: 0, y, width: headerWidth, height: h },
    grip: icon(reorderInset),
    label: { x: labelX, y: y + (h - labelHeight) / 2, width: Math.max(0, keyframeX - 4 - labelX), height: labelHeight },
    keyframe: icon(keyframeX),
    sync: icon(syncX),
    visibility: icon(rightmostX),
  };
}

/** Icons hit-test on their rect padded by 4 px (`insetBy(dx: -4, dy: -4)`). */
export function paddedHitRect(r: Rect): Rect {
  const i = HeaderMetrics.hitInset;
  return { x: r.x - i, y: r.y - i, width: r.width + 2 * i, height: r.height + 2 * i };
}

/** Track whose block bottom (track + its lanes) is within the resize zone of `y`. */
export function resizeHandleTrackAt(geometry: TimelineGeometry, y: number): number | undefined {
  for (let i = 0; i < geometry.trackHeights.length; i++) {
    if (Math.abs(y - trackBlockBottomAt(geometry, i)) <= TrackSize.resizeHandleZone) return i;
  }
  return undefined;
}

/** New display height while dragging a track's bottom edge, clamped to TrackSize. */
export function resizedTrackHeight(geometry: TimelineGeometry, trackIndex: number, pointerY: number, laneCount: number, laneHeight: number): number {
  const top = trackYAt(geometry, trackIndex);
  return Math.max(TrackSize.minHeight, Math.min(TrackSize.maxHeight, pointerY - top - laneCount * laneHeight));
}

export function clampedHeaderWidth(requested: number, hasExpandedLanes: boolean): number {
  const min = hasExpandedLanes ? HeaderMetrics.keyframeMinimumWidth : HeaderMetrics.minimumWidth;
  return Math.min(HeaderMetrics.maximumWidth, Math.max(min, requested));
}
