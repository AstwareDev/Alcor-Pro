import { clipTypeIsVisual } from "../model/clipType";
import type { Clip, Timeline, Track } from "../model/timeline";
import type { Transition } from "../model/transition";
import { transitionIsAdjacent, transitionMaxFrames } from "./transitionMath";

export function trackHasTransitions(track: Track): boolean {
  return track.transitions !== undefined && track.transitions.length > 0;
}

export function documentHasTransitions(doc: { timelines: readonly Timeline[] }): boolean {
  for (const timeline of doc.timelines) for (const track of timeline.tracks) if (trackHasTransitions(track)) return true;
  return false;
}

function transitionIsValid(track: Track, t: Transition, clips: Map<string, Clip>, usedFrom: Set<string>, usedTo: Set<string>): boolean {
  if (!clipTypeIsVisual(track.type)) return false;
  const from = clips.get(t.fromClipId);
  const to = clips.get(t.toClipId);
  if (!from || !to || from.adjustment === true || to.adjustment === true) return false;
  if (!transitionIsAdjacent(from, to) || usedFrom.has(from.id) || usedTo.has(to.id)) return false;
  const max = transitionMaxFrames(t.alignment, from.durationFrames, to.durationFrames);
  if (max < 1) return false;
  usedFrom.add(from.id);
  usedTo.add(to.id);
  if (t.durationFrames > max) t.durationFrames = max;
  return true;
}

/**
 * Drops transitions whose clips are gone or no longer touch, and shortens ones the clips can no longer host.
 * Mutates in place (callers pass Immer drafts) and touches nothing when every transition is still valid.
 */
export function pruneTrackTransitions(track: Track): void {
  const list = track.transitions;
  if (!list) return;
  const clips = new Map<string, Clip>();
  for (const c of track.clips) clips.set(c.id, c);
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const kept = list.filter((t) => transitionIsValid(track, t, clips, usedFrom, usedTo));
  if (kept.length === list.length) return;
  if (kept.length === 0) delete track.transitions;
  else track.transitions = kept;
}

export function pruneDocumentTransitions(doc: { timelines: Timeline[] }): void {
  for (const timeline of doc.timelines) for (const track of timeline.tracks) if (trackHasTransitions(track)) pruneTrackTransitions(track);
}
