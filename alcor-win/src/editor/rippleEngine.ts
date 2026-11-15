import { clipEndFrame, timelineMarkerEndFrame, timelineMarkerIsRange, type Clip, type TimelineMarker } from "../model";

/** A proposed new start frame for a single clip, produced by the ripple engine and applied by the caller. */
export interface ClipShift {
  clipId: string;
  newStartFrame: number;
}

/** A half-open `[start, end)` frame interval on a single track. */
export interface FrameRange {
  start: number;
  end: number;
}

export function makeFrameRange(start: number, end: number): FrameRange {
  return { start, end };
}

export function frameRangeLength(r: FrameRange): number {
  return r.end - r.start;
}

/** A user-selected empty gap on a single track (the engine-level Swift GapSelection). */
export interface GapSelection {
  trackIndex: number;
  range: FrameRange;
}

function sortedByStart(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

/** After removing clips from a track, compute new start frames for remaining clips that close the gap. */
export function computeRippleShifts(clips: readonly Clip[], removedIds: ReadonlySet<string>): ClipShift[] {
  const removedRanges = clips
    .filter((c) => removedIds.has(c.id))
    .map((c) => makeFrameRange(c.startFrame, clipEndFrame(c)));
  return computeRippleShiftsForRanges(
    clips.filter((c) => !removedIds.has(c.id)),
    removedRanges,
  );
}

/** Shift clips leftward to close the gaps defined by `removedRanges`. */
export function computeRippleShiftsForRanges(clips: readonly Clip[], removedRanges: readonly FrameRange[]): ClipShift[] {
  const merged = mergeRanges(removedRanges);
  if (merged.length === 0) return [];

  const shifts: ClipShift[] = [];
  for (const clip of sortedByStart(clips)) {
    const shift = merged.filter((r) => r.end <= clip.startFrame).reduce((acc, r) => acc + frameRangeLength(r), 0);
    if (shift > 0) shifts.push({ clipId: clip.id, newStartFrame: clip.startFrame - shift });
  }
  return shifts;
}

/** Push all clips at or after `insertFrame` forward by `pushAmount` frames. */
export function computeRipplePush(
  clips: readonly Clip[],
  insertFrame: number,
  pushAmount: number,
  excludeIds: ReadonlySet<string> = new Set(),
): ClipShift[] {
  return clips
    .filter((c) => !excludeIds.has(c.id) && c.startFrame >= insertFrame)
    .map((c) => ({ clipId: c.id, newStartFrame: c.startFrame + pushAmount }));
}

/** Close removed spans. One range list per shifting track; remap only tracks that still hold the marker. */
export function rippleMarkersClosing(
  markers: readonly TimelineMarker[],
  trackRanges: readonly (readonly FrameRange[])[],
): TimelineMarker[] {
  const mergedTracks = trackRanges
    .map((ranges) => mergeRanges(ranges.filter((r) => frameRangeLength(r) > 0)))
    .filter((ranges) => ranges.length > 0);
  if (mergedTracks.length === 0) return markers.map(copyMarker);

  const result: TimelineMarker[] = [];
  for (const marker of markers) {
    const isRange = timelineMarkerIsRange(marker);
    const surviving: { start: number; end: number }[] = [];
    for (const ranges of mergedTracks) {
      const start = mapFrame(marker.startFrame, ranges);
      if (!isRange) {
        const removed = ranges.some((r) => r.start <= marker.startFrame && marker.startFrame < r.end);
        if (!removed) surviving.push({ start, end: start });
        continue;
      }
      const end = mapFrame(timelineMarkerEndFrame(marker), ranges);
      if (end > start) surviving.push({ start, end });
    }
    if (surviving.length === 0) continue;
    const next = copyMarker(marker);
    next.startFrame = Math.min(...surviving.map((s) => s.start));
    if (isRange) {
      const newEnd = Math.min(...surviving.map((s) => s.end));
      if (!(newEnd > next.startFrame)) continue;
      next.durationFrames = newEnd - next.startFrame;
    }
    result.push(next);
  }
  return result;
}

/** Open a gap at `insertFrame`. Negative `pushAmount` closes `[insertFrame + pushAmount, insertFrame)`. */
export function rippleMarkersOpening(
  markers: readonly TimelineMarker[],
  insertFrame: number,
  pushAmount: number,
): TimelineMarker[] {
  if (pushAmount === 0) return markers.map(copyMarker);
  if (pushAmount < 0) {
    return rippleMarkersClosing(markers, [[makeFrameRange(insertFrame + pushAmount, insertFrame)]]);
  }
  return markers.map((marker) => {
    const next = copyMarker(marker);
    if (next.startFrame >= insertFrame) {
      next.startFrame += pushAmount;
    } else if (timelineMarkerIsRange(next) && timelineMarkerEndFrame(next) > insertFrame) {
      next.durationFrames += pushAmount;
    }
    return next;
  });
}

// Markers are value copies so engine output never aliases document objects.
function copyMarker(m: TimelineMarker): TimelineMarker {
  return { ...m, color: { ...m.color } };
}

function mapFrame(frame: number, ranges: readonly FrameRange[]): number {
  let mapped = frame;
  for (const range of ranges) {
    if (range.end <= frame) mapped -= frameRangeLength(range);
    else if (range.start < frame) mapped -= frame - range.start;
  }
  return Math.max(0, mapped);
}

export function mergeRanges(ranges: readonly FrameRange[]): FrameRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: FrameRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      merged[merged.length - 1] = makeFrameRange(last.start, Math.max(last.end, range.end));
    } else {
      merged.push(range);
    }
  }
  return merged;
}
