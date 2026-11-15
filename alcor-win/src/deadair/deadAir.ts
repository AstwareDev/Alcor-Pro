// Port of Editor/ViewModel/EditorViewModel+DeadAir.swift: maps speech masks onto timeline ranges and ripple-deletes them.
// Mask lookups go through `DeadAirServices` (production: `deadAirServices`; tests inject stubs).
import { clipSourceFramesConsumed, multicamMemberWithMediaRef, multicamMics, type Clip, type MulticamMember, type MulticamSource } from "../model";
import type { Editor } from "../editor/editor";
import { makeFrameRange, mergeRanges, type FrameRange } from "../editor/rippleEngine";
import { rippleDeleteRangesOnTrack } from "../editor/mutations/ripple";
import { multicamGroupOf } from "../editor/mutations/multicamRules";
import { swiftRound } from "../util/math";
import {
  removableMask, visibleRemovableRanges, vadChunkDuration, type SilenceRemovalSettings, type SourceRange,
} from "./silenceRemovalSettings";

export interface DeadAirServices {
  quietNonSpeechMask(editor: Editor, mediaRef: string): boolean[] | undefined;
  deadAirMask(editor: Editor, mediaRef: string, settings: SilenceRemovalSettings): boolean[] | undefined;
  maskCache: DeadAirMaskCache;
}

export class DeadAirSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadAirSelectionError";
  }
}

export interface DeadAirResult {
  sections: number;
  removedFrames: number;
  refusal?: string;
}

// MARK: - Multicam mask resolution

export const DeadAirMaskResolver = {
  /** A multicam member's dead-air mask: cells where every mic is quiet, then minimum-pause and padding policy. */
  mask(
    clip: Clip,
    group: MulticamSource,
    settings: SilenceRemovalSettings,
    quietMaskForMedia: (mediaRef: string) => readonly boolean[] | undefined,
  ): boolean[] | undefined {
    const member = multicamMemberWithMediaRef(group, clip.mediaRef);
    if (!member || clip.mediaType !== "audio") return undefined;
    const microphones = multicamMics(group);
    if (microphones.length === 0) return undefined;
    const cellSeconds = vadChunkDuration;
    const aligned: { values: readonly boolean[]; offset: number }[] = [];
    for (const microphone of microphones) {
      const values = quietMaskForMedia(microphone.mediaRef);
      if (!values || values.length === 0) return undefined;
      aligned.push({ values, offset: swiftRound(microphone.sync.offsetSeconds / cellSeconds) });
    }

    const count = aligned.reduce((m, a) => Math.max(m, a.values.length + a.offset), 0);
    const groupMask = new Array<boolean>(Math.max(0, count)).fill(true);
    for (let i = 0; i < count; i++) {
      for (const mask of aligned) {
        const sourceIndex = i - mask.offset;
        if (sourceIndex >= 0 && sourceIndex < mask.values.length && !mask.values[sourceIndex]) {
          groupMask[i] = false;
          break;
        }
      }
    }

    const shift = swiftRound(member.sync.offsetSeconds / cellSeconds);
    let memberMask: boolean[];
    if (shift > 0) memberMask = groupMask.slice(shift);
    else if (shift < 0) memberMask = [...new Array<boolean>(-shift).fill(false), ...groupMask];
    else memberMask = groupMask;
    return removableMask(memberMask, settings);
  },
};

// MARK: - Mask cache

function memberKey(m: MulticamMember): string {
  return `${m.id}|${m.mediaRef}|${m.sync.offsetSeconds}`;
}

export function deadAirMaskKey(group: MulticamSource, member: MulticamMember, settings: SilenceRemovalSettings): string {
  return [
    group.id,
    memberKey(member),
    multicamMics(group).map(memberKey).join(","),
    settings.minimumPauseSeconds,
    settings.speechPaddingSeconds,
  ].join("#");
}

/** Bounded FIFO cache of derived multicam dead-air masks (`DeadAirMaskCache`, capacity 256). */
export class DeadAirMaskCache {
  private static readonly capacity = 256;
  private readonly values = new Map<string, boolean[]>();

  value(key: string, build: () => boolean[] | undefined): boolean[] | undefined {
    const cached = this.values.get(key);
    if (cached) return cached;
    const built = build();
    if (!built) return undefined;
    if (this.values.size >= DeadAirMaskCache.capacity) {
      const evicted = this.values.keys().next();
      if (!evicted.done) this.values.delete(evicted.value);
    }
    this.values.set(key, built);
    return built;
  }

  reset(): void {
    this.values.clear();
  }
}

// MARK: - Ranges

/** Every dead-air span visible in `clip`, in source-frame coordinates. */
export function deadAirSourceRanges(editor: Editor, clip: Clip, settings: SilenceRemovalSettings, services: DeadAirServices): SourceRange[] {
  let mask: boolean[] | undefined;
  const group = multicamGroupOf(editor, clip);
  if (group) {
    const member = multicamMemberWithMediaRef(group, clip.mediaRef);
    if (!member) return [];
    mask = services.maskCache.value(deadAirMaskKey(group, member, settings), () =>
      DeadAirMaskResolver.mask(clip, group, settings, (ref) => services.quietNonSpeechMask(editor, ref)),
    );
  } else {
    mask = services.deadAirMask(editor, clip.mediaRef, settings);
  }
  if (!mask || mask.length === 0) return [];
  const visibleStart = clip.trimStartFrame;
  const visibleEnd = clip.trimStartFrame + clipSourceFramesConsumed(clip);
  return visibleRemovableRanges(mask, { lowerBound: visibleStart, upperBound: visibleEnd }, editor.timeline.fps, settings);
}

function timelineRange(clip: Clip, sourceStart: number, sourceEnd: number): FrameRange | undefined {
  const s0 = Math.max(sourceStart, clip.trimStartFrame);
  const s1 = Math.min(sourceEnd, clip.trimStartFrame + clipSourceFramesConsumed(clip));
  if (!(s1 > s0) || !(clip.speed > 0)) return undefined;
  const t0 = clip.startFrame + (s0 - clip.trimStartFrame) / clip.speed;
  const t1 = clip.startFrame + (s1 - clip.trimStartFrame) / clip.speed;
  const range = makeFrameRange(swiftRound(t0), swiftRound(t1));
  return range.end - range.start > 0 ? range : undefined;
}

/** Every dead-air span visible within `clip`, as timeline ranges. */
export function deadAirRanges(editor: Editor, clip: Clip, settings: SilenceRemovalSettings, services: DeadAirServices): FrameRange[] {
  return deadAirSourceRanges(editor, clip, settings, services).flatMap((r) => {
    const range = timelineRange(clip, r.lowerBound, r.upperBound);
    return range ? [range] : [];
  });
}

/** The dead-air span under `frame` in `clip`, as a timeline range. Undefined when the frame isn't dead air. */
export function deadAirSpanRange(editor: Editor, clip: Clip, frame: number, settings: SilenceRemovalSettings, services: DeadAirServices): FrameRange | undefined {
  return deadAirRanges(editor, clip, settings, services).find((r) => r.start <= frame && frame < r.end);
}

/** Dead-air ranges grouped by track; each track ripples its own spans. */
export function allDeadAir(editor: Editor, settings: SilenceRemovalSettings, services: DeadAirServices): { trackIndex: number; ranges: FrameRange[] }[] {
  const out: { trackIndex: number; ranges: FrameRange[] }[] = [];
  editor.timeline.tracks.forEach((track, trackIndex) => {
    if (track.type !== "audio") return;
    const ranges = mergeRanges(track.clips.flatMap((c) => deadAirRanges(editor, c, settings, services)));
    if (ranges.length > 0) out.push({ trackIndex, ranges });
  });
  return out;
}

// MARK: - Removal

/** Removes the single dead-air span under `frame`. Returns the refusal reason when the ripple was refused. */
export function removeDeadAirAtFrame(
  editor: Editor, clipId: string, frame: number, settings: SilenceRemovalSettings, services: DeadAirServices,
): string | undefined {
  const loc = editor.findClip(clipId);
  if (!loc) return undefined;
  const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
  const range = deadAirSpanRange(editor, clip, frame, settings, services);
  if (!range) return undefined;
  const outcome = rippleDeleteRangesOnTrack(editor, loc.trackIndex, [range]);
  return outcome.kind === "refused" ? outcome.reason : undefined;
}

/**
 * Ripples every dead-air span within the given clips on one track or in one linked A/V unit.
 * Throws `DeadAirSelectionError` for an invalid selection; undefined when there is no dead air.
 */
export function removeDeadAirInClips(
  editor: Editor, clipIds: readonly string[], settings: SilenceRemovalSettings, services: DeadAirServices,
): DeadAirResult | undefined {
  const targets: { trackIndex: number; clip: Clip }[] = [];
  for (const id of clipIds) {
    const loc = editor.findClip(id);
    if (loc) targets.push({ trackIndex: loc.trackIndex, clip: editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex] });
  }
  if (targets.length !== clipIds.length || targets.length === 0) throw new DeadAirSelectionError("Selected clips could not be resolved.");
  const audioTargets = targets.filter((t) => t.clip.mediaType === "audio");
  if (audioTargets.length === 0) throw new DeadAirSelectionError("Selected clips must include at least one audio clip.");

  if (new Set(targets.map((t) => t.trackIndex)).size > 1) {
    const linkGroups = targets.flatMap((t) => (t.clip.linkGroupId === undefined ? [] : [t.clip.linkGroupId]));
    if (linkGroups.length !== targets.length || new Set(linkGroups).size !== 1) {
      throw new DeadAirSelectionError("Selected clips must share one track or belong to one linked A/V unit.");
    }
  }
  const audioTrackIndices = new Set(audioTargets.map((t) => t.trackIndex));
  if (audioTrackIndices.size !== 1) throw new DeadAirSelectionError("Selected audio clips must come from one track.");
  const [anchorTrackIndex] = [...audioTrackIndices];

  const ranges = mergeRanges(audioTargets.flatMap((t) => deadAirRanges(editor, t.clip, settings, services)));
  if (ranges.length === 0) return undefined;
  return editor.perform("Remove Dead Air", () => {
    const outcome = rippleDeleteRangesOnTrack(editor, anchorTrackIndex, ranges);
    if (outcome.kind === "ok") return { sections: ranges.length, removedFrames: outcome.report.removedFrames };
    return { sections: 0, removedFrames: 0, refusal: outcome.reason };
  });
}

/** Ripples dead air per track, recomputing ranges between passes. Stops if a track refuses. */
export function removeAllDeadAir(editor: Editor, settings: SilenceRemovalSettings, services: DeadAirServices): DeadAirResult | undefined {
  return editor.perform("Remove Dead Air", () => {
    let sections = 0;
    let removedFrames = 0;
    let refusal: string | undefined;
    for (let pass = 0; pass < editor.timeline.tracks.length; pass++) {
      const next = allDeadAir(editor, settings, services)[0];
      if (!next) break;
      const outcome = rippleDeleteRangesOnTrack(editor, next.trackIndex, next.ranges);
      if (outcome.kind === "ok") {
        sections += next.ranges.length;
        removedFrames += outcome.report.removedFrames;
      } else {
        refusal = outcome.reason;
        break;
      }
    }
    if (sections === 0 && refusal === undefined) return undefined;
    return refusal === undefined ? { sections, removedFrames } : { sections, removedFrames, refusal };
  });
}
