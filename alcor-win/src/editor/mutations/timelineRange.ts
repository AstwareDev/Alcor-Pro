import type { Editor, TimelineRangeSelection } from "../editor";

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

export function validSelectedTimelineRange(editor: Editor): TimelineRangeSelection | null {
  const selected = editor.ui.selectedTimelineRange;
  if (!selected) return null;
  const range = timelineRangeNormalized(selected);
  return timelineRangeIsValid(range) ? range : null;
}

export function markTimelineRangeStart(editor: Editor, frame?: number): void {
  const start = Math.max(0, frame ?? editor.ui.currentFrame);
  setTimelineRange(editor, start, editor.ui.selectedTimelineRange?.endFrame ?? start);
}

export function markTimelineRangeEnd(editor: Editor, frame?: number): void {
  const end = Math.max(0, frame ?? editor.ui.currentFrame);
  setTimelineRange(editor, editor.ui.selectedTimelineRange?.startFrame ?? end, end);
}

export function setTimelineRange(editor: Editor, startFrame: number, endFrame: number): void {
  editor.ui.selectedTimelineMarkerIds = new Set();
  editor.ui.selectedTimelineRange = { startFrame: Math.max(0, startFrame), endFrame: Math.max(0, endFrame) };
}

export function keepValidTimelineRangeOrClear(editor: Editor): void {
  const range = validSelectedTimelineRange(editor);
  editor.ui.selectedTimelineRange = range;
}

export function clearTimelineRange(editor: Editor): void {
  editor.ui.selectedTimelineRange = null;
}
