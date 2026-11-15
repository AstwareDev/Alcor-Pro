import {
  Layout,
  Trim,
  animatablePropertyLanes,
  type AnimatableProperty,
  type Clip,
  type FadeEdge,
  type Point,
  type Rect,
  type Timeline,
} from "../model";
import { laneStateIsExpanded, type TimelineKeyframeLaneState } from "./timelineKeyframeLaneState";

// AppTheme.ComponentSize / Spacing values used by the timeline layout.
export const timelineKeyframeLaneHeight = 24;
export const timelineKeyframeHitSize = 14;
const spacingXxs = 2;

// Pure layout constants and maths of ClipRenderer used for hit testing.
export const ClipRendererMetrics = {
  labelBarHeight: 16,
  volumeKeyframeHitSize: 14,
  volumeFadeHandleEdgeInset: Trim.handleWidth + 14 / 2 + spacingXxs,
  volumeRubberBandTopDb: 6,
  volumeRubberBandBottomDb: -60,
  fadeKneeTopInset: 4,
} as const;

/** The clip card's body area below the label bar. */
export function clipBodyRect(clipRect: Rect): Rect {
  return {
    x: clipRect.x,
    y: clipRect.y + ClipRendererMetrics.labelBarHeight,
    width: clipRect.width,
    height: Math.max(0, clipRect.height - ClipRendererMetrics.labelBarHeight - 1),
  };
}

export function fadeKneeY(body: Rect): number {
  return body.y + ClipRendererMetrics.fadeKneeTopInset;
}

/** Y axis is flipped: high dB gives smaller Y. */
export function yForDb(db: number, body: Rect): number {
  const top = ClipRendererMetrics.volumeRubberBandTopDb;
  const bottom = ClipRendererMetrics.volumeRubberBandBottomDb;
  const clamped = Math.min(top, Math.max(bottom, db));
  const frac = (top - clamped) / (top - bottom);
  return body.y + frac * body.height;
}

export function dbForY(y: number, body: Rect): number {
  if (!(body.height > 0)) return 0;
  const frac = Math.max(0, Math.min(1, (y - body.y) / body.height));
  return ClipRendererMetrics.volumeRubberBandTopDb - frac * (ClipRendererMetrics.volumeRubberBandTopDb - ClipRendererMetrics.volumeRubberBandBottomDb);
}

export function fadeHandleRenderX(clipRect: Rect, kfOffset: number, pxPerFrame: number): number {
  const actual = clipRect.x + kfOffset * pxPerFrame;
  const edgeInset = Math.min(ClipRendererMetrics.volumeFadeHandleEdgeInset, Math.max(0, clipRect.width / 2));
  return Math.min(clipRect.x + clipRect.width - edgeInset, Math.max(clipRect.x + edgeInset, actual));
}

/** NSRect.contains(point): min edges inclusive, max edges exclusive. */
export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

export type TrackDropTarget = { kind: "existingTrack"; index: number } | { kind: "newTrackAt"; index: number };

export type TimelineRowLocation =
  | { kind: "track"; index: number }
  | { kind: "keyframeLane"; trackIndex: number; property: AnimatableProperty };

export function trackDropTargetEquals(a: TrackDropTarget, b: TrackDropTarget): boolean {
  return a.kind === b.kind && a.index === b.index;
}

/** Pure layout math for the timeline. Used by both drawing and hit testing. */
export interface TimelineGeometry {
  readonly pixelsPerFrame: number;
  readonly headerWidth: number;
  readonly trackHeights: readonly number[];
  readonly laneProperties: readonly (readonly AnimatableProperty[])[];
  readonly bounds: Rect;
  /** Precomputed cumulative Y offsets for each track. */
  readonly cumulativeY: readonly number[];
  readonly blockBottoms: readonly number[];
}

export function makeTimelineGeometry(p: {
  pixelsPerFrame: number;
  headerWidth?: number;
  trackHeights: readonly number[];
  laneProperties?: readonly (readonly AnimatableProperty[])[];
  bounds?: Rect;
}): TimelineGeometry {
  const input = p.laneProperties ?? [];
  const laneProperties = p.trackHeights.map((_, index) => input[index] ?? []);
  const cumulativeY: number[] = [];
  const blockBottoms: number[] = [];
  let y = Layout.rulerHeight + Layout.dropZoneHeight;
  p.trackHeights.forEach((h, index) => {
    cumulativeY.push(y);
    y += h + (laneProperties[index] as readonly AnimatableProperty[]).length * timelineKeyframeLaneHeight;
    blockBottoms.push(y);
  });
  return {
    pixelsPerFrame: p.pixelsPerFrame,
    headerWidth: p.headerWidth ?? 0,
    trackHeights: p.trackHeights,
    laneProperties,
    bounds: p.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
    cumulativeY,
    blockBottoms,
  };
}

/** Swift `init(editor:bounds:headerWidth:laneState:)`. */
export function makeTimelineGeometryForTimeline(p: {
  timeline: Timeline;
  zoomScale: number;
  bounds: Rect;
  headerWidth?: number;
  laneState?: TimelineKeyframeLaneState;
}): TimelineGeometry {
  const { timeline, laneState } = p;
  return makeTimelineGeometry({
    pixelsPerFrame: p.zoomScale,
    headerWidth: p.headerWidth ?? 0,
    trackHeights: timeline.tracks.map((t) => t.displayHeight),
    laneProperties: timeline.tracks.map((t) =>
      laneState && laneStateIsExpanded(laneState, t.id) ? animatablePropertyLanes(t) : [],
    ),
    bounds: p.bounds,
  });
}

export function timelineGeometryRulerHeight(_g: TimelineGeometry): number {
  return Layout.rulerHeight;
}

export function timelineGeometryTrackCount(g: TimelineGeometry): number {
  return g.trackHeights.length;
}

export function trackHeightAt(g: TimelineGeometry, index: number): number {
  return g.trackHeights[index] ?? Layout.trackHeight;
}

export function trackYAt(g: TimelineGeometry, index: number): number {
  return g.cumulativeY[index] ?? Layout.rulerHeight;
}

export function trackBlockBottomAt(g: TimelineGeometry, index: number): number {
  return g.blockBottoms[index] ?? trackYAt(g, index) + trackHeightAt(g, index);
}

export function contentBottom(g: TimelineGeometry): number {
  return g.blockBottoms[g.blockBottoms.length - 1] ?? Layout.rulerHeight + Layout.dropZoneHeight;
}

export function laneY(g: TimelineGeometry, trackIndex: number, property: AnimatableProperty): number | undefined {
  const lanes = g.laneProperties[trackIndex];
  if (!lanes) return undefined;
  const laneIndex = lanes.indexOf(property);
  if (laneIndex < 0) return undefined;
  return trackYAt(g, trackIndex) + trackHeightAt(g, trackIndex) + laneIndex * timelineKeyframeLaneHeight;
}

export function laneRect(g: TimelineGeometry, trackIndex: number, property: AnimatableProperty): Rect | undefined {
  const y = laneY(g, trackIndex, property);
  if (y === undefined) return undefined;
  return { x: 0, y, width: g.bounds.width, height: timelineKeyframeLaneHeight };
}

/** Clip rect at an arbitrary Y position (used for ghost clips at insertion lines). */
export function clipRectAtY(g: TimelineGeometry, clip: Clip, y: number, height: number): Rect {
  return {
    x: g.headerWidth + clip.startFrame * g.pixelsPerFrame,
    y: y + 2,
    width: clip.durationFrames * g.pixelsPerFrame,
    height: height - 4,
  };
}

export function clipRectFor(g: TimelineGeometry, clip: Clip, trackIndex: number): Rect {
  return clipRectAtY(g, clip, trackYAt(g, trackIndex), trackHeightAt(g, trackIndex));
}

export function frameAt(g: TimelineGeometry, x: number): number {
  return Math.max(0, Math.trunc((x - g.headerWidth) / g.pixelsPerFrame));
}

export function trackAt(g: TimelineGeometry, y: number): number {
  const i = g.blockBottoms.findIndex((b) => y < b);
  return i >= 0 ? i : Math.max(0, timelineGeometryTrackCount(g) - 1);
}

export function rowLocationAt(g: TimelineGeometry, y: number): TimelineRowLocation | undefined {
  const trackIndex = g.cumulativeY.findIndex((top, i) => y >= top && y < (g.blockBottoms[i] as number));
  if (trackIndex < 0) return undefined;
  const laneStart = (g.cumulativeY[trackIndex] as number) + (g.trackHeights[trackIndex] as number);
  if (y < laneStart) return { kind: "track", index: trackIndex };
  const laneIndex = Math.trunc((y - laneStart) / timelineKeyframeLaneHeight);
  const lanes = g.laneProperties[trackIndex] as readonly AnimatableProperty[];
  const property = lanes[laneIndex];
  if (property === undefined) return { kind: "track", index: trackIndex };
  return { kind: "keyframeLane", trackIndex, property };
}

export function dropTargetAt(g: TimelineGeometry, y: number): TrackDropTarget {
  const trackCount = timelineGeometryTrackCount(g);
  if (trackCount <= 0) return { kind: "newTrackAt", index: 0 };

  if (y < (g.cumulativeY[0] as number)) return { kind: "newTrackAt", index: 0 };

  const threshold = Layout.insertThreshold;
  for (let i = 0; i < trackCount - 1; i++) {
    const bottomOfTrack = g.blockBottoms[i] as number;
    const topOfNext = g.cumulativeY[i + 1] as number;
    if (y >= bottomOfTrack - threshold && y <= topOfNext + threshold) return { kind: "newTrackAt", index: i + 1 };
  }

  const lastTrackBottom = g.blockBottoms[trackCount - 1] as number;
  if (y >= lastTrackBottom) return { kind: "newTrackAt", index: trackCount };

  return { kind: "existingTrack", index: trackAt(g, y) };
}

export function insertionLineY(g: TimelineGeometry, target: TrackDropTarget): number | undefined {
  if (target.kind === "existingTrack") return undefined;
  const trackCount = timelineGeometryTrackCount(g);
  const index = target.index;
  if (trackCount === 0) return Layout.rulerHeight + Layout.dropZoneHeight;
  if (index === 0) return g.cumulativeY[0];
  if (index >= trackCount) return g.blockBottoms[trackCount - 1];
  return g.cumulativeY[index];
}

/** Y position where a ghost clip should render for a new-track drop. */
export function ghostY(g: TimelineGeometry, target: TrackDropTarget, height: number = Layout.trackHeight): number | undefined {
  if (target.kind !== "newTrackAt") return undefined;
  const lineY = insertionLineY(g, target);
  if (lineY === undefined) return undefined;
  return target.index < timelineGeometryTrackCount(g) ? lineY - height : lineY;
}

export function xForFrame(g: TimelineGeometry, frame: number): number {
  return g.headerWidth + frame * g.pixelsPerFrame;
}

/** Interior keyframe hit point: just pxPerFrame placement, no edge insetting. */
export function audioVolumeKfPoint(clip: Clip, kfOffset: number, kfDb: number, clipRect: Rect): Point {
  const body = clipBodyRect(clipRect);
  const pxPerFrame = clip.durationFrames > 0 ? clipRect.width / clip.durationFrames : 0;
  return { x: clipRect.x + kfOffset * pxPerFrame, y: yForDb(kfDb, body) };
}

export function audioVolumeKfRect(clip: Clip, kfOffset: number, kfDb: number, clipRect: Rect): Rect {
  const p = audioVolumeKfPoint(clip, kfOffset, kfDb, clipRect);
  const half = ClipRendererMetrics.volumeKeyframeHitSize / 2;
  return { x: p.x - half, y: p.y - half, width: half * 2, height: half * 2 };
}

/** Hit rect for a fade knee, in the fixed fade lane near the top of the body. */
export function fadeKneeRect(clip: Clip, edge: FadeEdge, clipRect: Rect): Rect {
  const body = clipBodyRect(clipRect);
  const pxPerFrame = clip.durationFrames > 0 ? clipRect.width / clip.durationFrames : 0;
  const kfOffset =
    edge === "left"
      ? Math.min(clip.fadeInFrames, clip.durationFrames)
      : Math.max(0, clip.durationFrames - clip.fadeOutFrames);
  const x = fadeHandleRenderX(clipRect, kfOffset, pxPerFrame);
  const y = fadeKneeY(body);
  const half = ClipRendererMetrics.volumeKeyframeHitSize / 2;
  return { x: x - half, y: y - half, width: half * 2, height: half * 2 };
}
