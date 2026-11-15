import {
  clipEndFrame,
  clipSourceFramesConsumed,
  makeClip,
  makeMulticamMember,
  makeMulticamSource,
  makeMulticamSyncMap,
  multicamAngles,
  multicamMemberCoverage,
  multicamMemberLabeled,
  multicamMemberProvidesAudio,
  multicamMemberProvidesVideo,
  multicamMemberTrimFrame,
  multicamMemberUsable,
  multicamMemberWithMediaRef,
  multicamMics,
  timelineTotalFrames,
  videoLayoutSlots,
  type Clip,
  type ClipType,
  type MulticamMember,
  type MulticamMemberKind,
  type MulticamSource,
  type MulticamSyncMap,
  type VideoLayout,
} from "../../model";
import { envelopeHopSeconds, type AudioEnvelope } from "../../media/peaks";
import { throwIfAborted } from "../../media/concurrency";
import { minOverlap } from "../../audio/audioSyncCorrelator";
import type { SyncServices } from "../../audio/sourceTiming";
import {
  applyMulticamEntries,
  maxLagHops,
  rewrite,
  spanClamped,
  spanIsEmpty,
  type FrameSpan,
  type MulticamEntry,
  type MulticamOutcome,
} from "../../timeline/multicamEngine";
import { swiftRound } from "../../util/math";
import type { Editor } from "../editor";
import { fitTransformForAsset, fitTransformForClip } from "./core";
import { layoutPlacement } from "./layout";
import { multicamClips, multicamGroupById, multicamGroupOf } from "./multicamRules";
import { uniqueName } from "./timelines";
import { syncDefaults } from "./sync";
import { insertTrack } from "./tracks";

// Port of Editor/ViewModel/EditorViewModel+Multicam.swift (lookups and edit guards live in multicamRules.ts).

/** Mirrors the Swift `ToolError`s thrown by the view-model; tools surface `message` verbatim. */
export class MulticamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MulticamError";
  }
}

export interface MulticamMemberSpec {
  mediaRef: string;
  kind: MulticamMemberKind;
  angleLabel?: string;
  pinnedOffsetSeconds?: number;
}

export interface MulticamSyncOutcome {
  maps: Map<string, MulticamSyncMap>;
  failures: { mediaRef: string; reason: string }[];
}

export interface AngleSwitchRequest {
  range: FrameSpan;
  angles: string[];
  layout: VideoLayout;
}

export function angleSwitchRequest(range: FrameSpan, angle: string): AngleSwitchRequest {
  return { range, angles: [angle], layout: "full" };
}

// MARK: - Lookup

export function multicamTrackIndexes(editor: Editor, groupId: string): number[] {
  return [...new Set(multicamClips(editor, groupId).map((c) => c.trackIndex))].sort((a, b) => a - b);
}

export function multicamSourceDurations(editor: Editor, group: MulticamSource): Map<string, number> {
  const out = new Map<string, number>();
  for (const member of group.members) {
    const asset = editor.mediaAsset(member.mediaRef);
    if (asset) out.set(member.mediaRef, asset.duration);
  }
  return out;
}

export function multicamAngleLabel(editor: Editor, clip: Clip): string | undefined {
  const group = multicamGroupOf(editor, clip);
  return group ? multicamMemberWithMediaRef(group, clip.mediaRef)?.angleLabel : undefined;
}

export function multicamAudioBearers(editor: Editor, group: MulticamSource): MulticamMember[] {
  return group.members.filter(
    (m) => multicamMemberUsable(m) && (multicamMemberProvidesAudio(m) || editor.mediaAsset(m.mediaRef)?.hasAudio === true),
  );
}

// MARK: - Source sync

export interface SyncMembersOptions {
  specs: readonly MulticamMemberSpec[];
  masterRef: string;
  searchWindowSeconds?: number;
  rebase?: boolean;
  signal?: AbortSignal;
}

interface Anchor {
  offsetSeconds: number;
  mediaRef: string;
  samples: Float32Array;
}

export async function syncMulticamMembers(services: SyncServices, options: SyncMembersOptions): Promise<MulticamSyncOutcome> {
  const { specs, masterRef, signal } = options;
  const searchWindowSeconds = options.searchWindowSeconds ?? syncDefaults.memberSearchWindowSeconds;
  const rebase = options.rebase ?? true;
  const outcome: MulticamSyncOutcome = { maps: new Map(), failures: [] };
  const finish = (): MulticamSyncOutcome => (rebase ? rebased(outcome) : outcome);

  const pending: MulticamMemberSpec[] = [];
  for (const spec of specs) {
    if (spec.pinnedOffsetSeconds !== undefined) {
      outcome.maps.set(spec.mediaRef, makeMulticamSyncMap({ offsetSeconds: spec.pinnedOffsetSeconds, confidence: 1, locked: true }));
    } else if (spec.mediaRef === masterRef) {
      outcome.maps.set(spec.mediaRef, makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }));
    } else {
      pending.push(spec);
    }
  }
  if (pending.length === 0) return finish();

  const refs = [...new Set([masterRef, ...pending.map((s) => s.mediaRef)])];
  const timing = new Map(await Promise.all(refs.map(async (ref) => [ref, await services.timing(ref)] as const)));
  const masterOffset = outcome.maps.get(masterRef)?.offsetSeconds ?? 0;

  const resolveWithoutAudio = (ref: string, reason: string): void => {
    const masterTc = timing.get(masterRef)?.timecode;
    const tc = timing.get(ref)?.timecode;
    if (masterTc && tc) {
      outcome.maps.set(ref, makeMulticamSyncMap({ offsetSeconds: masterOffset + tc.seconds - masterTc.seconds, confidence: 1 }));
    } else {
      outcome.maps.set(ref, makeMulticamSyncMap());
      outcome.failures.push({ mediaRef: ref, reason });
    }
  };

  const envelopeSpan = { start: 0, end: searchWindowSeconds + 300 };
  const masterEnv: AudioEnvelope | null = await services.envelope(masterRef, envelopeSpan, signal);
  throwIfAborted(signal);
  if (!masterEnv || masterEnv.samples.length === 0) {
    outcome.failures.push({ mediaRef: masterRef, reason: "Master has no readable audio." });
    for (const spec of pending) resolveWithoutAudio(spec.mediaRef, "No audio to sync with and no shared timecode.");
    return finish();
  }

  const extracted = new Map(
    await Promise.all(
      pending.map(async (spec) => {
        const env = await services.envelope(spec.mediaRef, envelopeSpan, signal);
        return [spec.mediaRef, env && env.samples.length > 0 ? env.samples : undefined] as const;
      }),
    ),
  );
  throwIfAborted(signal);

  const hop = envelopeHopSeconds;
  const seedWindow = Math.max(1, swiftRound(syncDefaults.dateSeedWindowSeconds / hop));
  const minOverlapHops = Math.max(minOverlap, swiftRound(syncDefaults.minOverlapSeconds / hop));

  const anchors: Anchor[] = [{ offsetSeconds: masterOffset, mediaRef: masterRef, samples: masterEnv.samples }];

  const match = async (anchor: Anchor, ref: string, samples: Float32Array): Promise<{ offset: number; confidence: number } | null> => {
    let seed: number | undefined;
    const anchorDate = timing.get(anchor.mediaRef)?.captureDate;
    const date = timing.get(ref)?.captureDate;
    if (anchorDate !== undefined && date !== undefined) seed = swiftRound((date - anchorDate) / hop);
    const result = await services.correlate(
      {
        reference: anchor.samples,
        target: samples,
        seedHops: seed,
        seedWindowHops: seedWindow,
        maxLagHops: maxLagHops(searchWindowSeconds, hop, anchor.samples.length, samples.length),
        minOverlapHops,
        minConfidence: syncDefaults.minConfidence,
      },
      signal,
    );
    return result ? { offset: anchor.offsetSeconds + result.exactLagHops * hop, confidence: result.confidence } : null;
  };

  const candidates: { ref: string; samples: Float32Array; direct: { offset: number; confidence: number } | null }[] = [];
  for (const spec of pending) {
    const samples = extracted.get(spec.mediaRef);
    if (!samples) {
      resolveWithoutAudio(spec.mediaRef, "No readable audio to sync with.");
      continue;
    }
    candidates.push({ ref: spec.mediaRef, samples, direct: await match(anchors[0], spec.mediaRef, samples) });
    throwIfAborted(signal);
  }

  candidates.sort((a, b) => (b.direct?.confidence ?? 0) - (a.direct?.confidence ?? 0));
  for (const candidate of candidates) {
    let best = candidate.direct;
    for (const anchor of anchors.slice(1)) {
      const hit = await match(anchor, candidate.ref, candidate.samples);
      if (hit && hit.confidence > (best?.confidence ?? 0)) best = hit;
    }
    throwIfAborted(signal);
    if (!best) {
      resolveWithoutAudio(candidate.ref, "No confident alignment — pin an offset or re-sync with a wider window.");
      continue;
    }
    outcome.maps.set(
      candidate.ref,
      makeMulticamSyncMap({ offsetSeconds: best.offset, confidence: swiftRound(best.confidence * 1000) / 1000 }),
    );
    anchors.push({ offsetSeconds: best.offset, mediaRef: candidate.ref, samples: candidate.samples });
  }
  return finish();
}

function rebased(outcome: MulticamSyncOutcome): MulticamSyncOutcome {
  const usable = [...outcome.maps.values()].filter((m) => m.confidence > 0 || m.locked);
  const base = usable.length === 0 ? 0 : Math.min(...usable.map((m) => m.offsetSeconds));
  if (base === 0) return outcome;
  const maps = new Map<string, MulticamSyncMap>();
  for (const [ref, map] of outcome.maps) {
    maps.set(ref, map.confidence > 0 || map.locked ? { ...map, offsetSeconds: map.offsetSeconds - base } : map);
  }
  return { maps, failures: outcome.failures };
}

// MARK: - Creation

export interface CreateMulticamOptions {
  specs: readonly MulticamMemberSpec[];
  syncMaps: ReadonlyMap<string, MulticamSyncMap>;
  masterRef: string;
  name?: string;
  startFrame?: number;
}

/** Throws `MulticamError` before touching the document; on success one undo entry ("Create Multicam"). */
export function createMulticamGroup(editor: Editor, options: CreateMulticamOptions): { groupId: string; clipIds: string[] } {
  const { specs, syncMaps, masterRef } = options;
  const members: MulticamMember[] = [];
  const usedLabels = new Set<string>();
  for (const spec of specs) {
    const asset = editor.mediaAsset(spec.mediaRef);
    const label = uniqueAngleLabel(spec.angleLabel ?? asset?.name ?? spec.mediaRef, usedLabels);
    members.push(makeMulticamMember({ mediaRef: spec.mediaRef, kind: spec.kind, angleLabel: label, sync: syncMaps.get(spec.mediaRef) ?? makeMulticamSyncMap() }));
  }
  const master = members.find((m) => m.mediaRef === masterRef);
  if (!master) throw new MulticamError("Master member not found among members.");

  const group = makeMulticamSource({
    name: options.name ?? uniqueName(editor, (n) => `Multicam ${n}`, 1),
    members,
    masterMemberId: master.id,
  });
  const durations = multicamSourceDurations(editor, group);
  const fps = editor.timeline.fps;
  const at = options.startFrame ?? timelineTotalFrames(editor.timeline);

  const angleRanges = multicamAngles(group).flatMap((angle) => {
    const duration = durations.get(angle.mediaRef);
    return duration === undefined ? [] : [multicamMemberCoverage(angle, duration, fps)];
  });
  const videoStart = angleRanges.length === 0 ? undefined : Math.min(...angleRanges.map((r) => r.lowerBound));
  const videoEnd = angleRanges.length === 0 ? undefined : Math.max(...angleRanges.map((r) => r.upperBound));
  const seed = multicamAngles(group).find((a) => durations.has(a.mediaRef));
  if (videoStart === undefined || videoEnd === undefined || !(videoStart < videoEnd) || !seed) {
    throw new MulticamError("No synced camera has picture — nothing to place.");
  }

  const groupOrigin = at - videoStart;
  const memberClip = (member: MulticamMember, groupRange: FrameSpan, mediaType: ClipType): Clip | null =>
    makeMemberClip(editor, member, groupRange, mediaType, group.id, groupOrigin, fps, durations.get(member.mediaRef));

  const programSpans: { member: MulticamMember; range: FrameSpan }[] = [];
  let holes: FrameSpan[] = [{ lowerBound: videoStart, upperBound: videoEnd }];
  for (const angle of [seed, ...multicamAngles(group).filter((a) => a.id !== seed.id)]) {
    const duration = durations.get(angle.mediaRef);
    if (duration === undefined) continue;
    const coverage = multicamMemberCoverage(angle, duration, fps);
    const remaining: FrameSpan[] = [];
    for (const hole of holes) {
      const filled = spanClamped(hole, coverage);
      if (spanIsEmpty(filled)) {
        remaining.push(hole);
        continue;
      }
      programSpans.push({ member: angle, range: filled });
      if (hole.lowerBound < filled.lowerBound) remaining.push({ lowerBound: hole.lowerBound, upperBound: filled.lowerBound });
      if (filled.upperBound < hole.upperBound) remaining.push({ lowerBound: filled.upperBound, upperBound: hole.upperBound });
    }
    holes = remaining;
    if (holes.length === 0) break;
  }
  programSpans.sort((a, b) => a.range.lowerBound - b.range.lowerBound);

  return editor.perform("Create Multicam", () => {
    const clipIds: string[] = [];
    const videoIdx = insertTrack(editor, 0, "video");
    for (const span of programSpans) {
      const clip = memberClip(span.member, span.range, "video");
      if (!clip) continue;
      editor.timeline.tracks[videoIdx].clips.push(clip);
      clipIds.push(clip.id);
    }

    let audioInsert = editor.timeline.tracks.length;
    for (const mic of multicamMics(group)) {
      const duration = durations.get(mic.mediaRef);
      if (duration === undefined) continue;
      const clip = memberClip(mic, multicamMemberCoverage(mic, duration, fps), "audio");
      if (!clip) continue;
      const idx = insertTrack(editor, audioInsert, "audio");
      editor.timeline.tracks[idx].clips.push(clip);
      clipIds.push(clip.id);
      audioInsert = idx + 1;
    }
    if (clipIds.length === 0) throw new MulticamError("Could not place the multicam on the timeline.");
    editor.doc.multicamGroups.push(group);
    return { groupId: group.id, clipIds };
  });
}

function makeMemberClip(
  editor: Editor,
  member: MulticamMember,
  groupRange: FrameSpan,
  mediaType: ClipType,
  groupId: string,
  groupOrigin: number,
  fps: number,
  sourceDuration: number | undefined,
): Clip | null {
  const start = groupOrigin + groupRange.lowerBound;
  const lower = Math.max(0, start);
  const upper = groupOrigin + groupRange.upperBound;
  if (!(upper > lower)) return null;
  const headCut = lower - start;

  const asset = editor.mediaAsset(member.mediaRef);
  const clip = makeClip({ mediaRef: member.mediaRef, startFrame: lower, durationFrames: upper - lower });
  clip.mediaType = mediaType;
  clip.sourceClipType = asset?.type ?? mediaType;
  clip.multicamGroupId = groupId;
  clip.trimStartFrame = multicamMemberTrimFrame(member, groupRange.lowerBound, fps) + headCut;
  if (sourceDuration !== undefined) {
    const sourceLen = swiftRound(sourceDuration * fps);
    clip.trimEndFrame = Math.max(0, sourceLen - clip.trimStartFrame - clipSourceFramesConsumed(clip));
  }
  if (mediaType === "video" && asset) clip.transform = fitTransformForAsset(editor, asset, editor.timeline.width, editor.timeline.height);
  return clip;
}

function uniqueAngleLabel(raw: string, used: Set<string>): string {
  let collapsed = "";
  for (const ch of raw.toLowerCase()) {
    const c = /[\p{L}\p{N}]/u.test(ch) ? ch : "-";
    if (!(collapsed.endsWith("-") && c === "-")) collapsed += c;
  }
  let base = collapsed.replace(/^-+|-+$/g, "");
  if (base === "") base = "angle";
  let label = base;
  let n = 2;
  while (used.has(label)) {
    label = `${base}-${n}`;
    n += 1;
  }
  used.add(label);
  return label;
}

// MARK: - Group metadata

export function referencedMulticamGroupIds(editor: Editor): Set<string> {
  const ids = new Set<string>();
  for (const t of editor.timelines) for (const track of t.tracks) for (const clip of track.clips) if (clip.multicamGroupId !== undefined) ids.add(clip.multicamGroupId);
  return ids;
}

/** Groups still referenced by a clip; undefined when none (nothing to persist). */
export function savedMulticamGroups(editor: Editor): MulticamSource[] | undefined {
  const referenced = referencedMulticamGroupIds(editor);
  const live = editor.doc.multicamGroups.filter((g) => referenced.has(g.id));
  return live.length === 0 ? undefined : live;
}

// MARK: - Lifecycle

export function ungroupMulticam(editor: Editor, groupId: string): void {
  if (!multicamGroupById(editor, groupId)) return;
  editor.perform("Ungroup Multicam", () => {
    for (const track of editor.timeline.tracks) {
      for (const clip of track.clips) if (clip.multicamGroupId === groupId) delete clip.multicamGroupId;
    }
    const stillReferenced = editor.timelines.some((t) => t.tracks.some((track) => track.clips.some((c) => c.multicamGroupId === groupId)));
    if (!stillReferenced) editor.doc.multicamGroups = editor.doc.multicamGroups.filter((g) => g.id !== groupId);
  });
}

// MARK: - Angle switching

/** Validates every request, then applies them as one "Switch Angle" undo entry. */
export function switchMulticamAngles(editor: Editor, groupId: string, requests: readonly AngleSwitchRequest[]): MulticamOutcome {
  const group = multicamGroupById(editor, groupId);
  if (!group) throw new MulticamError(`Not a multicam group: ${groupId}`);
  if (multicamClips(editor, groupId).length === 0) throw new MulticamError("The group has no clips on the active timeline.");
  const entries: MulticamEntry[] = requests.map((request) => {
    const slots = videoLayoutSlots(request.layout);
    if (request.angles.length === 0 || request.angles.length > slots.length) {
      throw new MulticamError(
        `Layout ${request.layout} takes at most ${slots.length} angle(s): ${slots.map((s) => s.id).join(", ")}.`,
      );
    }
    return { range: request.range, slots: request.angles.map((a) => resolveMember(editor, a, group)), layout: request.layout };
  });
  const durations = multicamSourceDurations(editor, group);
  return editor.perform("Switch Angle", () =>
    applyMulticamEntries(
      entries,
      editor.timeline,
      group,
      durations,
      (clip) => fitTransformForClip(editor, clip),
      (clip, rect) => layoutPlacement(editor, clip, rect, "fill"),
    ),
  );
}

/** Lays out the fragment with its current angle in slot 1; other synced angles fill remaining slots. `full` exits. */
export function applyMulticamLayout(editor: Editor, clipId: string, layout: VideoLayout): void {
  const clip = editor.clipFor(clipId);
  const group = clip ? multicamGroupOf(editor, clip) : undefined;
  if (!clip || !group) return;
  const ordered = [...multicamAngles(group)];
  const idx = ordered.findIndex((a) => a.mediaRef === clip.mediaRef);
  if (idx >= 0) [ordered[0], ordered[idx]] = [ordered[idx], ordered[0]];
  const angles = ordered.slice(0, videoLayoutSlots(layout).length).map((a) => a.angleLabel);
  switchOrToast(editor, group.id, { range: { lowerBound: clip.startFrame, upperBound: clipEndFrame(clip) }, angles, layout });
}

function resolveMember(editor: Editor, label: string, group: MulticamSource, audio = false): MulticamMember {
  const noun = audio ? "mic" : "angle";
  const candidates = audio ? multicamAudioBearers(editor, group) : multicamAngles(group);
  const member = multicamMemberLabeled(group, label);
  const known = member !== undefined && (audio ? candidates.some((c) => c.id === member.id) : multicamMemberProvidesVideo(member));
  if (!member || !known) {
    throw new MulticamError(`Unknown ${noun} '${label}'. ${capitalized(noun)}s: ${candidates.map((c) => c.angleLabel).join(", ")}.`);
  }
  if (!multicamMemberUsable(member)) {
    throw new MulticamError(`${capitalized(noun)} '${label}' isn't synced — pin an offset or recreate the group.`);
  }
  return member;
}

const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// MARK: - Program read

export type ProgramRow = [angle: string, startFrame: number, endFrame: number];

function programTrackIndex(editor: Editor, groupId: string): number | undefined {
  const indexes = multicamClips(editor, groupId)
    .filter((c) => editor.timeline.tracks[c.trackIndex].type === "video" && c.clip.mediaType !== "audio")
    .map((c) => c.trackIndex);
  return indexes.length === 0 ? undefined : Math.max(...indexes);
}

/** Run-length program cut of the group's top video track, optionally windowed. */
export function multicamProgramRows(editor: Editor, groupId: string, window?: FrameSpan): ProgramRow[] {
  const group = multicamGroupById(editor, groupId);
  if (!group) return [];
  const programTrack = programTrackIndex(editor, groupId);
  if (programTrack === undefined) return [];
  const clips = multicamClips(editor, groupId)
    .filter((c) => c.trackIndex === programTrack && c.clip.mediaType !== "audio")
    .map((c) => c.clip)
    .sort((a, b) => a.startFrame - b.startFrame);

  const rows: ProgramRow[] = [];
  for (const clip of clips) {
    let r: FrameSpan = { lowerBound: clip.startFrame, upperBound: clipEndFrame(clip) };
    if (window) r = spanClamped(r, window);
    if (spanIsEmpty(r)) continue;
    const label = multicamMemberWithMediaRef(group, clip.mediaRef)?.angleLabel ?? "";
    const last = rows.at(-1);
    if (last && last[0] === label && last[2] === r.lowerBound) last[2] = r.upperBound;
    else rows.push([label, r.lowerBound, r.upperBound]);
  }
  return rows;
}

// MARK: - Manual switching

/** Context-menu switch: program fragments cut in place, mic clips and upper-track fragments rewrite to the member. */
export function switchMulticamSegment(editor: Editor, clipId: string, angle: string): void {
  const loc = editor.findClip(clipId);
  if (!loc) return;
  const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
  const group = multicamGroupOf(editor, clip);
  if (!group) return;
  const programTrack = programTrackIndex(editor, group.id);
  if (clip.mediaType === "audio" || loc.trackIndex !== programTrack) {
    try {
      const member = resolveMember(editor, angle, group, clip.mediaType === "audio");
      const durations = multicamSourceDurations(editor, group);
      const fps = editor.timeline.fps;
      editor.perform(clip.mediaType === "audio" ? "Switch Mic" : "Switch Angle", () => {
        rewrite(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex], group, member, durations, fps);
      });
    } catch (e) {
      if (e instanceof MulticamError) editor.refuseWithToast(e.message);
      else throw e;
    }
    return;
  }
  switchOrToast(editor, group.id, angleSwitchRequest({ lowerBound: clip.startFrame, upperBound: clipEndFrame(clip) }, angle));
}

function switchOrToast(editor: Editor, groupId: string, request: AngleSwitchRequest): void {
  try {
    switchMulticamAngles(editor, groupId, [request]);
  } catch (e) {
    if (e instanceof MulticamError) editor.refuseWithToast(e.message);
    else editor.refuseWithToast("Couldn't switch angle.");
  }
}

export function switchMulticamRange(editor: Editor, groupId: string, range: FrameSpan, angle: string): void {
  switchOrToast(editor, groupId, angleSwitchRequest(range, angle));
}
