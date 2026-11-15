import { animatablePropertyLanes, type Track } from "../model";

/** Which tracks have their keyframe lanes expanded. Callers drive re-render through `onChange`. */
export interface TimelineKeyframeLaneState {
  expandedTrackIds: Set<string>;
  revision: number;
  onChange?: () => void;
  timelineId?: string;
  eligibilityRevision?: number;
}

export function makeTimelineKeyframeLaneState(): TimelineKeyframeLaneState {
  return { expandedTrackIds: new Set(), revision: 0 };
}

export function laneStateIsExpanded(s: TimelineKeyframeLaneState, trackId: string): boolean {
  return s.expandedTrackIds.has(trackId);
}

function notifyChange(s: TimelineKeyframeLaneState): void {
  s.revision = (s.revision + 1) | 0;
  s.onChange?.();
}

export function laneStateUpdate(
  s: TimelineKeyframeLaneState,
  timelineId: string,
  revision: number,
  tracks: readonly Track[],
): void {
  if (s.timelineId !== timelineId) {
    s.timelineId = timelineId;
    s.eligibilityRevision = revision;
    laneStateReset(s);
    return;
  }
  if (s.eligibilityRevision === revision) return;
  s.eligibilityRevision = revision;
  laneStatePrune(s, new Set(tracks.filter((t) => animatablePropertyLanes(t).length > 0).map((t) => t.id)));
}

export function laneStateToggle(s: TimelineKeyframeLaneState, trackId: string): void {
  if (!s.expandedTrackIds.delete(trackId)) s.expandedTrackIds.add(trackId);
  notifyChange(s);
}

export function laneStatePrune(s: TimelineKeyframeLaneState, validTrackIds: ReadonlySet<string>): void {
  const next = new Set([...s.expandedTrackIds].filter((id) => validTrackIds.has(id)));
  if (next.size === s.expandedTrackIds.size) return;
  s.expandedTrackIds = next;
  notifyChange(s);
}

export function laneStateReset(s: TimelineKeyframeLaneState): void {
  if (s.expandedTrackIds.size === 0) return;
  s.expandedTrackIds.clear();
  notifyChange(s);
}
