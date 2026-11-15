import { clipFreshenIds, clipTypeIsCompatible, type Clip, type ClipType } from "../../model";
import type { ClipClipboardEntry, Editor } from "../editor";
import { clearRegion } from "./clipMutations";
import { clipDisplayLabel, copyClip, wouldCreateNestCycle } from "./core";
import { pruneEmptyTracks } from "./tracks";

export function clipClipboardEntries(editor: Editor): readonly ClipClipboardEntry[] {
  return editor.ui.clipClipboard;
}

export function canPasteClips(editor: Editor): boolean {
  return editor.ui.clipClipboard.length > 0;
}

/** Snapshot the current selection into the clipboard. */
export function copySelectedClipsToClipboard(editor: Editor): void {
  const ids = editor.ui.selectedClipIds;
  if (ids.size === 0) return;

  const captures: { clip: Clip; trackIndex: number; trackId: string; trackType: ClipType }[] = [];
  for (const id of ids) {
    const loc = editor.findClip(id);
    if (!loc) continue;
    const track = editor.timeline.tracks[loc.trackIndex];
    captures.push({ clip: copyClip(track.clips[loc.clipIndex]), trackIndex: loc.trackIndex, trackId: track.id, trackType: track.type });
  }
  if (captures.length === 0) return;
  captures.sort((a, b) => {
    if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
    if (a.clip.startFrame !== b.clip.startFrame) return a.clip.startFrame - b.clip.startFrame;
    return a.clip.id < b.clip.id ? -1 : a.clip.id > b.clip.id ? 1 : 0;
  });
  const minTrack = captures[0].trackIndex;
  const minStart = Math.min(...captures.map((c) => c.clip.startFrame));

  editor.ui.clipClipboard = captures.map((cap) => ({
      clip: cap.clip,
      trackOffset: cap.trackIndex - minTrack,
      frameOffset: cap.clip.startFrame - minStart,
      sourceTrackId: cap.trackId,
      sourceTrackType: cap.trackType,
    }));
}

/** Keyboard paste: lands at the playhead. */
export function pasteClipsAtPlayhead(editor: Editor): void {
  const anchor = clipClipboardEntries(editor)[0];
  if (!anchor) return;
  const tracks = editor.timeline.tracks;
  let destTrack: number;
  const idx = tracks.findIndex((t) => t.id === anchor.sourceTrackId);
  if (idx >= 0 && clipTypeIsCompatible(tracks[idx].type, anchor.clip.mediaType)) {
    destTrack = idx;
  } else {
    const fallback = tracks.findIndex((t) => clipTypeIsCompatible(t.type, anchor.clip.mediaType));
    if (fallback < 0) return;
    destTrack = fallback;
  }
  pasteClips(editor, destTrack, editor.ui.currentFrame);
}

/** Paste the clipboard at (trackIndex, startFrame), e.g. the mouse pointer position. */
export function pasteClips(editor: Editor, trackIndex: number, startFrame: number): void {
  const entries = clipClipboardEntries(editor);
  if (entries.length === 0) return;
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) return;
  const baseFrame = Math.max(0, startFrame);

  const placements: ClonePlacement[] = [];
  for (const entry of entries) {
    const dstTrack = trackIndex + entry.trackOffset;
    if (!(dstTrack >= 0 && dstTrack < tracks.length)) continue;
    if (!clipTypeIsCompatible(tracks[dstTrack].type, entry.clip.mediaType)) continue;
    // A pasted nest must not make this timeline contain itself.
    if (entry.clip.sourceClipType === "sequence" && wouldCreateNestCycle(editor, entry.clip.mediaRef, editor.doc.activeTimelineId)) {
      editor.refuseWithToast(`Can't paste "${clipDisplayLabel(editor, entry.clip)}" here — it would nest this timeline inside itself.`);
      continue;
    }
    placements.push({ source: entry.clip, trackId: tracks[dstTrack].id, dstStart: baseFrame + entry.frameOffset });
  }

  const newIds = cloneClipsAt(editor, placements, placements.length === 1 ? "Paste Clip" : "Paste Clips");
  if (newIds.length > 0) editor.ui.selectedClipIds = new Set(newIds);
}

/** Option+drag landing: put a copy at the drop target. */
export function duplicateClipsToPositions(
  editor: Editor,
  moves: readonly { clipId: string; toTrack: number; toFrame: number }[],
): void {
  if (moves.length === 0) return;

  const placements: ClonePlacement[] = [];
  for (const m of moves) {
    const loc = editor.findClip(m.clipId);
    if (!loc || !(m.toTrack >= 0 && m.toTrack < editor.timeline.tracks.length)) continue;
    const src = copyClip(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
    const dst = editor.timeline.tracks[m.toTrack];
    if (!clipTypeIsCompatible(dst.type, src.mediaType)) continue;
    placements.push({ source: src, trackId: dst.id, dstStart: Math.max(0, m.toFrame) });
  }

  const newIds = cloneClipsAt(editor, placements, placements.length === 1 ? "Duplicate Clip" : "Duplicate Clips");
  if (newIds.length > 0) editor.ui.selectedClipIds = new Set(newIds);
}

interface ClonePlacement {
  source: Clip;
  trackId: string;
  dstStart: number;
}

/** Shared cloning core for paste + opt-drag-duplicate. */
function cloneClipsAt(editor: Editor, placements: readonly ClonePlacement[], actionName: string): string[] {
  if (placements.length === 0) return [];

  const groupCounts = new Map<string, number>();
  for (const p of placements) {
    if (p.source.linkGroupId !== undefined) groupCounts.set(p.source.linkGroupId, (groupCounts.get(p.source.linkGroupId) ?? 0) + 1);
  }
  const groups = new Map<string, string>();

  const newIds: string[] = [];
  editor.perform(actionName, () => {
    for (const p of placements) {
      const ti = editor.timeline.tracks.findIndex((t) => t.id === p.trackId);
      if (ti < 0) continue;
      clearRegion(editor, ti, p.dstStart, p.dstStart + p.source.durationFrames, { prune: false });
    }

    for (const p of placements) {
      const ti = editor.timeline.tracks.findIndex((t) => t.id === p.trackId);
      if (ti < 0) continue;
      const clone = copyClip(p.source);
      clone.startFrame = p.dstStart;
      clipFreshenIds(clone, groups);
      delete clone.multicamGroupId;
      const oldGroup = p.source.linkGroupId;
      if (oldGroup !== undefined && (groupCounts.get(oldGroup) ?? 0) <= 1) delete clone.linkGroupId;
      editor.timeline.tracks[ti].clips.push(clone);
      newIds.push(clone.id);
    }

    for (let i = 0; i < editor.timeline.tracks.length; i++) editor.sortClips(i);
    pruneEmptyTracks(editor);
  });
  return newIds;
}
