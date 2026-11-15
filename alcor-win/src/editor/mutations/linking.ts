import {
  clipEndFrame,
  clipTypeIsVisual,
  multicamMemberAnchorFrame,
  timelineTotalFrames,
  type Clip,
  type ClipType,
  type MediaAsset,
} from "../../model";
import { newId } from "../../util/id";
import { swiftRound } from "../../util/math";
import { trackDropTargetEquals, type TrackDropTarget } from "../../timeline/timelineGeometry";
import type { Editor } from "../editor";
import { clipDurationFrames, type SourceSegment } from "./core";
import { addClips, mutateClips } from "./clipMutations";
import { multicamTrimBounds } from "./multicamRules";
import { rippleInsertClips, trimClips } from "./ripple";
import { insertTrack } from "./tracks";

/** Snapshot of the video/audio track partition: visual tracks in [0, firstAudioIndex), audio in [firstAudioIndex, trackCount). */
export interface ZoneLayout {
  trackCount: number;
  firstAudioIndex: number;
  videoTrackCount: number;
  audioTrackCount: number;
}

export type TrimEdge = "left" | "right";

export function existingTrack(index: number): TrackDropTarget {
  return { kind: "existingTrack", index };
}

export function newTrackAt(index: number): TrackDropTarget {
  return { kind: "newTrackAt", index };
}

export function trackDropTargetKey(t: TrackDropTarget): string {
  return `${t.kind}:${t.index}`;
}

export function trackDropTargetsEqual(a: TrackDropTarget | undefined, b: TrackDropTarget | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return trackDropTargetEquals(a, b);
}

// MARK: - Indexes

/** Reverse link-group index in a single pass: group id -> member clip ids in track order. */
export function linkIndex(editor: Editor): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of editor.timeline.tracks) {
    for (const c of t.clips) {
      if (c.linkGroupId === undefined) continue;
      const members = m.get(c.linkGroupId);
      if (members) members.push(c.id);
      else m.set(c.linkGroupId, [c.id]);
    }
  }
  return m;
}

export function zones(editor: Editor): ZoneLayout {
  const tracks = editor.timeline.tracks;
  const count = tracks.length;
  const found = tracks.findIndex((t) => t.type === "audio");
  const firstAudio = found < 0 ? count : found;
  return { trackCount: count, firstAudioIndex: firstAudio, videoTrackCount: firstAudio, audioTrackCount: count - firstAudio };
}

// MARK: - Group lookup

/** Every clip id sharing a link group with any id in `ids`, including the inputs themselves. */
export function expandToLinkGroup(editor: Editor, ids: ReadonlySet<string>): Set<string> {
  const idx = linkIndex(editor);
  const clipToGroup = new Map<string, string>();
  for (const [gid, members] of idx) for (const id of members) clipToGroup.set(id, gid);
  const groups = new Set<string>();
  for (const id of ids) {
    const g = clipToGroup.get(id);
    if (g !== undefined) groups.add(g);
  }
  if (groups.size === 0) return new Set(ids);
  const result = new Set(ids);
  for (const g of groups) for (const id of idx.get(g) ?? []) result.add(id);
  return result;
}

/** Ids of clips that share `clipId`'s link group, excluding itself. */
export function linkedPartnerIds(editor: Editor, clipId: string): string[] {
  for (const members of linkIndex(editor).values()) {
    if (members.includes(clipId)) return members.filter((id) => id !== clipId);
  }
  return [];
}

/** For a single-clip frame move, the linked-partner moves needed to keep audio/video in sync. */
export function partnerMoves(editor: Editor, clipId: string, toFrame: number): { clipId: string; toFrame: number }[] {
  const lead = editor.clipFor(clipId);
  if (!lead) return [];
  const delta = toFrame - lead.startFrame;
  if (delta === 0) return [];
  const out: { clipId: string; toFrame: number }[] = [];
  for (const pid of linkedPartnerIds(editor, clipId)) {
    const p = editor.clipFor(pid);
    if (p) out.push({ clipId: pid, toFrame: Math.max(0, p.startFrame + delta) });
  }
  return out;
}

/** Linked-partner IDs that should receive a timing-style change applied uniformly to `clipIds`. */
export function timingPropagationPartners(editor: Editor, clipIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of clipIds) for (const pid of linkedPartnerIds(editor, id)) if (!clipIds.has(pid)) out.add(pid);
  return out;
}

// MARK: - Out-of-sync offset

/** Out-of-sync offsets for every linked clip; clips in sync (or unlinked) are absent. */
export function linkGroupOffsets(editor: Editor): Map<string, number> {
  const fps = editor.timeline.fps;
  const membersByGroup = new Map<string, Map<string, (typeof editor.doc.multicamGroups)[number]["members"][number]>>();
  for (const g of editor.doc.multicamGroups) {
    const byRef = new Map<string, (typeof g.members)[number]>();
    for (const m of g.members) byRef.set(m.mediaRef, m);
    membersByGroup.set(g.id, byRef);
  }
  const byGroup = new Map<string, { id: string; start: number }[]>();
  const mcByGroup = new Map<string, { id: string; start: number; lower: number; upper: number }[]>();
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.multicamGroupId !== undefined) {
        const member = membersByGroup.get(clip.multicamGroupId)?.get(clip.mediaRef);
        if (member) {
          const list = mcByGroup.get(clip.multicamGroupId) ?? [];
          list.push({
            id: clip.id,
            start: multicamMemberAnchorFrame(member, clip, fps),
            lower: clip.startFrame,
            upper: clipEndFrame(clip),
          });
          mcByGroup.set(clip.multicamGroupId, list);
        }
      }
      if (clip.linkGroupId === undefined) continue;
      const list = byGroup.get(clip.linkGroupId) ?? [];
      list.push({ id: clip.id, start: clip.startFrame - clip.trimStartFrame });
      byGroup.set(clip.linkGroupId, list);
    }
  }
  const offsets = new Map<string, number>();
  for (const entries of byGroup.values()) {
    if (entries.length <= 1) continue;
    const ref = Math.min(...entries.map((e) => e.start));
    for (const entry of entries) if (entry.start !== ref) offsets.set(entry.id, entry.start - ref);
  }
  for (const entries of mcByGroup.values()) {
    if (entries.length <= 1) continue;
    let cluster: typeof entries = [];
    let clusterEnd = Number.MIN_SAFE_INTEGER;
    const flush = (): void => {
      if (cluster.length <= 1) return;
      const ref = Math.min(...cluster.map((e) => e.start));
      for (const entry of cluster) if (entry.start !== ref) offsets.set(entry.id, entry.start - ref);
    };
    for (const entry of [...entries].sort((a, b) => a.lower - b.lower)) {
      if (entry.lower >= clusterEnd) {
        flush();
        cluster = [];
      }
      cluster.push(entry);
      clusterEnd = Math.max(clusterEnd, entry.upper);
    }
    flush();
  }
  return offsets;
}

// MARK: - Link / Unlink commands

/** Stamp a new `linkGroupId` on every clip in `ids`, merging pre-existing sub-groups into the new group. */
export function linkClips(editor: Editor, ids: ReadonlySet<string>): void {
  const targets = linkTargets(editor, ids);
  if (!targets) return;
  const newGroup = newId();
  mutateClips(editor, targets, "Link", (c) => {
    c.linkGroupId = newGroup;
  });
}

/** Clear `linkGroupId` on every clip that shares a group with any id in `ids`. */
export function unlinkClips(editor: Editor, ids: ReadonlySet<string>): void {
  mutateClips(editor, unlinkTargets(editor, ids), "Unlink", (c) => {
    delete c.linkGroupId;
  });
  editor.ui.selectedClipIds = new Set();
}

// MARK: - Trim with linked propagation

/** Apply a trim-drag commit. Expands the edit set to linked partners when `propagateToLinked` is on. */
export function commitTrim(editor: Editor, clipId: string, edge: TrimEdge, deltaFramesIn: number, propagateToLinked: boolean): void {
  const leadClip = editor.clipFor(clipId);
  if (!leadClip) return;
  const targets: Clip[] = [leadClip];
  if (propagateToLinked) {
    for (const pid of linkedPartnerIds(editor, clipId)) {
      const p = editor.clipFor(pid);
      if (p) targets.push(p);
    }
  }
  let deltaFrames = deltaFramesIn;
  for (const target of targets) {
    const bounds = multicamTrimBounds(editor, target);
    if (!bounds) continue;
    deltaFrames = edge === "left" ? Math.max(deltaFrames, -bounds.left) : Math.min(deltaFrames, bounds.right);
  }
  const edits = targets.map((clip) => {
    const v = trimValues(clip, edge, deltaFrames);
    return { clipId: clip.id, trimStartFrame: v.trimStart, trimEndFrame: v.trimEnd };
  });
  trimClips(editor, edits);
}

/** Nest trim limits come from the child's live length, not creation time. */
export function effectiveTrimEnd(editor: Editor, clip: Clip): number {
  const child = clip.sourceClipType === "sequence" ? editor.timelines.find((t) => t.id === clip.mediaRef) : undefined;
  if (!child) return clip.trimEndFrame;
  return Math.max(0, timelineTotalFrames(child) - clip.trimStartFrame - clip.durationFrames);
}

/** A clip's trim can be slipped only if it has bounded source material and isn't part of a multicam group. */
export function isSlipEligible(clip: Clip): boolean {
  return clip.mediaType !== "image" && clip.mediaType !== "text" && clip.multicamGroupId === undefined;
}

/** Linked partners of `clipId` whose trim should slip along with it (same filter `commitSlip` applies). */
export function slipPropagationPartnerIds(editor: Editor, clipId: string): string[] {
  return linkedPartnerIds(editor, clipId).filter((id) => {
    const c = editor.clipFor(id);
    return c ? isSlipEligible(c) : false;
  });
}

export function commitSlip(editor: Editor, clipId: string, deltaFrames: number, propagateToLinked: boolean): void {
  const lead = editor.clipFor(clipId);
  if (!lead) return;
  let targets: Clip[] = [lead];
  if (propagateToLinked) {
    for (const pid of slipPropagationPartnerIds(editor, clipId)) {
      const p = editor.clipFor(pid);
      if (p) targets.push(p);
    }
  }
  targets = targets.filter(isSlipEligible);
  if (targets.length === 0) return;

  // Clamp the shared timeline delta to the tightest headroom in the group.
  let delta = deltaFrames;
  for (const t of targets) {
    const speed = Math.max(t.speed, 0.001);
    delta = Math.min(delta, Math.floor(t.trimStartFrame / speed));
    delta = Math.max(delta, -Math.floor(effectiveTrimEnd(editor, t) / speed));
  }
  if (delta === 0) return;

  // Clamped to live trim headroom so rounding through speed never drives a trim negative.
  const appliedSourceDelta = (c: Clip): number => {
    const sourceDelta = swiftRound(delta * c.speed);
    return Math.max(-effectiveTrimEnd(editor, c), Math.min(c.trimStartFrame, sourceDelta));
  };
  if (!targets.some((t) => appliedSourceDelta(t) !== 0)) return;

  mutateClips(editor, new Set(targets.map((t) => t.id)), targets.length === 1 ? "Slip Clip" : "Slip Clips", (c) => {
    const applied = appliedSourceDelta(c);
    c.trimStartFrame -= applied;
    c.trimEndFrame += applied;
  });
}

export function trimValues(clip: Clip, edge: TrimEdge, delta: number): { trimStart: number; trimEnd: number } {
  const sourceDelta = swiftRound(delta * clip.speed);
  // Image/Text clips have no source-material bound, so their trim fields can go negative
  const unbounded = clip.mediaType === "image" || clip.mediaType === "text";
  if (edge === "left") {
    const newStart = clip.trimStartFrame + sourceDelta;
    return { trimStart: unbounded ? newStart : Math.max(0, newStart), trimEnd: clip.trimEndFrame };
  }
  const newEnd = clip.trimEndFrame - sourceDelta;
  return { trimStart: clip.trimStartFrame, trimEnd: unbounded ? newEnd : Math.max(0, newEnd) };
}

// MARK: - Track-zone routing for drops

/** Index of the topmost video/image track, or undefined if none exist. */
export function topVisualTrackIndex(editor: Editor): number | undefined {
  return zones(editor).videoTrackCount > 0 ? 0 : undefined;
}

/** First audio track with no overlap at [startFrame, startFrame+duration), else undefined. */
export function availableAudioTrackIndex(editor: Editor, startFrame: number, duration: number): number | undefined {
  const z = zones(editor);
  for (let i = z.firstAudioIndex; i < z.trackCount; i++) {
    const track = editor.timeline.tracks[i];
    const conflicts = track.clips.some((c) => !(clipEndFrame(c) <= startFrame || c.startFrame >= startFrame + duration));
    if (!conflicts) return i;
  }
  return undefined;
}

/** Where the visual half of a drop lands; a cursor in the audio zone mirrors around the divider. */
export function resolveVisualDropTarget(editor: Editor, cursor: TrackDropTarget): TrackDropTarget {
  const z = zones(editor);
  if (z.trackCount === 0) return newTrackAt(0);

  if (cursor.kind === "existingTrack") {
    const idx = cursor.index;
    if (!(idx >= 0 && idx < z.trackCount)) return newTrackAt(0);
    if (editor.timeline.tracks[idx].type !== "audio") return existingTrack(idx);
    const distance = idx - z.firstAudioIndex;
    const mirrored = z.firstAudioIndex - 1 - distance;
    if (mirrored >= 0 && mirrored < z.firstAudioIndex) return existingTrack(mirrored);
    const v = topVisualTrackIndex(editor);
    if (v !== undefined) return existingTrack(v);
    return newTrackAt(0);
  }
  const insertIdx = cursor.index;
  if (insertIdx <= z.firstAudioIndex) return newTrackAt(insertIdx);
  const distance = insertIdx - z.firstAudioIndex;
  return newTrackAt(Math.max(0, z.firstAudioIndex - distance));
}

/** Where the audio half of a drop lands: the cursor-indicated track (audio itself or its mirror), even if occupied. */
export function resolveAudioDropTarget(editor: Editor, cursor: TrackDropTarget): TrackDropTarget {
  const z = zones(editor);
  if (z.trackCount === 0) return newTrackAt(1);

  if (cursor.kind === "newTrackAt") {
    const insertIdx = cursor.index;
    if (insertIdx > z.firstAudioIndex) return newTrackAt(insertIdx);
    const distance = z.firstAudioIndex - insertIdx;
    const clamped = Math.min(distance, z.audioTrackCount);
    return newTrackAt(z.firstAudioIndex + clamped);
  }

  const idx = preferredAudioTrack(editor, cursor);
  if (idx !== undefined) return existingTrack(idx);
  return newTrackAt(z.trackCount);
}

/** The audio track the cursor points at: itself if audio, else the mirrored audio track across the divider. */
function preferredAudioTrack(editor: Editor, cursor: TrackDropTarget): number | undefined {
  if (cursor.kind !== "existingTrack") return undefined;
  const idx = cursor.index;
  if (!(idx >= 0 && idx < editor.timeline.tracks.length)) return undefined;
  const z = zones(editor);
  if (!(z.audioTrackCount > 0)) return undefined;
  if (editor.timeline.tracks[idx].type === "audio") return idx;
  const mirrored = z.firstAudioIndex + (z.firstAudioIndex - 1 - idx);
  return mirrored >= z.firstAudioIndex && mirrored < z.trackCount ? mirrored : z.firstAudioIndex;
}

/** Bump an audio target by +1 when a preceding visual insertion lands at-or-before it. */
export function shiftAfterVisualInsertion(audio: TrackDropTarget, visual: TrackDropTarget): TrackDropTarget {
  if (visual.kind !== "newTrackAt") return audio;
  if (audio.index >= visual.index) return { kind: audio.kind, index: audio.index + 1 };
  return audio;
}

// MARK: - DropPlan

export interface DropPlacement {
  asset: MediaAsset;
  startFrame: number;
  durationFrames: number;
  hasVisual: boolean;
  hasAudio: boolean;
}

/** Resolved drop target for a set of assets. */
export interface DropPlan {
  placements: DropPlacement[];
  visualTarget?: TrackDropTarget;
  audioTarget?: TrackDropTarget;
}

export function dropPlanVisualAssets(plan: DropPlan): MediaAsset[] {
  return plan.placements.filter((p) => p.hasVisual).map((p) => p.asset);
}

export function dropPlanAudioOnlyAssets(plan: DropPlan): MediaAsset[] {
  return plan.placements.filter((p) => !p.hasVisual && p.hasAudio).map((p) => p.asset);
}

export function dropPlanVisualDurationFrames(plan: DropPlan): number {
  return plan.placements.filter((p) => p.hasVisual).reduce((acc, p) => acc + p.durationFrames, 0);
}

export function dropPlanAudioOnlyDurationFrames(plan: DropPlan): number {
  return plan.placements.filter((p) => !p.hasVisual && p.hasAudio).reduce((acc, p) => acc + p.durationFrames, 0);
}

/** Compute the ghost+commit plan for dropping `assets` at `atFrame` with the cursor over `cursor`. */
export function resolveDropPlan(
  editor: Editor,
  cursor: TrackDropTarget,
  assets: readonly MediaAsset[],
  atFrame: number,
  segments: Record<string, SourceSegment> = {},
): DropPlan {
  const placements: DropPlacement[] = [];
  let c = atFrame;
  for (const asset of assets) {
    if (asset.type === "subtitle") continue;
    const dur = clipDurationFrames(editor, asset, segments[asset.id]);
    placements.push({
      asset,
      startFrame: c,
      durationFrames: dur,
      hasVisual: clipTypeIsVisual(asset.type),
      hasAudio: asset.type === "audio" || (asset.type === "video" && asset.hasAudio),
    });
    c += dur;
  }
  const hasAnyVisual = placements.some((p) => p.hasVisual);
  const hasAnyAudio = placements.some((p) => p.hasAudio);
  const plan: DropPlan = { placements };
  if (hasAnyVisual) plan.visualTarget = resolveVisualDropTarget(editor, cursor);
  if (hasAnyAudio) plan.audioTarget = resolveAudioDropTarget(editor, cursor);
  return plan;
}

/** Shared placement for media dropped on the timeline (panel assets and Finder files). */
export function placeDroppedAssets(
  editor: Editor,
  assets: readonly MediaAsset[],
  cursor: TrackDropTarget,
  atFrame: number,
  options: { segments?: Record<string, SourceSegment>; ripple: boolean },
): void {
  const { segments = {}, ripple } = options;
  editor.perform("Add Clips", () => {
    const plan = resolveDropPlan(editor, cursor, assets, atFrame, segments);
    const { visual: visualIdx, audio: audioIdx } = materialize(editor, plan);

    const insert = (list: readonly MediaAsset[], trackIndex: number, linkedAudio: number | undefined): void => {
      if (ripple) rippleInsertClips(editor, list, trackIndex, atFrame, segments);
      else addClips(editor, list, trackIndex, atFrame, { linkedAudioTrackIndex: linkedAudio, segments });
    };
    const visualAssets = dropPlanVisualAssets(plan);
    if (visualAssets.length > 0 && visualIdx !== undefined) insert(visualAssets, visualIdx, audioIdx);
    const audioOnlyAssets = dropPlanAudioOnlyAssets(plan);
    if (audioOnlyAssets.length > 0 && audioIdx !== undefined) insert(audioOnlyAssets, audioIdx, undefined);
  });
}

export function materialize(editor: Editor, plan: DropPlan): { visual?: number; audio?: number } {
  const out: { visual?: number; audio?: number } = {};
  if (plan.visualTarget) out.visual = materializeTrackIndex(editor, plan.visualTarget, "video");
  const audioTarget = audioTargetAfterVisualInsertion(plan);
  if (audioTarget) out.audio = materializeTrackIndex(editor, audioTarget, "audio");
  return out;
}

export function audioTargetAfterVisualInsertion(plan: DropPlan): TrackDropTarget | undefined {
  if (!plan.audioTarget) return undefined;
  return plan.visualTarget ? shiftAfterVisualInsertion(plan.audioTarget, plan.visualTarget) : plan.audioTarget;
}

/** Resolve a `TrackDropTarget` into a concrete track index, creating a new track if needed. */
export function materializeTrackIndex(editor: Editor, target: TrackDropTarget, type: ClipType): number {
  return target.kind === "existingTrack" ? target.index : insertTrack(editor, target.index, type);
}

export function resolveOrCreateAudioTrack(editor: Editor, startFrame: number, duration: number): number {
  const i = availableAudioTrackIndex(editor, startFrame, duration);
  if (i !== undefined) return i;
  return insertTrack(editor, editor.timeline.tracks.length, "audio");
}

// MARK: - Link eligibility

export function unlinkTargets(editor: Editor, ids: ReadonlySet<string>): Set<string> {
  return new Set([...expandToLinkGroup(editor, ids)].filter((id) => editor.clipFor(id)?.linkGroupId !== undefined));
}

export function linkTargets(editor: Editor, idsIn: ReadonlySet<string>): Set<string> | null {
  const ids = expandToLinkGroup(editor, idsIn);
  if (ids.size < 2) return null;
  const clips: Clip[] = [];
  for (const id of ids) {
    const c = editor.clipFor(id);
    if (c) clips.push(c);
  }
  if (clips.length !== ids.size || new Set(clips.map((c) => c.mediaType)).size < 2) return null;
  const linkedGroups = clips.flatMap((c) => (c.linkGroupId === undefined ? [] : [c.linkGroupId]));
  const groups = new Set(linkedGroups);
  const ungrouped = clips.length - linkedGroups.length;
  if (groups.size === 1 && ungrouped === 0) return null;
  return ids;
}

export function canUnlinkSelected(editor: Editor): boolean {
  return unlinkTargets(editor, editor.ui.selectedClipIds).size > 0;
}

export function canLinkSelected(editor: Editor): boolean {
  return linkTargets(editor, editor.ui.selectedClipIds) !== null;
}
