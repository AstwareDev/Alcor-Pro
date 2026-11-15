export interface TimelineRangeSelection {
  startFrame: number;
  endFrame: number;
}

export function timelineRangeNormalized(r: TimelineRangeSelection): TimelineRangeSelection {
  return r.startFrame <= r.endFrame ? r : { startFrame: r.endFrame, endFrame: r.startFrame };
}

export function timelineRangeIsValid(r: TimelineRangeSelection): boolean {
  const range = timelineRangeNormalized(r);
  return range.endFrame > range.startFrame;
}

export function timelineRangeContains(r: TimelineRangeSelection, frame: number): boolean {
  const range = timelineRangeNormalized(r);
  return frame >= range.startFrame && frame < range.endFrame;
}

// Pure parts of EditorViewModel+TimelineRange.swift; the editor stores the result in `ui.selectedTimelineRange`.

export function validSelectedTimelineRange(selected: TimelineRangeSelection | null): TimelineRangeSelection | null {
  if (!selected) return null;
  const range = timelineRangeNormalized(selected);
  return timelineRangeIsValid(range) ? range : null;
}

/** Swift `setTimelineRange`: both ends clamp to >= 0. */
export function makeTimelineRange(startFrame: number, endFrame: number): TimelineRangeSelection {
  return { startFrame: Math.max(0, startFrame), endFrame: Math.max(0, endFrame) };
}

export function markTimelineRangeStart(current: TimelineRangeSelection | null, frame: number): TimelineRangeSelection {
  const start = Math.max(0, frame);
  return makeTimelineRange(start, current?.endFrame ?? start);
}

export function markTimelineRangeEnd(current: TimelineRangeSelection | null, frame: number): TimelineRangeSelection {
  const end = Math.max(0, frame);
  return makeTimelineRange(current?.startFrame ?? end, end);
}

/** Swift `keepValidTimelineRangeOrClear`: returns the new stored selection. */
export function keepValidTimelineRangeOrClear(current: TimelineRangeSelection | null): TimelineRangeSelection | null {
  return validSelectedTimelineRange(current);
}
