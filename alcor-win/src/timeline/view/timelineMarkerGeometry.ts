import { timelineMarkerEndFrame, timelineMarkerIsRange, type Point, type Rect, type TimelineMarker } from "../../model";
import { rectContains, xForFrame, type TimelineGeometry } from "../timelineGeometry";

// Pure geometry of TimelineMarkerRenderer: flag shapes, hit testing and marquee intersection.

export const MarkerMetrics = {
  flagWidth: 10,
  flagHeight: 12,
  rangeBarHeight: 4,
  hitSlop: 3,
} as const;

export type MarkerHalf = "start" | "end";

/** NSRect.intersects: true only for a positive-area overlap. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Flag polygon (pointing down) inside `rect`; a range marker draws its start and end halves. */
export function markerPathPoints(rect: Rect, half?: MarkerHalf): Point[] {
  const minX = rect.x;
  const maxX = rect.x + rect.width;
  const minY = rect.y;
  const maxY = rect.y + rect.height;
  const mid = rect.x + rect.width / 2;
  const tip = { x: mid, y: maxY };
  const shoulder = maxY - rect.width / 2;
  switch (half) {
    case "start":
      return [{ x: minX, y: minY }, { x: mid, y: minY }, tip, { x: minX, y: shoulder }];
    case "end":
      return [{ x: mid, y: minY }, { x: maxX, y: minY }, { x: maxX, y: shoulder }, tip];
    default:
      return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: shoulder }, tip, { x: minX, y: shoulder }];
  }
}

export function markerFlagRect(marker: TimelineMarker, geometry: TimelineGeometry, rulerMinY: number): Rect {
  return {
    x: xForFrame(geometry, marker.startFrame) - MarkerMetrics.flagWidth / 2,
    y: rulerMinY,
    width: MarkerMetrics.flagWidth,
    height: MarkerMetrics.flagHeight,
  };
}

function endpointRects(marker: TimelineMarker, geometry: TimelineGeometry, rulerMinY: number): Rect[] {
  const flag = markerFlagRect(marker, geometry, rulerMinY);
  const rects = timelineMarkerIsRange(marker)
    ? [
        { x: flag.x, y: flag.y, width: flag.width / 2, height: flag.height },
        { x: xForFrame(geometry, timelineMarkerEndFrame(marker)), y: flag.y, width: flag.width / 2, height: flag.height },
      ]
    : [flag];
  const s = MarkerMetrics.hitSlop;
  return rects.map((r) => ({ x: r.x - s, y: r.y - s, width: r.width + 2 * s, height: r.height + 2 * s }));
}

/** Topmost (last drawn) marker whose flag is under `point`. */
export function markerAt(
  point: Point,
  markers: readonly TimelineMarker[],
  geometry: TimelineGeometry,
  rulerMinY: number,
): TimelineMarker | undefined {
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i] as TimelineMarker;
    if (endpointRects(m, geometry, rulerMinY).some((r) => rectContains(r, point))) return m;
  }
  return undefined;
}

export function markerIdsIntersecting(
  selection: Rect,
  markers: readonly TimelineMarker[],
  geometry: TimelineGeometry,
  rulerMinY: number,
): Set<string> {
  const ids = new Set<string>();
  for (const m of markers) {
    if (endpointRects(m, geometry, rulerMinY).some((r) => rectsIntersect(r, selection))) ids.add(m.id);
  }
  return ids;
}
