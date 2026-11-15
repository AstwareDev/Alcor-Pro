import {
  TrackSize,
  clipTypeTrackLabelPrefix,
  makeTrack,
  trackNameNormalized,
  type ClipType,
  type Timeline,
} from "../../model";
import type { Editor } from "../editor";
import { commitTimelineSwap, removeWhere } from "./core";
import { zones } from "./linking";
import { multicamGroupOf } from "./multicamRules";

// MARK: - Add / remove

/** Inserts an empty track, clamped to its type zone. Returns the index actually used. */
export function insertTrack(editor: Editor, index: number, type: ClipType): number {
  const clamped = partitionedInsertionIndex(editor, type, index);
  const track = makeTrack({ type });
  editor.perform("Add Track", () => {
    editor.timeline.tracks.splice(clamped, 0, track);
  });
  return clamped;
}

/** "V1", "A1", "I1" label for the track at the given index. */
export function timelineTrackDisplayLabel(editor: Editor, trackIndex: number): string {
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) return "";
  const type = tracks[trackIndex].type;
  let n = 0;
  if (type === "audio") {
    for (let i = 0; i <= trackIndex; i++) if (tracks[i].type === type) n += 1;
  } else {
    const upper = Math.max(trackIndex + 1, zones(editor).firstAudioIndex);
    for (let i = trackIndex; i < upper; i++) if (tracks[i].type === type) n += 1;
  }
  return `${clipTypeTrackLabelPrefix(type)}${n}`;
}

/** Throws `TrackNameValidationError` for an invalid name. Returns whether the name changed. */
export function setTrackName(editor: Editor, id: string, rawName: string | undefined): boolean {
  const name = trackNameNormalized(rawName);
  return applyTrackName(editor, id, name);
}

function applyTrackName(editor: Editor, id: string, name: string | undefined): boolean {
  const index = editor.timeline.tracks.findIndex((t) => t.id === id);
  if (index < 0) return false;
  if (editor.timeline.tracks[index].name === name) return false;
  editor.perform("Rename Track", () => {
    const track = editor.timeline.tracks[index];
    if (name === undefined) delete track.name;
    else track.name = name;
  });
  return true;
}

export function selectAllClips(editor: Editor, trackId: string): boolean {
  const track = editor.timeline.tracks.find((t) => t.id === trackId);
  if (!track || track.clips.length === 0) return false;
  editor.ui.selectedGap = null;
  editor.ui.selectedTimelineMarkerIds = new Set();
  editor.ui.selectedClipIds = new Set(track.clips.map((c) => c.id));
  return true;
}

/** Clamp `requested` so that visual tracks always sit above every audio track. */
function partitionedInsertionIndex(editor: Editor, type: ClipType, requested: number): number {
  const z = zones(editor);
  const bounded = Math.max(0, Math.min(requested, z.trackCount));
  if (type === "audio") return Math.max(bounded, z.firstAudioIndex);
  return Math.min(bounded, z.firstAudioIndex);
}

export function removeTrack(editor: Editor, id: string): void {
  removeTracks(editor, [id]);
}

// MARK: - Reorder

/** Instantly move the track with `id` to `targetIndex`, clamped to its type zone. No undo. */
export function reorderTrackLive(editor: Editor, id: string, targetIndex: number): void {
  const from = editor.timeline.tracks.findIndex((t) => t.id === id);
  if (from < 0) return;
  const z = zones(editor);
  const isAudio = editor.timeline.tracks[from].type === "audio";
  const lower = isAudio ? z.firstAudioIndex : 0;
  const upper = isAudio ? z.trackCount - 1 : z.firstAudioIndex - 1;
  const dest = Math.max(lower, Math.min(upper, targetIndex));
  if (dest === from) return;
  editor.withoutRegistration(() => {
    const tracks = editor.timeline.tracks;
    const [track] = tracks.splice(from, 1);
    if (track) tracks.splice(dest, 0, track);
  });
}

/** Register a single undo step for a completed live reorder; `before` is the timeline at drag start. */
export function commitTrackReorder(editor: Editor, before: Timeline): void {
  commitTimelineSwap(editor, before, "Reorder Track");
}

export function removeTracks(editor: Editor, ids: readonly string[]): void {
  const set = new Set(ids);
  if (!editor.timeline.tracks.some((t) => set.has(t.id))) return;
  editor.perform(set.size === 1 ? "Remove Track" : "Remove Tracks", () => {
    removeWhere(editor.timeline.tracks, (t) => set.has(t.id));
  });
}

export function pruneEmptyTracks(editor: Editor): void {
  removeWhere(editor.timeline.tracks, (t) => t.clips.length === 0);
}

// MARK: - Flag toggles

type TrackFlag = "muted" | "hidden" | "syncLocked";

export function toggleTrackMute(editor: Editor, trackIndex: number): void {
  toggleTrackFlag(editor, trackIndex, "muted", "Mute Track", "Unmute Track");
}

export function toggleTrackHidden(editor: Editor, trackIndex: number): void {
  toggleTrackFlag(editor, trackIndex, "hidden", "Hide Track", "Show Track");
}

export function toggleTrackSyncLock(editor: Editor, trackIndex: number): void {
  const track = editor.timeline.tracks[trackIndex];
  if (track && track.syncLocked) {
    const clip = track.clips.find((c) => c.multicamGroupId !== undefined);
    const group = clip ? multicamGroupOf(editor, clip) : undefined;
    if (group) {
      editor.refuseWithToast(`Can't unlock sync on a multicam track — "${group.name}" stays aligned through it.`);
      return;
    }
  }
  toggleTrackFlag(editor, trackIndex, "syncLocked", "Sync Lock Track", "Unlock Track Sync");
}

/** `onName` is used when the flag transitions false to true; `offName` for true to false. */
function toggleTrackFlag(editor: Editor, trackIndex: number, flag: TrackFlag, onName: string, offName: string): void {
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) return;
  const was = tracks[trackIndex][flag];
  editor.perform(was ? offName : onName, () => {
    editor.timeline.tracks[trackIndex][flag] = !was;
  });
}

// MARK: - Sizing

export function setTrackHeight(editor: Editor, trackIndex: number, height: number): void {
  if (!(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length)) return;
  editor.perform("Resize Track", () => {
    editor.timeline.tracks[trackIndex].displayHeight = Math.max(TrackSize.minHeight, Math.min(TrackSize.maxHeight, height));
  });
}
