import {
  clipBlurKeyframeTrack,
  clipSourceFramesConsumed,
  splitValues,
  clipEndFrame,
  makeClip,
  makeCrop,
  makeTrack,
  multicamMemberAnchorFrame,
  multicamMemberOffsetFrames,
  multicamMemberWithMediaRef,
  videoLayoutSlots,
  type Clip,
  type Crop,
  type LayoutRect,
  type MulticamMember,
  type MulticamSource,
  type Timeline,
  type Track,
  type Transform,
  type VideoLayout,
} from "../model";
import { swiftRound } from "../util/math";
import { snapshot } from "../util/snapshot";

/** Swift `Range<Int>`: half-open frame range. */
export interface FrameSpan {
  lowerBound: number;
  upperBound: number;
}

export function spanIsEmpty(r: FrameSpan): boolean {
  return r.lowerBound === r.upperBound;
}

export function spanCount(r: FrameSpan): number {
  return r.upperBound - r.lowerBound;
}

function spanEquals(a: FrameSpan, b: FrameSpan): boolean {
  return a.lowerBound === b.lowerBound && a.upperBound === b.upperBound;
}

/** Swift `Range.clamped(to:)`. */
export function spanClamped(r: FrameSpan, limits: FrameSpan): FrameSpan {
  const lowerBound =
    limits.lowerBound > r.lowerBound ? limits.lowerBound : limits.upperBound < r.lowerBound ? limits.upperBound : r.lowerBound;
  const upperBound =
    limits.upperBound < r.upperBound ? limits.upperBound : limits.lowerBound > r.upperBound ? limits.lowerBound : r.upperBound;
  return { lowerBound, upperBound };
}

export interface MulticamEntry {
  range: FrameSpan;
  slots: MulticamMember[];
  layout?: VideoLayout;
}

export function multicamEntryMember(e: MulticamEntry): MulticamMember {
  return e.slots[0] as MulticamMember;
}

export interface MulticamOutcome {
  switched: number;
  merged: number;
  applied: FrameSpan[];
  clamped: { requested: FrameSpan; applied: FrameSpan; culprit: string }[];
  skipped: { range: FrameSpan; reason: string }[];
  overlayClipIds: string[];
}

export function makeMulticamOutcome(): MulticamOutcome {
  return { switched: 0, merged: 0, applied: [], clamped: [], skipped: [], overlayClipIds: [] };
}

export type MulticamPlacement = (clip: Clip, rect: LayoutRect) => { transform: Transform; crop: Crop };

export function maxLagHops(windowSeconds: number, hopSeconds: number, referenceCount: number, targetCount: number): number {
  const windowHops = swiftRound(windowSeconds / hopSeconds);
  return Math.max(1, Math.min(windowHops, Math.trunc(Math.min(referenceCount, targetCount) / 2)));
}

/** Mutates `timeline` in place (Swift `inout`; callers pass an Immer draft). */
export function applyMulticamEntries(
  entries: readonly MulticamEntry[],
  timeline: Timeline,
  group: MulticamSource,
  sourceDurations: ReadonlyMap<string, number>,
  fitTransform: (clip: Clip) => Transform,
  placement: MulticamPlacement,
): MulticamOutcome {
  const outcome = makeMulticamOutcome();
  const fps = timeline.fps;

  for (const entry of entries) {
    if (spanIsEmpty(entry.range)) continue;
    const programId = programTrackId(timeline, group, entry.range);
    if (programId === undefined) {
      outcome.skipped.push({ range: entry.range, reason: "no multicam clip in this range" });
      continue;
    }
    const fragmentIds = clipsIn(timeline, programId)
      .filter((c) => isProgramFragment(c, group) && overlaps(c, entry.range))
      .map((c) => c.id);
    const entryMember = multicamEntryMember(entry);
    const layout: VideoLayout = entry.layout ?? "full";

    for (const fragmentId of fragmentIds) {
      const found = clipsIn(timeline, programId).find((c) => c.id === fragmentId);
      if (!found) continue;
      const fragment = snapshot(found);
      const member = multicamMemberWithMediaRef(group, fragment.mediaRef);
      if (!member) continue;

      const wanted = spanClamped(entry.range, { lowerBound: fragment.startFrame, upperBound: clipEndFrame(fragment) });
      const { range: target, culprit } = clampToCoverage(wanted, fragment, member, entryMember, sourceDurations, fps);
      if (spanIsEmpty(target)) {
        outcome.skipped.push({ range: wanted, reason: `${culprit ?? "an angle"} wasn't recording here` });
        continue;
      }
      if (culprit !== undefined) outcome.clamped.push({ requested: wanted, applied: target, culprit });

      const hadLayout = clearOverlays(target, programId, timeline, group.id) > 0;
      const layoutSlots = videoLayoutSlots(layout);
      const programRect = layoutSlots[0]?.rect;
      const overlaySlots = layoutSlots.slice(1);
      const overlayMembers = entry.slots.slice(1);
      for (let i = 0; i < Math.min(overlaySlots.length, overlayMembers.length); i++) {
        const slot = overlaySlots[i];
        const slotMember = overlayMembers[i];
        if (!slot || !slotMember) continue;
        const id = placeOverlay(slotMember, target, fragment, member, programId, timeline, group, sourceDurations, fps, (c) =>
          placement(c, slot.rect),
        );
        if (id !== undefined) outcome.overlayClipIds.push(id);
      }

      withTrack(timeline, programId, (track) => {
        split(track, target.lowerBound);
        split(track, target.upperBound);
        for (const clip of track.clips) {
          if (!(isProgramFragment(clip, group) && clip.startFrame >= target.lowerBound && clipEndFrame(clip) <= target.upperBound)) continue;
          const wasDefaultFit = valueEquals(clip.transform, fitTransform(clip)) && valueEquals(clip.crop, makeCrop());
          rewrite(clip, group, entryMember, sourceDurations, fps);
          if (layout !== "full" && programRect) {
            const placed = placement(clip, programRect);
            clip.transform = placed.transform;
            clip.crop = placed.crop;
          } else if (wasDefaultFit || hadLayout) {
            clip.transform = fitTransform(clip);
            if (hadLayout) clip.crop = makeCrop();
          }
          outcome.switched += 1;
        }
        outcome.merged += joinThroughEdits(track, [target], group.id);
      });
      outcome.applied.push(target);
    }
  }
  return outcome;
}

// MARK: - Addressing

function clipsIn(timeline: Timeline, trackId: string): Clip[] {
  return timeline.tracks.find((t) => t.id === trackId)?.clips ?? [];
}

function withTrack(timeline: Timeline, id: string, body: (track: Track) => void): void {
  const track = timeline.tracks.find((t) => t.id === id);
  if (track) body(track);
}

function isProgramFragment(clip: Clip, group: MulticamSource): boolean {
  return clip.multicamGroupId === group.id && clip.mediaType !== "audio";
}

function overlaps(clip: Clip, range: FrameSpan): boolean {
  return clip.startFrame < range.upperBound && clipEndFrame(clip) > range.lowerBound;
}

function hasKeyframes(clip: Clip): boolean {
  return (
    clip.opacityTrack !== undefined ||
    clip.positionTrack !== undefined ||
    clip.scaleTrack !== undefined ||
    clip.rotationTrack !== undefined ||
    clip.cropTrack !== undefined ||
    clipBlurKeyframeTrack(clip) !== undefined ||
    clip.volumeTrack !== undefined
  );
}

function programTrackId(timeline: Timeline, group: MulticamSource, range: FrameSpan): string | undefined {
  for (let i = timeline.tracks.length - 1; i >= 0; i--) {
    const t = timeline.tracks[i] as Track;
    if (t.type === "video" && t.clips.some((c) => isProgramFragment(c, group) && overlaps(c, range))) return t.id;
  }
  return undefined;
}

function clampToCoverage(
  wanted: FrameSpan,
  fragment: Clip,
  current: MulticamMember,
  target: MulticamMember,
  sourceDurations: ReadonlyMap<string, number>,
  fps: number,
): { range: FrameSpan; culprit: string | undefined } {
  const duration = sourceDurations.get(target.mediaRef);
  if (duration === undefined) return { range: wanted, culprit: undefined };
  const groupStart = fragment.trimStartFrame / fps + current.sync.offsetSeconds;
  const projectFrame = (groupSeconds: number): number =>
    fragment.startFrame + swiftRound((groupSeconds - groupStart) * fps);
  const coverage: FrameSpan = {
    lowerBound: projectFrame(target.sync.offsetSeconds),
    upperBound: projectFrame(target.sync.offsetSeconds + duration),
  };
  const clamped = spanClamped(wanted, coverage);
  return { range: clamped, culprit: spanEquals(clamped, wanted) ? undefined : target.angleLabel };
}

function placeOverlay(
  member: MulticamMember,
  range: FrameSpan,
  anchor: Clip,
  anchorMember: MulticamMember,
  programId: string,
  timeline: Timeline,
  group: MulticamSource,
  sourceDurations: ReadonlyMap<string, number>,
  fps: number,
  style: (clip: Clip) => { transform: Transform; crop: Crop },
): string | undefined {
  const clip = makeClip({ mediaRef: member.mediaRef, startFrame: range.lowerBound, durationFrames: spanCount(range) });
  clip.multicamGroupId = group.id;
  const groupFrame = range.lowerBound - multicamMemberAnchorFrame(anchorMember, anchor, fps);
  clip.trimStartFrame = groupFrame - multicamMemberOffsetFrames(member, fps);
  const duration = sourceDurations.get(member.mediaRef);
  if (duration !== undefined) {
    const sourceLen = swiftRound(duration * fps);
    clip.trimEndFrame = Math.max(0, sourceLen - clip.trimStartFrame - clipSourceFramesConsumed(clip));
  }
  const placed = style(clip);
  clip.transform = placed.transform;
  clip.crop = placed.crop;

  const programIdx = timeline.tracks.findIndex((t) => t.id === programId);
  if (programIdx < 0) return undefined;
  let free = -1;
  for (let i = programIdx - 1; i >= 0; i--) {
    const t = timeline.tracks[i] as Track;
    if (t.type === "video" && !t.clips.some((c) => overlaps(c, range))) {
      free = i;
      break;
    }
  }
  let idx = free;
  if (idx < 0) {
    timeline.tracks.splice(programIdx, 0, makeTrack({ type: "video" }));
    idx = programIdx;
  }
  const target = timeline.tracks[idx] as Track;
  target.clips.push(clip);
  target.clips.sort((a, b) => a.startFrame - b.startFrame);
  return clip.id;
}

function clearOverlays(range: FrameSpan, programId: string, timeline: Timeline, groupId: string): number {
  const programIdx = timeline.tracks.findIndex((t) => t.id === programId);
  if (programIdx < 0) return 0;
  let removed = 0;
  for (const trackId of timeline.tracks.slice(0, programIdx).map((t) => t.id)) {
    withTrack(timeline, trackId, (track) => {
      split(track, range.lowerBound, groupId);
      split(track, range.upperBound, groupId);
      const before = track.clips.length;
      track.clips = track.clips.filter(
        (c) => !(c.multicamGroupId === groupId && c.startFrame >= range.lowerBound && clipEndFrame(c) <= range.upperBound),
      );
      removed += before - track.clips.length;
    });
  }
  return removed;
}

// MARK: - Clip surgery

export function rewrite(
  clip: Clip,
  group: MulticamSource,
  member: MulticamMember,
  sourceDurations: ReadonlyMap<string, number>,
  fps: number,
): void {
  if (clip.mediaRef === member.mediaRef) return;
  const current = multicamMemberWithMediaRef(group, clip.mediaRef);
  if (!current) return;
  const delta = swiftRound((current.sync.offsetSeconds - member.sync.offsetSeconds) * fps);
  clip.mediaRef = member.mediaRef;
  clip.trimStartFrame += delta;
  const duration = sourceDurations.get(member.mediaRef);
  if (duration !== undefined) {
    const sourceLen = swiftRound(duration * fps);
    clip.trimEndFrame = Math.max(0, sourceLen - clip.trimStartFrame - clipSourceFramesConsumed(clip));
  } else {
    clip.trimEndFrame = 0;
  }
}

function split(track: Track, frame: number, onlyGroup?: string): boolean {
  const i = track.clips.findIndex(
    (c) => frame > c.startFrame && frame < clipEndFrame(c) && (onlyGroup === undefined || c.multicamGroupId === onlyGroup),
  );
  if (i < 0) return false;
  const values = splitValues(track.clips[i] as Clip, frame);
  if (!values) return false;
  track.clips[i] = values.left;
  track.clips.splice(i + 1, 0, values.right);
  return true;
}

// MARK: - Sanitization

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!valueEquals(ra[k], rb[k])) return false;
  return true;
}

function isThroughEdit(a: Clip, b: Clip): boolean {
  return (
    a.mediaRef === b.mediaRef &&
    a.mediaType === b.mediaType &&
    a.multicamGroupId === b.multicamGroupId &&
    b.startFrame === clipEndFrame(a) &&
    b.trimStartFrame === a.trimStartFrame + clipSourceFramesConsumed(a) &&
    a.speed === b.speed &&
    a.volume === b.volume &&
    a.opacity === b.opacity &&
    valueEquals(a.transform, b.transform) &&
    valueEquals(a.crop, b.crop) &&
    a.edgeRounding === b.edgeRounding &&
    a.edgeSoftness === b.edgeSoftness &&
    valueEquals(a.effects, b.effects) &&
    a.blendMode === b.blendMode &&
    a.fadeOutFrames === 0 &&
    b.fadeInFrames === 0 &&
    !hasKeyframes(a) &&
    !hasKeyframes(b)
  );
}

function joinThroughEdits(track: Track, ranges: readonly FrameSpan[], groupId: string): number {
  if (ranges.length === 0) return 0;
  let merged = 0;
  const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
  let i = 0;
  while (i + 1 < clips.length) {
    const a = clips[i] as Clip;
    const b = clips[i + 1] as Clip;
    const seam = clipEndFrame(a);
    if (a.multicamGroupId === groupId && ranges.some((r) => r.lowerBound <= seam && seam <= r.upperBound) && isThroughEdit(a, b)) {
      a.durationFrames += b.durationFrames;
      a.trimEndFrame = b.trimEndFrame;
      a.fadeOutFrames = b.fadeOutFrames;
      clips.splice(i + 1, 1);
      merged += 1;
    } else {
      i += 1;
    }
  }
  track.clips = clips;
  return merged;
}
