import { clipEndFrame, clipSetDuration, type Clip, type ClipLocation, type MediaAsset, type TimelineMarker } from "../../model";
import { swiftRound } from "../../util/math";
import { snapshot } from "../../util/snapshot";
import {
  computeRipplePush,
  computeRippleShifts,
  computeRippleShiftsForRanges,
  frameRangeLength,
  makeFrameRange,
  mergeRanges,
  rippleMarkersClosing,
  rippleMarkersOpening,
  type ClipShift,
  type FrameRange,
  type GapSelection,
} from "../rippleEngine";
import type { TrackDropTarget } from "../../timeline/timelineGeometry";
import type { Editor } from "../editor";
import { clearRegion, removeClips, splitClip } from "./clipMutations";
import {
  clipDurationFrames,
  createClips,
  deepEqual,
  placeClip,
  type SourceSegment,
} from "./core";
import {
  audioTargetAfterVisualInsertion,
  dropPlanAudioOnlyDurationFrames,
  dropPlanVisualDurationFrames,
  linkedPartnerIds,
  trackDropTargetKey,
  trimValues,
  type DropPlan,
  type TrimEdge,
} from "./linking";
import { multicamGroupById, multicamGroupOf, multicamRippleCohort } from "./multicamRules";
import { insertTrack, timelineTrackDisplayLabel } from "./tracks";

export interface RippleRangesReport {
  removedFrames: number;
  clearedTracks: number;
  shiftedClips: number;
  anchorTrackIndex: number;
  resultingFragments: { clipId: string; startFrame: number; durationFrames: number }[];
  removedClipIds: string[];
}

export type RippleRangesOutcome = { kind: "ok"; report: RippleRangesReport } | { kind: "refused"; reason: string };

export interface TrimEdit {
  clipId: string;
  trimStartFrame: number;
  trimEndFrame: number;
}

/** Trim clips as a batch, keeping linked clips trimmed together. */
export function trimClips(editor: Editor, edits: readonly TrimEdit[]): void {
  if (edits.length === 0) return;
  const batchIds = new Set(edits.map((e) => e.clipId));
  editor.perform(edits.length === 1 ? "Trim Clip" : "Trim Clips", () => {
    for (const e of edits) trimClipInternal(editor, e.clipId, e.trimStartFrame, e.trimEndFrame, batchIds);
  });
}

/** Ripple trim result: resized clips, shifted clips, and optional obstacle frame if clamped. */
export interface RippleTrimPlan {
  durationDelta: number;
  resizes: { clipId: string; trimStart: number; trimEnd: number; duration: number }[];
  shifts: ClipShift[];
  blockedAtFrame?: number;
}

export function rippleTrimPlanTargetIds(plan: RippleTrimPlan): Set<string> {
  return new Set(plan.resizes.map((r) => r.clipId));
}

/** Plans a non-destructive ripple trim, capped by the strictest linked or sync-locked constraint. */
export function planRippleTrim(
  editor: Editor,
  clipId: string,
  edge: TrimEdge,
  deltaFrames: number,
  propagateToLinked: boolean,
): RippleTrimPlan | null {
  const leadLoc = editor.findClip(clipId);
  if (deltaFrames === 0 || !leadLoc) return null;
  const timeline = editor.timeline;
  const leadEnd = clipEndFrame(timeline.tracks[leadLoc.trackIndex].clips[leadLoc.clipIndex]);
  const targetClips = rippleTrimTargets(editor, clipId, edge, propagateToLinked);
  const targetIds = new Set(targetClips.map((c) => c.id));
  if (rippleTrimRefusal(editor, leadLoc, edge, targetIds) !== null) return null;

  // Each target's own source headroom caps how far it can ripple; bind to the smallest.
  let sourceDelta = 0;
  let best: number | undefined;
  for (const c of targetClips) {
    const d = rippleTrimDurationDelta(c, edge, deltaFrames);
    if (best === undefined || Math.abs(d) < Math.abs(best)) best = d;
  }
  sourceDelta = best ?? 0;

  // Shrinking shifts sync-locked followers left; clamp to the tightest available room.
  let durationDelta = sourceDelta;
  let blockedAtFrame: number | undefined;
  if (durationDelta < 0) {
    const shrinkRooms = targetClips.map((c) => (c.durationFrames > 1 ? c.durationFrames - 1 : 0));
    const targetShrinkRoom = shrinkRooms.length === 0 ? 0 : Math.min(...shrinkRooms);
    durationDelta = Math.max(durationDelta, -targetShrinkRoom);
    let tightest: { room: number; obstacle: number } | undefined;
    for (const track of timeline.tracks) {
      if (!track.syncLocked || track.clips.some((c) => targetIds.has(c.id))) continue;
      const limit = syncLockedLeftRoom(track.clips, leadEnd);
      if (limit && (tightest === undefined || limit.room < tightest.room)) tightest = limit;
    }
    if (tightest && durationDelta < -tightest.room) {
      durationDelta = -tightest.room;
      blockedAtFrame = tightest.obstacle;
    }
  }
  if (durationDelta === 0 && blockedAtFrame === undefined) return null;

  // A right-edge duration change maps to the same source-frame edge drag; left flips sign.
  const resizes = targetClips.map((c) => {
    const fields = trimValues(c, edge, edge === "right" ? durationDelta : -durationDelta);
    return { clipId: c.id, trimStart: fields.trimStart, trimEnd: fields.trimEnd, duration: c.durationFrames + durationDelta };
  });

  const shifts: ClipShift[] = [];
  for (const track of timeline.tracks) {
    const target = track.clips.find((c) => targetIds.has(c.id));
    const targetEnd = target ? clipEndFrame(target) : undefined;
    if (targetEnd === undefined && !track.syncLocked) continue;
    shifts.push(...computeRipplePush(track.clips, targetEnd ?? leadEnd, durationDelta, targetIds));
  }
  const plan: RippleTrimPlan = { durationDelta, resizes, shifts };
  if (blockedAtFrame !== undefined) plan.blockedAtFrame = blockedAtFrame;
  return plan;
}

/** Max left shift for sync-locked clips before hitting the next obstacle; undefined if no shift possible. */
function syncLockedLeftRoom(clips: readonly Clip[], insertFrame: number): { room: number; obstacle: number } | undefined {
  const after = clips.filter((c) => c.startFrame >= insertFrame).map((c) => c.startFrame);
  if (after.length === 0) return undefined;
  const first = Math.min(...after);
  const before = clips.filter((c) => c.startFrame < insertFrame).map(clipEndFrame);
  const prevEnd = before.length === 0 ? 0 : Math.max(...before);
  return { room: Math.max(0, first - prevEnd), obstacle: prevEnd };
}

/** Ripple trim: resize a clip from the dragged edge and shift every clip after it. */
export function rippleTrimClip(editor: Editor, clipId: string, edge: TrimEdge, deltaFrames: number, propagateToLinked: boolean): void {
  const leadLoc = editor.findClip(clipId);
  if (leadLoc) {
    const targets = rippleTrimTargets(editor, clipId, edge, propagateToLinked);
    const reason = rippleTrimRefusal(editor, leadLoc, edge, new Set(targets.map((c) => c.id)));
    if (reason !== null) {
      refuseRipple(editor, reason);
      return;
    }
  }
  const plan = planRippleTrim(editor, clipId, edge, deltaFrames, propagateToLinked);
  if (!plan) return;

  const touched = new Set([...rippleTrimPlanTargetIds(plan), ...plan.shifts.map((s) => s.clipId)]);
  const lead = editor.clipFor(clipId);
  const leadEnd = lead ? clipEndFrame(lead) : undefined;
  editor.perform("Ripple Trim", () => {
    for (const r of plan.resizes) {
      const l = editor.findClip(r.clipId);
      if (!l) continue;
      const target = editor.timeline.tracks[l.trackIndex].clips[l.clipIndex];
      target.trimStartFrame = r.trimStart;
      target.trimEndFrame = r.trimEnd;
      clipSetDuration(target, r.duration);
    }
    applyShifts(editor, plan.shifts);
    if (leadEnd !== undefined) {
      applyRippledMarkers(editor, rippleMarkersOpening(editor.timeline.markers, leadEnd, plan.durationDelta));
    }
    editor.timeline.tracks.forEach((track, ti) => {
      if (track.clips.some((c) => touched.has(c.id))) editor.sortClips(ti);
    });
  });
}

/** Lead clip plus multicam cohort and (optionally) linked partners, transitively; detached copies in timeline order. */
export function rippleTrimTargets(editor: Editor, clipId: string, edge: TrimEdge, propagateToLinked: boolean): Clip[] {
  if (!editor.clipFor(clipId)) return [];
  const targetIds = new Set([clipId]);
  let frontier = new Set(targetIds);
  while (frontier.size > 0) {
    const added = new Set<string>();
    for (const id of frontier) {
      const clip = editor.clipFor(id);
      if (!clip) continue;
      for (const cohortClip of multicamRippleCohort(editor, clip, edge)) {
        if (!targetIds.has(cohortClip.id)) {
          targetIds.add(cohortClip.id);
          added.add(cohortClip.id);
        }
      }
      if (propagateToLinked) {
        for (const partnerId of linkedPartnerIds(editor, id)) {
          if (!targetIds.has(partnerId)) {
            targetIds.add(partnerId);
            added.add(partnerId);
          }
        }
      }
    }
    frontier = added;
  }
  return editor.timeline.tracks.flatMap((t) => t.clips).filter((c) => targetIds.has(c.id)).map(snapshot);
}

function rippleTrimRefusal(editor: Editor, leadLoc: ClipLocation, edge: TrimEdge, targetIds: ReadonlySet<string>): string | null {
  const tracks = editor.timeline.tracks;
  const lead = tracks[leadLoc.trackIndex].clips[leadLoc.clipIndex];
  const shiftingTrackIds = new Set(tracks.filter((t) => t.syncLocked).map((t) => t.id));
  shiftingTrackIds.add(tracks[leadLoc.trackIndex].id);
  for (const targetId of targetIds) {
    const loc = editor.findClip(targetId);
    if (loc) shiftingTrackIds.add(tracks[loc.trackIndex].id);
  }
  const shiftPoint = edge === "left" ? lead.startFrame : clipEndFrame(lead);
  return multicamManualRippleViolation(editor, shiftingTrackIds, shiftPoint);
}

/** Timeline delta from a ripple trim of `clip` by `delta` frames. */
function rippleTrimDurationDelta(clip: Clip, edge: TrimEdge, delta: number): number {
  const fields = trimValues(clip, edge, delta);
  const sourceShift = fields.trimStart - clip.trimStartFrame + (fields.trimEnd - clip.trimEndFrame);
  return -swiftRound(sourceShift / clip.speed);
}

/** Ripple delete: remove selected clips and shift sync-locked tracks to keep them aligned. */
export function rippleDeleteSelectedClips(editor: Editor): void {
  const ids = new Set(editor.ui.selectedClipIds);
  if (ids.size === 0) return;
  const tracks = editor.timeline.tracks;

  // Merged ranges used to shift sync-locked tracks that have no deletions of their own.
  const globalRemovedRanges: FrameRange[] = tracks
    .flatMap((t) => t.clips)
    .filter((c) => ids.has(c.id))
    .map((c) => makeFrameRange(c.startFrame, clipEndFrame(c)));

  const shiftingIds = new Set(tracks.filter((t) => t.syncLocked || t.clips.some((c) => ids.has(c.id))).map((t) => t.id));
  for (const range of globalRemovedRanges) {
    const reason = multicamManualRippleViolation(editor, shiftingIds, range.end);
    if (reason !== null) {
      refuseRipple(editor, reason);
      return;
    }
  }

  const shiftsByTrack = new Map<number, ClipShift[]>();
  const markerRanges: FrameRange[][] = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    const hasOwnRemovals = track.clips.some((c) => ids.has(c.id));
    if (hasOwnRemovals) {
      shiftsByTrack.set(ti, computeRippleShifts(track.clips, ids));
      markerRanges.push(track.clips.filter((c) => ids.has(c.id)).map((c) => makeFrameRange(c.startFrame, clipEndFrame(c))));
    } else if (track.syncLocked) {
      const shifts = computeRippleShiftsForRanges(track.clips, globalRemovedRanges);
      shiftsByTrack.set(ti, shifts);
      const reason = validateShifts(editor, ti, shifts);
      if (reason !== null) {
        refuseRipple(editor, reason);
        return;
      }
      markerRanges.push(globalRemovedRanges);
    }
  }

  editor.perform("Ripple Delete", () => {
    removeClips(editor, ids);
    for (const shifts of shiftsByTrack.values()) applyShifts(editor, shifts);
    applyRippledMarkers(editor, rippleMarkersClosing(editor.timeline.markers, markerRanges));
  });
}

/** Applies shifts by clip id; returns how many clips moved. Must run inside a perform. */
export function applyShifts(editor: Editor, shifts: readonly ClipShift[]): number {
  let applied = 0;
  for (const shift of shifts) {
    const loc = editor.findClip(shift.clipId);
    if (!loc) continue;
    editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame = shift.newStartFrame;
    applied += 1;
  }
  return applied;
}

function applyRippledMarkers(editor: Editor, next: TimelineMarker[]): void {
  if (!editor.ui.rippleTimelineMarkers || deepEqual(next, editor.timeline.markers)) return;
  editor.timeline.markers = next;
  editor.ui.timelineMarkerPreview = null;
}

/** Ripple-delete timeline-frame `ranges` anchored to the track holding `anchorClipId`. */
export function rippleDeleteRanges(editor: Editor, anchorClipId: string, ranges: readonly FrameRange[]): RippleRangesOutcome {
  const anchorLoc = editor.findClip(anchorClipId);
  if (!anchorLoc) return { kind: "refused", reason: `Clip not found: ${anchorClipId}` };
  return rippleDeleteRangesOnTrack(editor, anchorLoc.trackIndex, ranges);
}

/** Ripple-deletes frame ranges on a track, including linked and sync-locked tracks. Tracks in `ignoreSyncLockTrackIndices` are unlocked for this call. */
export function rippleDeleteRangesOnTrack(
  editor: Editor,
  trackIndex: number,
  ranges: readonly FrameRange[],
  ignoreSyncLockTrackIndices: ReadonlySet<number> = new Set(),
): RippleRangesOutcome {
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) {
    return { kind: "refused", reason: `Track index out of range: ${trackIndex}` };
  }
  const ignoredTrackIds = new Set<string>();
  for (const i of ignoreSyncLockTrackIndices) if (i >= 0 && i < tracks.length) ignoredTrackIds.add(tracks[i].id);
  const merged = mergeRanges(ranges.filter((r) => frameRangeLength(r) > 0));
  if (merged.length === 0) return { kind: "refused", reason: "No non-empty ranges to delete" };
  const totalRemoved = merged.reduce((acc, r) => acc + frameRangeLength(r), 0);

  const anchorTrackId = tracks[trackIndex].id;
  const clearTrackIds = new Set([anchorTrackId]);
  for (const track of tracks) if (track.syncLocked && !ignoredTrackIds.has(track.id)) clearTrackIds.add(track.id);
  // Ensure all linked partners of affected clips are included to keep A/V in sync.
  let frontier = new Set(clearTrackIds);
  while (frontier.size > 0) {
    const added = new Set<string>();
    for (const tid of frontier) {
      const ti = editor.timeline.tracks.findIndex((t) => t.id === tid);
      if (ti < 0) continue;
      for (const clip of editor.timeline.tracks[ti].clips) {
        if (clip.linkGroupId === undefined) continue;
        if (!merged.some((r) => r.start < clipEndFrame(clip) && r.end > clip.startFrame)) continue;
        for (const pid of linkedPartnerIds(editor, clip.id)) {
          const l = editor.findClip(pid);
          if (!l) continue;
          const partnerTid = editor.timeline.tracks[l.trackIndex].id;
          if (!clearTrackIds.has(partnerTid)) {
            clearTrackIds.add(partnerTid);
            added.add(partnerTid);
          }
        }
      }
    }
    frontier = added;
  }

  const shiftingIds = new Set(clearTrackIds);
  for (const t of tracks) if (t.syncLocked && !ignoredTrackIds.has(t.id)) shiftingIds.add(t.id);
  const atomicity = multicamAtomicityViolation(editor, shiftingIds);
  if (atomicity !== null) {
    editor.refuseWithToast(atomicity);
    return { kind: "refused", reason: atomicity };
  }

  // Refuse up front if a sync-locked follower can't absorb the shift after clearing.
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (clearTrackIds.has(track.id) || !track.syncLocked || ignoredTrackIds.has(track.id)) continue;
    const reason = validateShifts(editor, ti, computeRippleShiftsForRanges(track.clips, merged));
    if (reason !== null) return { kind: "refused", reason };
  }

  const anchorBeforeIds = tracks[trackIndex].clips.map((c) => c.id);

  let shiftedClips = 0;
  editor.perform("Ripple Delete", () => {
    for (const tid of clearTrackIds) {
      const ti = editor.timeline.tracks.findIndex((t) => t.id === tid);
      if (ti < 0) continue;
      for (const r of merged) clearRegion(editor, ti, r.start, r.end, { prune: false });
    }
    editor.timeline.tracks.forEach((track, ti) => {
      if (!(clearTrackIds.has(track.id) || (track.syncLocked && !ignoredTrackIds.has(track.id)))) return;
      shiftedClips += applyShifts(editor, computeRippleShiftsForRanges(track.clips, merged));
      editor.sortClips(ti);
    });
    applyRippledMarkers(editor, rippleMarkersClosing(editor.timeline.markers, [merged]));
  });

  // Anchor track's post-cut layout (surviving + new fragments) so the caller needn't re-read.
  const found = editor.timeline.tracks.findIndex((t) => t.id === anchorTrackId);
  const anchorTi = found < 0 ? trackIndex : found;
  const afterClips = editor.timeline.tracks[anchorTi].clips;
  const afterIds = new Set(afterClips.map((c) => c.id));
  const fragments = [...afterClips]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((c) => ({ clipId: c.id, startFrame: c.startFrame, durationFrames: c.durationFrames }));
  return {
    kind: "ok",
    report: {
      removedFrames: totalRemoved,
      clearedTracks: clearTrackIds.size,
      shiftedClips,
      anchorTrackIndex: anchorTi,
      resultingFragments: fragments,
      removedClipIds: anchorBeforeIds.filter((id) => !afterIds.has(id)),
    },
  };
}

export function rippleDeleteSelectedGap(editor: Editor): void {
  const gap = editor.ui.selectedGap;
  if (!gap) return;
  rippleDelete(editor, gap);
}

export function rippleDeleteGapRefusal(editor: Editor, gap: GapSelection): string | null {
  const tracks = editor.timeline.tracks;
  const gapShiftingIds = new Set(tracks.filter((t, i) => i === gap.trackIndex || t.syncLocked).map((t) => t.id));
  const reason = multicamManualRippleViolation(editor, gapShiftingIds, gap.range.end);
  if (reason !== null) return reason;
  for (let ti = 0; ti < tracks.length; ti++) {
    if (ti === gap.trackIndex || !tracks[ti].syncLocked) continue;
    const shifts = computeRippleShiftsForRanges(tracks[ti].clips, [gap.range]);
    const r = validateShifts(editor, ti, shifts);
    if (r !== null) return r;
  }
  return null;
}

export function rippleDelete(editor: Editor, gap: GapSelection): void {
  const tracks = editor.timeline.tracks;
  if (!(gap.trackIndex >= 0 && gap.trackIndex < tracks.length) || !(frameRangeLength(gap.range) > 0)) return;
  if (tracks[gap.trackIndex].clips.some((c) => c.startFrame < gap.range.end && clipEndFrame(c) > gap.range.start)) {
    editor.ui.selectedGap = null;
    return;
  }

  const reason = rippleDeleteGapRefusal(editor, gap);
  if (reason !== null) {
    refuseRipple(editor, reason);
    return;
  }

  editor.perform("Ripple Delete", () => {
    editor.timeline.tracks.forEach((track, ti) => {
      if (ti !== gap.trackIndex && !track.syncLocked) return;
      applyShifts(editor, computeRippleShiftsForRanges(track.clips, [gap.range]));
    });
    applyRippledMarkers(editor, rippleMarkersClosing(editor.timeline.markers, [[gap.range]]));
  });
  editor.ui.selectedGap = null;
}

/**
 * Ripple insert: add clips at `atFrame` and push everything past it right by the insertion's duration
 * on the target track and every sync-locked track.
 */
export function rippleInsertClips(
  editor: Editor,
  assets: readonly MediaAsset[],
  trackIndex: number,
  atFrame: number,
  segments: Record<string, SourceSegment> = {},
): string[] {
  if (!(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length)) return [];
  const reason = multicamManualRippleViolation(editor, rippleInsertShiftingTrackIds(editor, trackIndex), atFrame);
  if (reason !== null) {
    refuseRipple(editor, reason);
    return [];
  }
  let created: string[] = [];
  editor.perform("Ripple Insert Clips", () => {
    const totalPush = assets.reduce((acc, a) => acc + clipDurationFrames(editor, a, segments[a.id]), 0);

    editor.timeline.tracks.forEach((track, ti) => {
      if (ti !== trackIndex && !track.syncLocked) return;
      applyShifts(editor, computeRipplePush(track.clips, atFrame, totalPush));
    });
    applyRippledMarkers(editor, rippleMarkersOpening(editor.timeline.markers, atFrame, totalPush));
    created = createClips(editor, assets, trackIndex, atFrame, { segments });
    editor.sortClips(trackIndex);
  });
  return created;
}

export interface RippleInsertPreviewPlan {
  gapRangesByTrackIndex: Map<number, FrameRange>;
  /** Keyed by `trackDropTargetKey(target)`. */
  newTrackGapRangesByTarget: Map<string, FrameRange>;
  shiftDeltasByClipId: Map<string, number>;
}

export function planRippleInsertPreview(editor: Editor, plan: DropPlan, atFrame: number): RippleInsertPreviewPlan | null {
  const gapLengthsByTrackIndex = new Map<number, number>();
  const newTrackGapLengthsByTarget = new Map<string, number>();
  const shiftDeltasByClipId = new Map<string, number>();
  const tracks = editor.timeline.tracks;

  const currentTrackIndex = (target: TrackDropTarget, shiftedBy: TrackDropTarget | undefined): number | undefined => {
    if (target.kind !== "existingTrack") return undefined;
    let index = target.index;
    if (shiftedBy && shiftedBy.kind === "newTrackAt" && index > shiftedBy.index) index -= 1;
    return index >= 0 && index < tracks.length ? index : undefined;
  };

  const affectedTrackIndexes = (target: TrackDropTarget, shiftedBy: TrackDropTarget | undefined): Set<number> => {
    const indexes = new Set<number>();
    tracks.forEach((t, i) => {
      if (t.syncLocked) indexes.add(i);
    });
    const index = currentTrackIndex(target, shiftedBy);
    if (index !== undefined) indexes.add(index);
    return indexes;
  };

  const addPush = (target: TrackDropTarget | undefined, shiftedBy: TrackDropTarget | undefined, pushAmount: number): void => {
    if (!target || !(pushAmount > 0)) return;
    if (target.kind === "newTrackAt") {
      const key = trackDropTargetKey(target);
      newTrackGapLengthsByTarget.set(key, (newTrackGapLengthsByTarget.get(key) ?? 0) + pushAmount);
    }
    for (const trackIndex of affectedTrackIndexes(target, shiftedBy)) {
      const clips = tracks[trackIndex].clips;
      const startFramesByClipId = new Map(clips.map((c) => [c.id, c.startFrame] as const));
      for (const shift of computeRipplePush(clips, atFrame, pushAmount)) {
        const original = startFramesByClipId.get(shift.clipId);
        if (original === undefined) continue;
        shiftDeltasByClipId.set(shift.clipId, (shiftDeltasByClipId.get(shift.clipId) ?? 0) + shift.newStartFrame - original);
      }
      gapLengthsByTrackIndex.set(trackIndex, (gapLengthsByTrackIndex.get(trackIndex) ?? 0) + pushAmount);
    }
  };

  addPush(plan.visualTarget, undefined, dropPlanVisualDurationFrames(plan));
  addPush(audioTargetAfterVisualInsertion(plan), plan.visualTarget, dropPlanAudioOnlyDurationFrames(plan));

  if (gapLengthsByTrackIndex.size === 0 && newTrackGapLengthsByTarget.size === 0 && shiftDeltasByClipId.size === 0) return null;
  const gapRangesByTrackIndex = new Map<number, FrameRange>();
  for (const [i, len] of gapLengthsByTrackIndex) gapRangesByTrackIndex.set(i, makeFrameRange(atFrame, atFrame + len));
  const newTrackGapRangesByTarget = new Map<string, FrameRange>();
  for (const [k, len] of newTrackGapLengthsByTarget) newTrackGapRangesByTarget.set(k, makeFrameRange(atFrame, atFrame + len));
  return { gapRangesByTrackIndex, newTrackGapRangesByTarget, shiftDeltasByClipId };
}

export interface RippleInsertSpec {
  asset: MediaAsset;
  durationFrames: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
}

/**
 * Ripple insert with explicit per-clip duration and trim. Opens a gap at `atFrame` on the target track, every
 * sync-locked track, and the audio track any linked audio lands on, then places the clips sequentially.
 */
export function rippleInsertClipsWithSpecs(
  editor: Editor,
  specs: readonly RippleInsertSpec[],
  trackIndex: number,
  atFrame: number,
): string[] {
  if (!(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length) || specs.length === 0) return [];
  const reason = multicamManualRippleViolation(editor, rippleInsertShiftingTrackIds(editor, trackIndex), atFrame);
  if (reason !== null) {
    refuseRipple(editor, reason);
    return [];
  }
  const created: string[] = [];
  editor.perform(specs.length === 1 ? "Ripple Insert Clip (Agent)" : "Ripple Insert Clips (Agent)", () => {
    const totalPush = specs.reduce((acc, s) => acc + s.durationFrames, 0);

    // Pin the linked-audio destination before pushing so it ripples too; otherwise the
    // auto-created audio partner would land on an un-pushed track and overlap.
    const targetIsVideo = editor.timeline.tracks[trackIndex].type === "video";
    const needsLinkedAudio =
      targetIsVideo && specs.some((s) => s.asset.hasAudio && (s.asset.type === "video" || s.asset.type === "sequence"));
    let linkedAudioTrackIndex: number | undefined;
    if (needsLinkedAudio) {
      const existing = editor.timeline.tracks.findIndex((t) => t.type === "audio");
      linkedAudioTrackIndex = existing >= 0 ? existing : insertTrack(editor, editor.timeline.tracks.length, "audio");
    }

    // Tracks the gap opens on. Splitting below doesn't add tracks, so these stay valid.
    const pushTracks: number[] = [];
    editor.timeline.tracks.forEach((t, i) => {
      if (i === trackIndex || i === linkedAudioTrackIndex || t.syncLocked) pushTracks.push(i);
    });

    // Insert-edit: split any clip straddling atFrame on each pushed track so its right half rides the ripple.
    // splitClip also splits linked partners, so a clip already cut via its partner is no longer a straddler.
    for (const ti of pushTracks) {
      const straddler = editor.timeline.tracks[ti].clips.find((c) => c.startFrame < atFrame && atFrame < clipEndFrame(c));
      if (straddler) splitClip(editor, straddler.id, atFrame);
    }

    for (const ti of pushTracks) {
      applyShifts(editor, computeRipplePush(editor.timeline.tracks[ti].clips, atFrame, totalPush));
    }
    applyRippledMarkers(editor, rippleMarkersOpening(editor.timeline.markers, atFrame, totalPush));

    let cursor = atFrame;
    for (const spec of specs) {
      created.push(
        ...placeClip(editor, spec.asset, trackIndex, cursor, spec.durationFrames, {
          linkedAudioTrackIndex,
          trimStartFrame: spec.trimStartFrame,
          trimEndFrame: spec.trimEndFrame,
        }),
      );
      cursor += spec.durationFrames;
    }
  });
  return created;
}

// MARK: - Internal

function trimClipInternal(
  editor: Editor,
  clipId: string,
  trimStartFrame: number,
  trimEndFrame: number,
  protecting: ReadonlySet<string>,
): void {
  const loc = editor.findClip(clipId);
  if (!loc) return;
  const ti = loc.trackIndex;
  // Value copy: the clip's pre-trim frames are read after the draft is mutated below.
  const clip = snapshot(editor.timeline.tracks[ti].clips[loc.clipIndex]);
  // The incoming trim values are source frames; translate their deltas into timeline frames.
  const deltaStartTimeline = swiftRound((trimStartFrame - clip.trimStartFrame) / clip.speed);
  const deltaEndTimeline = swiftRound((trimEndFrame - clip.trimEndFrame) / clip.speed);
  const newDuration = clip.durationFrames - deltaStartTimeline - deltaEndTimeline;
  const newStartFrame = clip.startFrame + deltaStartTimeline;

  editor.perform("Trim Clip", () => {
    const prevStartFrame = clip.startFrame;
    const prevEndFrame = clipEndFrame(clip);
    const newEndFrame = newStartFrame + newDuration;
    const protectedIds = new Set([...protecting, clipId]);
    if (newStartFrame < prevStartFrame) {
      clearRegion(editor, ti, newStartFrame, prevStartFrame, { prune: false, excluding: protectedIds });
    }
    if (newEndFrame > prevEndFrame) {
      clearRegion(editor, ti, prevEndFrame, newEndFrame, { prune: false, excluding: protectedIds });
    }

    const l = editor.findClip(clipId);
    if (!l) return;
    const target = editor.timeline.tracks[l.trackIndex].clips[l.clipIndex];
    target.trimStartFrame = trimStartFrame;
    target.trimEndFrame = trimEndFrame;
    target.startFrame = newStartFrame;
    clipSetDuration(target, newDuration);

    editor.sortClips(l.trackIndex);
  });
}

// MARK: - Validation

/** Dry-run: returns a blocking reason (collision or negative startFrame) or null if safe. */
export function validateShifts(editor: Editor, trackIndex: number, shifts: readonly ClipShift[]): string | null {
  if (shifts.length === 0 || !(trackIndex >= 0 && trackIndex < editor.timeline.tracks.length)) return null;
  const track = editor.timeline.tracks[trackIndex];
  const label = timelineTrackDisplayLabel(editor, trackIndex);
  const shiftMap = new Map(shifts.map((s) => [s.clipId, s.newStartFrame] as const));
  const intervals: FrameRange[] = [];
  for (const clip of track.clips) {
    const start = shiftMap.get(clip.id) ?? clip.startFrame;
    if (start < 0) return `Sync-locked track "${label}" would move past the timeline start.`;
    intervals.push(makeFrameRange(start, start + clip.durationFrames));
  }
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end) return `Sync-locked track "${label}" doesn't have room to ripple.`;
  }
  return null;
}

function refuseRipple(editor: Editor, reason: string): void {
  editor.refuseWithToast(reason);
}

// MARK: - Multicam atomicity

function rippleInsertShiftingTrackIds(editor: Editor, trackIndex: number): Set<string> {
  return new Set(editor.timeline.tracks.filter((t, i) => i === trackIndex || t.syncLocked).map((t) => t.id));
}

export function multicamManualRippleViolation(editor: Editor, shiftingTrackIds: ReadonlySet<string>, frame: number): string | null {
  const atomicity = multicamAtomicityViolation(editor, shiftingTrackIds);
  if (atomicity !== null) return atomicity;
  for (const track of editor.timeline.tracks) {
    if (!shiftingTrackIds.has(track.id)) continue;
    const clip = track.clips.find((c) => c.multicamGroupId !== undefined && c.startFrame < frame && clipEndFrame(c) > frame);
    const group = clip ? multicamGroupOf(editor, clip) : undefined;
    if (group) {
      return `Can't ripple through multicam group "${group.name}" — split its clips at the edit point, or remove silence/words to cut time.`;
    }
  }
  return null;
}

export function multicamAtomicityViolation(editor: Editor, shiftingTrackIds: ReadonlySet<string>): string | null {
  const tracks = editor.timeline.tracks;
  const groupTracks = new Map<string, Set<string>>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.multicamGroupId === undefined) continue;
      const set = groupTracks.get(clip.multicamGroupId) ?? new Set<string>();
      set.add(track.id);
      groupTracks.set(clip.multicamGroupId, set);
    }
  }
  for (const [gid, trackIds] of groupTracks) {
    const moving = [...trackIds].filter((id) => shiftingTrackIds.has(id));
    if (moving.length === 0 || moving.length === trackIds.size) continue;
    const name = multicamGroupById(editor, gid)?.name ?? "Multicam";
    const stranded: string[] = [];
    tracks.forEach((t, i) => {
      if (!shiftingTrackIds.has(t.id) && trackIds.has(t.id)) stranded.push(timelineTrackDisplayLabel(editor, i));
    });
    return `Can't shift part of multicam group "${name}" — ${stranded.join(", ")} would stay behind and desync.`;
  }
  return null;
}
