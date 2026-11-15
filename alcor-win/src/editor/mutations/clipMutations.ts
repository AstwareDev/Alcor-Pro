import {
  clipSetDuration,
  clipClampFadesToDuration,
  clipClampKeyframesToDuration,
  clipEndFrame,
  clipRescaleKeyframes,
  clipRescaleWordTimings,
  clipRetimeSpeedRamp,
  clipSetBlurKeyframeTrack,
  clipSupportsRetiming,
  clipTypeIsCompatible,
  makeTextStyle,
  trackContiguousClipIds,
  type Clip,
  type ClipLocation,
  type MediaAsset,
  type TextStyle,
  type Timeline,
  splitValues,
} from "../../model";
import { newId } from "../../util/id";
import { swiftRound } from "../../util/math";
import { snapshot } from "../../util/snapshot";
import { computeOverwrite } from "../overwriteEngine";
import {
  commitTimelineSwap,
  copyClip,
  createClips,
  deepEqual,
  pendingReplacements,
  removeWhere,
  clipDurationFrames,
  type SourceSegment,
} from "./core";
import type { Editor } from "../editor";
import { editorHooks } from "./hooks";
import { linkedPartnerIds } from "./linking";
import { multicamMoveViolation, type ClipMove } from "./multicamRules";
import { trimClips } from "./ripple";
import { pruneEmptyTracks } from "./tracks";

// MARK: - Transient drag / debounce state (not in EditorUIState)

interface DragState {
  /** Per-clip snapshot at drag start, keyed by clip id. */
  dragBefore: Map<string, Clip>;
  /** Whole-timeline snapshot at drag start, for ripple mutations whose per-clip undos can't compose. */
  preDragTimeline: Timeline | undefined;
  /** Debounced commits, keyed "clipId:property". */
  pendingDebouncedCommits: Map<string, ReturnType<typeof setTimeout>>;
}

const dragStates = new WeakMap<Editor, DragState>();

export function dragState(editor: Editor): DragState {
  let state = dragStates.get(editor);
  if (!state) {
    state = { dragBefore: new Map(), preDragTimeline: undefined, pendingDebouncedCommits: new Map() };
    dragStates.set(editor, state);
  }
  return state;
}

/** A clip mutation that edits the clip in place, or returns a replacement for the whole clip. */
export type ClipModifier = (clip: Clip) => Clip | void;

function setClipAt(editor: Editor, clipId: string, value: Clip): void {
  const loc = editor.findClip(clipId);
  if (!loc) return;
  const slot = editor.timeline.tracks[loc.trackIndex].clips;
  if (!deepEqual(snapshot(slot[loc.clipIndex]), value)) slot[loc.clipIndex] = structuredClone(value);
}

// MARK: - Add / move

export function addClips(
  editor: Editor,
  assets: readonly MediaAsset[],
  trackIndex: number,
  startFrame: number,
  options: { linkedAudioTrackIndex?: number; segments?: Record<string, SourceSegment> } = {},
): void {
  const { linkedAudioTrackIndex, segments = {} } = options;
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) return;
  // Pin by id: clearRegion's pruneEmptyTracks can shift indices.
  const visualTrackId = tracks[trackIndex].id;
  const audioTrackId =
    linkedAudioTrackIndex !== undefined && linkedAudioTrackIndex >= 0 && linkedAudioTrackIndex < tracks.length
      ? tracks[linkedAudioTrackIndex].id
      : undefined;

  editor.perform("Add Clips", () => {
    const totalDur = assets.reduce((acc, a) => acc + clipDurationFrames(editor, a, segments[a.id]), 0);
    clearRegion(editor, trackIndex, startFrame, startFrame + totalDur, { prune: false });
    if (audioTrackId !== undefined) {
      const audioIdx = editor.timeline.tracks.findIndex((t) => t.id === audioTrackId);
      if (audioIdx >= 0) clearRegion(editor, audioIdx, startFrame, startFrame + totalDur, { prune: false });
    }

    const resolvedTrackIndex = editor.timeline.tracks.findIndex((t) => t.id === visualTrackId);
    if (resolvedTrackIndex < 0) {
      pruneEmptyTracks(editor);
      return;
    }
    const resolvedAudioIndex =
      audioTrackId === undefined ? undefined : editor.timeline.tracks.findIndex((t) => t.id === audioTrackId);

    createClips(editor, assets, resolvedTrackIndex, startFrame, {
      linkedAudioTrackIndex: resolvedAudioIndex !== undefined && resolvedAudioIndex >= 0 ? resolvedAudioIndex : undefined,
      segments,
    });
    editor.sortClips(resolvedTrackIndex);
    pruneEmptyTracks(editor);
  });
}

/** Moved clips share a single delta from the drag, so they don't collide with each other. */
export function moveClips(editor: Editor, moves: readonly ClipMove[]): void {
  if (moves.length === 0) return;

  const clipInfos: { clip: Clip; toTrack: number; toFrame: number }[] = [];
  for (const m of moves) {
    const loc = editor.findClip(m.clipId);
    if (!loc || !(m.toTrack >= 0 && m.toTrack < editor.timeline.tracks.length)) continue;
    const clip = snapshot(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
    const destType = editor.timeline.tracks[m.toTrack].type;
    const srcType = editor.timeline.tracks[loc.trackIndex].type;
    if (!clipTypeIsCompatible(destType, srcType)) continue;
    clipInfos.push({ clip, toTrack: m.toTrack, toFrame: Math.max(0, m.toFrame) });
  }
  if (clipInfos.length === 0) return;

  const reason = multicamMoveViolation(
    editor,
    clipInfos.map((i) => ({ clipId: i.clip.id, toTrack: i.toTrack, toFrame: i.toFrame })),
  );
  if (reason !== null) {
    editor.refuseWithToast(reason);
    return;
  }

  editor.perform(moves.length === 1 ? "Move Clip" : "Move Clips", () => {
    const timeline = editor.timeline;
    // Pull moved clips off their source tracks first, so clearRegion on the destinations never touches them.
    const movedIds = new Set(clipInfos.map((i) => i.clip.id));
    for (const track of timeline.tracks) removeWhere(track.clips, (c) => movedIds.has(c.id));

    // Pin by id: clearRegion's pruneEmptyTracks can shift indices.
    const toTrackIds = clipInfos.map((i) => timeline.tracks[i.toTrack].id);
    clipInfos.forEach((info, i) => {
      const idx = editor.timeline.tracks.findIndex((t) => t.id === toTrackIds[i]);
      if (idx < 0) return;
      clearRegion(editor, idx, info.toFrame, info.toFrame + info.clip.durationFrames, { prune: false });
    });

    clipInfos.forEach((info, i) => {
      const idx = editor.timeline.tracks.findIndex((t) => t.id === toTrackIds[i]);
      if (idx < 0) return;
      const clip = copyClip(info.clip);
      clip.startFrame = info.toFrame;
      editor.timeline.tracks[idx].clips.push(clip);
    });
    for (let i = 0; i < editor.timeline.tracks.length; i++) editor.sortClips(i);
    pruneEmptyTracks(editor);
  });
}

// MARK: - Split / remove

/** Split `clipId` at `atFrame`. Also splits linked partners. Returns the IDs of the right-half clips. */
export function splitClip(editor: Editor, clipId: string, atFrame: number): string[] {
  const loc = editor.findClip(clipId);
  if (!loc) return [];
  const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
  if (!(atFrame > clip.startFrame && atFrame < clipEndFrame(clip))) return [];
  return splitClips(editor, [{ trackIndex: loc.trackIndex, atFrame }]);
}

/** Splits at one or more project frames in a single undoable action. */
export function splitClips(editor: Editor, points: readonly { trackIndex: number; atFrame: number }[]): string[] {
  return editor.perform(points.length > 1 ? "Split Clips" : "Split Clip", () => {
    const rightIds: string[] = [];
    for (const p of points) {
      if (!(p.trackIndex >= 0 && p.trackIndex < editor.timeline.tracks.length)) continue;
      const clip = editor.timeline.tracks[p.trackIndex].clips.find(
        (c) => p.atFrame > c.startFrame && p.atFrame < clipEndFrame(c),
      );
      if (!clip) continue;
      const clipId = clip.id;
      const groupIds =
        clip.linkGroupId !== undefined ? new Set([clipId, ...linkedPartnerIds(editor, clipId)]) : new Set([clipId]);
      const rights: string[] = [];
      for (const id of groupIds) {
        const right = splitSingleClip(editor, id, p.atFrame);
        if (right !== undefined) rights.push(right);
      }
      if (groupIds.size > 1 && rights.length > 0) {
        const newGroup = newId();
        mutateClips(editor, new Set(rights), "Split Clip", (c) => {
          c.linkGroupId = newGroup;
        });
      }
      rightIds.push(...rights);
    }
    return rightIds;
  });
}

function splitSingleClip(editor: Editor, clipId: string, atFrame: number): string | undefined {
  const loc = editor.findClip(clipId);
  if (!loc) return undefined;
  const clip = snapshot(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
  const values = splitValues(clip, atFrame);
  if (!values) return undefined;
  editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex] = values.left;
  editor.timeline.tracks[loc.trackIndex].clips.push(values.right);
  // The cut after the clip now belongs to its right half.
  for (const t of editor.timeline.tracks[loc.trackIndex].transitions ?? []) if (t.fromClipId === clipId) t.fromClipId = values.right.id;
  editor.sortClips(loc.trackIndex);
  return values.right.id;
}

export function removeClips(editor: Editor, ids: ReadonlySet<string>, prune = true): void {
  let count = 0;
  for (const track of editor.timeline.tracks) for (const c of track.clips) if (ids.has(c.id)) count += 1;
  if (count === 0) return;
  editor.ui.selectedClipIds = new Set([...editor.ui.selectedClipIds].filter((id) => !ids.has(id)));
  editor.perform(`Remove Clip${count === 1 ? "" : "s"}`, () => {
    for (const track of editor.timeline.tracks) removeWhere(track.clips, (c) => ids.has(c.id));
    if (prune) pruneEmptyTracks(editor);
  });
}

// MARK: - Speed

export function refusesMulticamRetime(editor: Editor, clipIds: readonly string[], quiet = false): boolean {
  if (!clipIds.some((id) => editor.clipFor(id)?.multicamGroupId !== undefined)) return false;
  if (!quiet) editor.refuseWithToast("Can't change speed on a multicam clip — it would slip out of sync with the group.");
  return true;
}

export function applyClipSpeed(editor: Editor, clipId: string, newSpeed: number): void {
  if (refusesMulticamRetime(editor, [clipId], true)) return;
  const loc = editor.findClip(clipId);
  if (!loc) return;
  const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
  if (!clipSupportsRetiming(clip)) return;
  const state = dragState(editor);
  state.preDragTimeline ??= snapshot(editor.timeline);
  if (!state.dragBefore.has(clipId)) state.dragBefore.set(clipId, copyClip(clip));
  editor.withoutRegistration(() => setClipSpeed(editor, loc, newSpeed));
}

export function commitClipSpeed(editor: Editor, ids: readonly string[], newSpeed: number, ripple = true): void {
  if (refusesMulticamRetime(editor, ids)) return;
  const state = dragState(editor);
  const before = state.preDragTimeline ?? snapshot(editor.timeline);
  editor.withoutRegistration(() => {
    for (const id of ids) {
      const loc = editor.findClip(id);
      if (!loc) continue;
      const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
      if (!clipSupportsRetiming(clip)) continue;
      if (clip.speed !== newSpeed) setClipSpeed(editor, loc, newSpeed, ripple);
    }
  });
  state.preDragTimeline = undefined;
  for (const id of ids) state.dragBefore.delete(id);
  commitTimelineSwap(editor, before, "Change Speed");
}

export function retimedDurationFrames(durationFrames: number, speed: number, newSpeed: number): number {
  return Math.max(1, swiftRound((durationFrames * speed) / newSpeed));
}

// Mutates the active timeline; must run inside a perform.
function setClipSpeed(editor: Editor, loc: ClipLocation, newSpeed: number, ripple = true): void {
  const ti = loc.trackIndex;
  const target = editor.timeline.tracks[ti].clips[loc.clipIndex];
  const clip = snapshot(target);
  const basis = dragState(editor).dragBefore.get(clip.id) ?? clip;
  const newDuration = retimedDurationFrames(basis.durationFrames, basis.speed, newSpeed);
  const oldDuration = clip.durationFrames;
  const oldEnd = clipEndFrame(clip);

  target.speed = newSpeed;
  target.durationFrames = newDuration;
  // Keyframe offsets are clip-relative, so retime them before the clamp drops them.
  clipRescaleWordTimings(target, oldDuration);
  clipRescaleKeyframes(target, newDuration / oldDuration);
  clipClampKeyframesToDuration(target);
  clipClampFadesToDuration(target);
  clipRetimeSpeedRamp(target, basis, newSpeed, newDuration);

  const rippleDelta = clip.startFrame + newDuration - oldEnd;
  if (ripple && rippleDelta !== 0) {
    const track = editor.timeline.tracks[ti];
    const chainIds = trackContiguousClipIds(track, oldEnd, clip.id);
    for (const c of track.clips) if (chainIds.has(c.id)) c.startFrame += rippleDelta;
  }
  editor.sortClips(ti);
}

// MARK: - Multi-clip atomic mutation

/** Apply `modify` (in place) to every clip whose id is in `ids` as one undoable action. */
export function mutateClips(editor: Editor, ids: ReadonlySet<string>, actionName: string, modify: (clip: Clip) => void): void {
  if (!editor.timeline.tracks.some((t) => t.clips.some((c) => ids.has(c.id)))) return;
  editor.perform(actionName, () => {
    for (const track of editor.timeline.tracks) for (const clip of track.clips) if (ids.has(clip.id)) modify(clip);
  });
}

// MARK: - Generic property edits (live apply / commit)

/** Live edit with no undo entry; remembers the pre-gesture clip in `dragBefore` for the commit. */
export function applyClipProperty(editor: Editor, clipId: string, modify: ClipModifier): void {
  applyClipProperties(editor, [clipId], modify);
}

export function applyClipProperties(editor: Editor, clipIds: readonly string[], modify: ClipModifier): void {
  const { dragBefore } = dragState(editor);
  editor.withoutRegistration(() => {
    for (const clipId of clipIds) {
      const loc = editor.findClip(clipId);
      if (!loc) continue;
      const target = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
      if (!dragBefore.has(clipId)) dragBefore.set(clipId, copyClip(target));
      const replacement = modify(target);
      if (replacement) editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex] = structuredClone(replacement);
    }
  });
}

export function revertClipProperty(editor: Editor, clipId: string): void {
  revertClipProperties(editor, [clipId]);
}

export function revertClipProperties(editor: Editor, clipIds: readonly string[]): void {
  const { dragBefore } = dragState(editor);
  editor.withoutRegistration(() => {
    for (const clipId of clipIds) {
      const original = dragBefore.get(clipId);
      if (!original) continue;
      dragBefore.delete(clipId);
      setClipAt(editor, clipId, original);
    }
  });
}

export function debouncedCommitClipProperties(
  editor: Editor,
  clipIds: readonly string[],
  key: string,
  modify: ClipModifier,
  debounceMs = 400,
): void {
  applyClipProperties(editor, clipIds, modify);
  const { pendingDebouncedCommits } = dragState(editor);
  const existing = pendingDebouncedCommits.get(key);
  if (existing !== undefined) clearTimeout(existing);
  pendingDebouncedCommits.set(
    key,
    setTimeout(() => {
      commitClipProperties(editor, clipIds, modify);
      pendingDebouncedCommits.delete(key);
    }, debounceMs),
  );
}

export function cancelDebouncedCommit(editor: Editor, key: string): void {
  const { pendingDebouncedCommits } = dragState(editor);
  const existing = pendingDebouncedCommits.get(key);
  if (existing !== undefined) clearTimeout(existing);
  pendingDebouncedCommits.delete(key);
}

interface ClipStateEntry {
  id: string;
  undoTarget: Clip;
  final: Clip;
}

// Entries whose final state differs from the pre-gesture state get one undo step (pre-gesture -> final).
function commitClipStates(editor: Editor, entries: readonly ClipStateEntry[], actionName: string): void {
  const undoable = entries.filter((e) => !deepEqual(e.undoTarget, e.final));
  editor.withoutRegistration(() => {
    for (const e of entries) setClipAt(editor, e.id, undoable.includes(e) ? e.undoTarget : e.final);
  });
  if (undoable.length === 0) return;
  editor.perform(actionName, () => {
    for (const e of undoable) setClipAt(editor, e.id, e.final);
  });
}

export function commitClipProperty(
  editor: Editor,
  clipId: string,
  modify: ClipModifier,
  actionName = "Change Clip Property",
): void {
  commitClipProperties(editor, [clipId], modify, actionName);
}

export function commitClipProperties(
  editor: Editor,
  clipIds: readonly string[],
  modify: ClipModifier,
  actionName = "Change Clip Property",
): void {
  const { dragBefore } = dragState(editor);
  const entries: ClipStateEntry[] = [];
  for (const clipId of clipIds) {
    const loc = editor.findClip(clipId);
    if (!loc) continue;
    const current = snapshot(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
    const undoTarget = dragBefore.get(clipId) ?? current;
    dragBefore.delete(clipId);
    const working = copyClip(current);
    const final = modify(working) ?? working;
    if (deepEqual(current, final) && deepEqual(undoTarget, final)) continue;
    entries.push({ id: clipId, undoTarget, final });
  }
  commitClipStates(editor, entries, actionName);
}

// MARK: - Text-style mutation helpers

function fitIfNeeded(editor: Editor, clip: Clip, canvasW: number, canvasH: number): void {
  editorHooks.fitTextClipToContentIfNeeded?.(editor, clip, canvasW, canvasH);
}

function withStyle(clip: Clip, modify: (style: TextStyle) => void): void {
  const style = clip.textStyle ? structuredClone(snapshot(clip.textStyle)) : makeTextStyle();
  modify(style);
  clip.textStyle = style;
}

export function applyTextContent(editor: Editor, clipId: string, content: string): void {
  const { width, height } = editor.timeline;
  applyClipProperty(editor, clipId, (clip) => {
    clip.textContent = content;
    fitIfNeeded(editor, clip, width, height);
  });
}

export function commitTextContent(editor: Editor, clipId: string, content: string): void {
  const { width, height } = editor.timeline;
  commitClipProperty(
    editor,
    clipId,
    (clip) => {
      clip.textContent = content;
      fitIfNeeded(editor, clip, width, height);
    },
    "Change Text",
  );
}

export function applyTextStyle(editor: Editor, clipId: string, modify: (style: TextStyle) => void, fitToContent = false): void {
  const { width, height } = editor.timeline;
  applyClipProperty(editor, clipId, (clip) => {
    withStyle(clip, modify);
    if (fitToContent) fitIfNeeded(editor, clip, width, height);
  });
}

function textStylesModifier(editor: Editor, modify: (style: TextStyle) => void, fitToContent: boolean): ClipModifier {
  const { width, height } = editor.timeline;
  return (clip) => {
    const blur = (clip.textStyle ?? makeTextStyle()).blur;
    withStyle(clip, modify);
    if ((clip.textStyle as TextStyle).blur !== blur) clipSetBlurKeyframeTrack(clip, undefined);
    if (fitToContent) fitIfNeeded(editor, clip, width, height);
  };
}

export function applyTextStyles(editor: Editor, clipIds: readonly string[], modify: (style: TextStyle) => void, fitToContent = false): void {
  applyClipProperties(editor, clipIds, textStylesModifier(editor, modify, fitToContent));
}

export function commitTextStyle(editor: Editor, clipId: string, modify: (style: TextStyle) => void, fitToContent = false): void {
  const { width, height } = editor.timeline;
  commitClipProperty(editor, clipId, (clip) => {
    withStyle(clip, modify);
    if (fitToContent) fitIfNeeded(editor, clip, width, height);
  });
}

export function commitTextStyles(editor: Editor, clipIds: readonly string[], modify: (style: TextStyle) => void, fitToContent = false): void {
  commitClipProperties(editor, clipIds, textStylesModifier(editor, modify, fitToContent));
}

export function debouncedCommitTextStyles(editor: Editor, clipIds: readonly string[], key: string, modify: (style: TextStyle) => void): void {
  debouncedCommitClipProperties(editor, clipIds, key, (clip) => {
    withStyle(clip, modify);
  });
}

// MARK: - Pending replacement / media swap

/** Flag the clip (and linked clips sharing its `mediaRef`) as awaiting an AI-generated replacement. */
export function markPendingReplacement(editor: Editor, clipId: string): void {
  const pending = pendingReplacements(editor);
  for (const id of linkedClipIdsSharingMedia(editor, clipId)) pending.add(id);
}

export function clearPendingReplacement(editor: Editor, clipId: string): void {
  const pending = pendingReplacements(editor);
  for (const id of linkedClipIdsSharingMedia(editor, clipId)) pending.delete(id);
  pending.delete(clipId);
}

export function linkedClipIdsSharingMedia(editor: Editor, anchor: string): Set<string> {
  const clip = editor.clipFor(anchor);
  const ids = new Set<string>([anchor]);
  if (!clip) return ids;
  if (clip.linkGroupId !== undefined) {
    const { linkGroupId, mediaRef } = clip;
    for (const track of editor.timeline.tracks) {
      for (const c of track.clips) if (c.linkGroupId === linkGroupId && c.mediaRef === mediaRef) ids.add(c.id);
    }
  }
  return ids;
}

/** Replace the source asset a clip points at, preserving state, as a single undo step. */
export function replaceClipMediaRef(
  editor: Editor,
  clipId: string,
  newAssetId: string,
  options: { resetTrim?: boolean; trimEndFrames?: Record<string, number> } = {},
): void {
  const { resetTrim = false, trimEndFrames = {} } = options;
  const clip = editor.clipFor(clipId);
  if (!clip || clip.mediaRef === newAssetId) return;
  const asset = editor.mediaAsset(newAssetId);
  if (asset) editorHooks.prepareMediaVisuals?.(editor, asset);

  commitClipProperties(
    editor,
    [...linkedClipIdsSharingMedia(editor, clipId)].sort(),
    (c) => {
      c.mediaRef = newAssetId;
      if (resetTrim) {
        c.trimStartFrame = 0;
        c.trimEndFrame = 0;
      } else {
        const trimEnd = trimEndFrames[c.id];
        if (trimEnd !== undefined) c.trimEndFrame = trimEnd;
      }
    },
    "Replace Clip Source",
  );
}

// MARK: - Playhead-relative operations

export function splitAtPlayhead(editor: Editor): void {
  const ids = [...editor.ui.selectedClipIds];
  editor.perform(ids.length > 1 ? "Split Clips" : "Split Clip", () => {
    for (const id of ids) splitClip(editor, id, editor.ui.currentFrame);
  });
}

export function trimStartToPlayhead(editor: Editor): void {
  const frame = editor.ui.currentFrame;
  const ids = [...editor.ui.selectedClipIds];
  editor.perform(ids.length > 1 ? "Trim Clips" : "Trim Clip", () => {
    for (const id of ids) {
      const clip = editor.clipFor(id);
      if (!clip || !(frame > clip.startFrame && frame < clipEndFrame(clip))) continue;
      const sourceDelta = swiftRound((frame - clip.startFrame) * clip.speed);
      trimClips(editor, [{ clipId: id, trimStartFrame: clip.trimStartFrame + sourceDelta, trimEndFrame: clip.trimEndFrame }]);
    }
  });
}

export function trimEndToPlayhead(editor: Editor): void {
  const frame = editor.ui.currentFrame;
  const ids = [...editor.ui.selectedClipIds];
  editor.perform(ids.length > 1 ? "Trim Clips" : "Trim Clip", () => {
    for (const id of ids) {
      const clip = editor.clipFor(id);
      if (!clip || !(frame > clip.startFrame && frame < clipEndFrame(clip))) continue;
      const sourceDelta = swiftRound((clipEndFrame(clip) - frame) * clip.speed);
      trimClips(editor, [{ clipId: id, trimStartFrame: clip.trimStartFrame, trimEndFrame: clip.trimEndFrame + sourceDelta }]);
    }
  });
}

export function deleteSelectedClips(editor: Editor): void {
  removeClips(editor, editor.ui.selectedClipIds);
}

/** Removes every clip referencing `assetIds` from every timeline; prunes emptied tracks. Runs inside a perform. */
export function removeClipsReferencingAssets(editor: Editor, assetIds: ReadonlySet<string>): Set<string> {
  return editor.perform("Remove Clips", () => {
    const removed = new Set<string>();
    for (const timeline of editor.timelines) {
      let touched = false;
      for (const track of timeline.tracks) {
        for (const c of track.clips) if (assetIds.has(c.mediaRef)) removed.add(c.id);
        if (removeWhere(track.clips, (c) => assetIds.has(c.mediaRef)) > 0) touched = true;
      }
      if (touched) removeWhere(timeline.tracks, (t) => t.clips.length === 0);
    }
    editor.ui.selectedClipIds = new Set([...editor.ui.selectedClipIds].filter((id) => !removed.has(id)));
    return removed;
  });
}

export function deleteMediaAssets(editor: Editor, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  if (!editor.mediaAssets.some((a) => ids.has(a.id))) return;

  editor.perform("Delete Media", () => {
    removeClipsReferencingAssets(editor, ids);
    removeWhere(editor.doc.mediaAssets, (a) => ids.has(a.id));
    removeWhere(editor.doc.mediaManifest.entries, (e) => ids.has(e.id));
  });
  for (const id of ids) editorHooks.closeMediaAssetPreviewTab?.(editor, id);
  editor.ui.selectedMediaAssetIds = new Set();
}

// MARK: - Overwrite region

/** Clear a region on a track by removing, trimming, or splitting the clips that overlap it. */
export function clearRegion(
  editor: Editor,
  trackIndex: number,
  start: number,
  end: number,
  options: { prune?: boolean; excluding?: ReadonlySet<string> } = {},
): void {
  const { prune = true, excluding = new Set<string>() } = options;
  if (!(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length)) return;
  const actions = computeOverwrite(
    editor.timeline.tracks[trackIndex].clips.filter((c) => !excluding.has(c.id)),
    start,
    end,
  );

  for (const action of actions) {
    switch (action.kind) {
      case "remove":
        removeClips(editor, new Set([action.clipId]), prune);
        break;

      case "trimEnd": {
        const clip = editor.clipFor(action.clipId);
        if (!clip) break;
        const sourceDelta = swiftRound((clip.durationFrames - action.newDuration) * clip.speed);
        const newTrimEnd = clip.trimEndFrame + sourceDelta;
        mutateClips(editor, new Set([action.clipId]), "Trim Clip", (c) => {
          c.trimEndFrame = newTrimEnd;
          clipSetDuration(c, action.newDuration);
        });
        break;
      }

      case "trimStart":
        mutateClips(editor, new Set([action.clipId]), "Trim Clip", (c) => {
          c.startFrame = action.newStartFrame;
          c.trimStartFrame = action.newTrimStart;
          clipSetDuration(c, action.newDuration);
        });
        break;

      case "split": {
        const loc = editor.findClip(action.clipId);
        if (!loc) break;
        splitClip(editor, action.clipId, start);
        const rightClip = editor.timeline.tracks[loc.trackIndex].clips.find(
          (c) => c.startFrame === start && c.id !== action.clipId,
        );
        if (rightClip) {
          const rightId = rightClip.id;
          if (clipEndFrame(rightClip) > end) {
            splitClip(editor, rightId, end);
            removeClips(editor, new Set([rightId]), prune);
          } else {
            removeClips(editor, new Set([rightId]), prune);
          }
        }
        break;
      }
    }
  }
}
