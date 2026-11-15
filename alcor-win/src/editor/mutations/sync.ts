import { clipTypeIsVisual, type Clip } from "../../model";
import { minOverlap } from "../../audio/audioSyncCorrelator";
import type { SourceTimecode, SyncServices } from "../../audio/sourceTiming";
import { throwIfAborted } from "../../media/concurrency";
import { envelopeHopSeconds } from "../../media/peaks";
import { swiftRound } from "../../util/math";
import type { Editor } from "../editor";
import { captionCanTranscribe } from "./captions";
import { commitClipSpeed, moveClips, retimedDurationFrames } from "./clipMutations";
import { linkedPartnerIds } from "./linking";
import type { ClipMove } from "./multicamRules";

// Port of Editor/ViewModel/EditorViewModel+Sync.swift: aligns clips to a reference by source timecode or by audio
// cross-correlation, correcting recorder clock drift and moving link partners along.

export type SyncMode = "auto" | "audio" | "timecode";
export type SyncMethod = "timecode" | "audio";

export interface SyncBatchReport {
  synced: { clipId: string; offsetFrames: number; confidence: number; method: SyncMethod }[];
  failures: { clipId: string; message: string }[];
  /** Frames the whole group (reference included) moved right so no target lands before frame 0. */
  shiftedFrames: number;
  retimed: { clipId: string; driftPpm: number }[];
  retimeSkipped: { clipId: string; message: string }[];
}

export const syncDefaults = {
  minConfidence: 0.5,
  minSpeed: 0.0001,
  /** ± window around a capture-date seed; covers typical device clock skew. */
  dateSeedWindowSeconds: 3,
  /** Thinner overlaps produce spurious edge matches that can beat the true alignment. */
  minOverlapSeconds: 3,
  memberSearchWindowSeconds: 240,
} as const;

/** Timeline start frame that aligns the target's first frame to the reference by wall-clock timecode. */
export function timecodeAlignedStart(p: {
  refStartFrame: number;
  refTrimStartFrame: number;
  refSpeed: number;
  refTimecode: SourceTimecode;
  targetTrimStartFrame: number;
  targetTimecode: SourceTimecode;
  fps: number;
}): number {
  const refClock = p.refTimecode.seconds + p.refTrimStartFrame / p.fps;
  const targetClock = p.targetTimecode.seconds + p.targetTrimStartFrame / p.fps;
  const lagFrames = ((targetClock - refClock) * p.fps) / Math.max(p.refSpeed, syncDefaults.minSpeed);
  return swiftRound(p.refStartFrame + lagFrames);
}

export interface SyncClipsOptions {
  referenceClipId: string;
  targetClipIds: readonly string[];
  mode?: SyncMode;
  searchWindowSeconds?: number;
  minConfidence?: number;
  /** Wraps the final mutation (Swift `applying`); defaults to one "Synchronize" undo entry. */
  apply?: (mutation: () => void) => void | Promise<void>;
  signal?: AbortSignal;
}

interface AudioClip {
  clipId: string;
  samples: Float32Array;
  speed: number;
  mediaRef: string;
  trimStartFrame: number;
}

interface Hit {
  rawStart: number;
  confidence: number;
  driftRatio: number;
  retimedSpeed?: number;
}

interface Anchor {
  rawStart: number;
  clip: AudioClip;
}

interface Placement {
  clipId: string;
  rawStart: number;
  confidence: number;
  method: SyncMethod;
  driftRatio: number;
  retimedSpeed?: number;
}

interface Accepted {
  clipId: string;
  rawStart: number;
  confidence: number;
  method: SyncMethod;
  currentStart: number;
}

interface Retime {
  ids: string[];
  speed: number;
  driftPpm: number;
  bearerId: string;
}

export async function syncClips(editor: Editor, services: SyncServices, options: SyncClipsOptions): Promise<SyncBatchReport> {
  const { referenceClipId, signal } = options;
  const mode = options.mode ?? "auto";
  const minConfidence = options.minConfidence ?? syncDefaults.minConfidence;
  const fps = editor.timeline.fps;
  const targets = options.targetClipIds.filter((id) => id !== referenceClipId);
  const report: SyncBatchReport = { synced: [], failures: [], shiftedFrames: 0, retimed: [], retimeSkipped: [] };

  const liveClip = (id: string): Clip | undefined => editor.clipFor(id) ?? undefined;
  const refClip = fps > 0 ? liveClip(referenceClipId) : undefined;
  if (!refClip) {
    report.failures = targets.map((clipId) => ({ clipId, message: "Reference clip unavailable." }));
    return report;
  }
  const refUnitKey = refClip.linkGroupId ?? refClip.id;

  const unitOf = (clip: Clip): Clip[] => {
    if (clip.linkGroupId === undefined) return [clip];
    return editor.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.linkGroupId === clip.linkGroupId);
  };

  const refs = new Set(unitOf(refClip).map((c) => c.mediaRef));
  for (const id of targets) {
    const clip = liveClip(id);
    if (clip) for (const c of unitOf(clip)) refs.add(c.mediaRef);
  }
  const timingCache = new Map(await Promise.all([...refs].map(async (ref) => [ref, await services.timing(ref)] as const)));

  const tcCarrier = (clips: readonly Clip[]): { clip: Clip; tc: SourceTimecode } | undefined => {
    const hits = clips.flatMap((c) => {
      const tc = timingCache.get(c.mediaRef)?.timecode;
      return tc ? [{ clip: c, tc }] : [];
    });
    return hits.find((h) => clipTypeIsVisual(h.clip.mediaType)) ?? hits[0];
  };
  const refTCCarrier = mode === "audio" ? undefined : tcCarrier(unitOf(refClip));

  const hop = envelopeHopSeconds;
  const seedWindow = Math.max(1, swiftRound(syncDefaults.dateSeedWindowSeconds / hop));
  const minOverlapHops = Math.max(minOverlap, swiftRound(syncDefaults.minOverlapSeconds / hop));

  const anchors: Anchor[] = [];
  const candidates: { clip: AudioClip; direct: Hit | null; tcRawStart?: number }[] = [];
  const placements: Placement[] = [];
  let refAudioTried = false;

  const envelopeOf = async (clip: Clip): Promise<Float32Array | undefined> => {
    const start = clip.trimStartFrame / fps;
    const end = start + (clip.durationFrames * Math.max(clip.speed, syncDefaults.minSpeed)) / fps;
    const env = await services.envelope(clip.mediaRef, { start, end: Math.max(start + hop, end) }, signal);
    return env && env.samples.length > 0 ? env.samples : undefined;
  };

  const match = async (anchor: Anchor, target: AudioClip): Promise<Hit | null> => {
    let seedHops: number | undefined;
    const anchorDate = timingCache.get(anchor.clip.mediaRef)?.captureDate;
    const targetDate = timingCache.get(target.mediaRef)?.captureDate;
    if (anchorDate !== undefined && targetDate !== undefined) {
      const lagSeconds = targetDate - anchorDate + (target.trimStartFrame - anchor.clip.trimStartFrame) / fps;
      seedHops = swiftRound(lagSeconds / hop);
    }
    const maxLag =
      options.searchWindowSeconds !== undefined
        ? Math.max(1, swiftRound(options.searchWindowSeconds / hop))
        : Math.max(anchor.clip.samples.length, target.samples.length);
    const result = await services.correlate(
      {
        reference: anchor.clip.samples,
        target: target.samples,
        seedHops,
        seedWindowHops: seedWindow,
        maxLagHops: maxLag,
        minOverlapHops,
        minConfidence,
      },
      signal,
    );
    if (!result) return null;
    const lagFrames = (result.exactLagHops * hop * fps) / Math.max(anchor.clip.speed, syncDefaults.minSpeed);
    let retimedSpeed: number | undefined;
    if (result.driftRatio !== 0) {
      const corrected = anchor.clip.speed / (1 + result.driftRatio);
      if (Math.abs(corrected / Math.max(target.speed, syncDefaults.minSpeed) - 1) <= 0.001) retimedSpeed = corrected;
    }
    return { rawStart: swiftRound(anchor.rawStart + lagFrames), confidence: result.confidence, driftRatio: result.driftRatio, retimedSpeed };
  };

  const timecodePlacement = (clipId: string, rawStart: number): Placement => ({
    clipId, rawStart, confidence: 1, method: "timecode", driftRatio: 0,
  });

  const seenUnits = new Set<string>();
  for (const targetId of targets) {
    throwIfAborted(signal);
    const targetClip = liveClip(targetId);
    if (!targetClip) {
      report.failures.push({ clipId: targetId, message: "Clip not found." });
      continue;
    }
    const unitKey = targetClip.linkGroupId ?? targetClip.id;
    if (unitKey === refUnitKey) {
      report.failures.push({ clipId: targetId, message: "Clip is linked to the reference — they already move together." });
      continue;
    }
    if (seenUnits.has(unitKey)) continue;
    seenUnits.add(unitKey);
    const unitClips = unitOf(targetClip);

    let tcHint: { clipId: string; rawStart: number } | undefined;
    const targetCarrier = refTCCarrier ? tcCarrier(unitClips) : undefined;
    if (refTCCarrier && targetCarrier) {
      const liveRef = liveClip(refTCCarrier.clip.id);
      const liveCarrier = liveClip(targetCarrier.clip.id);
      if (!liveRef || !liveCarrier) {
        report.failures.push({ clipId: targetId, message: "Clip not found." });
        continue;
      }
      const rawStart = timecodeAlignedStart({
        refStartFrame: liveRef.startFrame,
        refTrimStartFrame: liveRef.trimStartFrame,
        refSpeed: liveRef.speed,
        refTimecode: refTCCarrier.tc,
        targetTrimStartFrame: liveCarrier.trimStartFrame,
        targetTimecode: targetCarrier.tc,
        fps,
      });
      if (mode === "timecode") {
        placements.push(timecodePlacement(targetCarrier.clip.id, rawStart));
        continue;
      }
      tcHint = { clipId: targetCarrier.clip.id, rawStart };
    }
    if (mode === "timecode") {
      report.failures.push({ clipId: targetId, message: refTCCarrier === undefined ? "Reference has no source timecode." : "Clip has no source timecode." });
      continue;
    }

    const bearer =
      unitClips.find((c) => c.mediaType === "audio" && captionCanTranscribe(editor, c)) ?? unitClips.find((c) => captionCanTranscribe(editor, c));
    if (!bearer) {
      if (tcHint) {
        placements.push(timecodePlacement(tcHint.clipId, tcHint.rawStart));
        continue;
      }
      report.failures.push({ clipId: targetId, message: mode === "auto" ? "No source timecode, and clip has no audio." : "Clip has no audio." });
      continue;
    }
    const bearerSamples = await envelopeOf(bearer);
    if (!bearerSamples) {
      if (tcHint) {
        placements.push(timecodePlacement(tcHint.clipId, tcHint.rawStart));
        continue;
      }
      report.failures.push({ clipId: bearer.id, message: "Clip has no audio." });
      continue;
    }
    if (!refAudioTried) {
      refAudioTried = true;
      const liveRef = liveClip(referenceClipId);
      const refSamples = liveRef ? await envelopeOf(liveRef) : undefined;
      if (liveRef && refSamples) {
        anchors.push({
          rawStart: liveRef.startFrame,
          clip: { clipId: liveRef.id, samples: refSamples, speed: liveRef.speed, mediaRef: liveRef.mediaRef, trimStartFrame: liveRef.trimStartFrame },
        });
      }
    }
    const refAnchor = anchors[0];
    if (!refAnchor) {
      if (tcHint) {
        placements.push(timecodePlacement(tcHint.clipId, tcHint.rawStart));
        continue;
      }
      report.failures.push({
        clipId: bearer.id,
        message: mode === "auto" && refTCCarrier === undefined ? "Reference has no source timecode or audio." : "Reference clip has no audio.",
      });
      continue;
    }
    const liveBearer = liveClip(bearer.id);
    if (!liveBearer) {
      if (tcHint) {
        placements.push(timecodePlacement(tcHint.clipId, tcHint.rawStart));
        continue;
      }
      report.failures.push({ clipId: bearer.id, message: "Clip not found." });
      continue;
    }
    const clip: AudioClip = { clipId: bearer.id, samples: bearerSamples, speed: liveBearer.speed, mediaRef: liveBearer.mediaRef, trimStartFrame: liveBearer.trimStartFrame };
    candidates.push({ clip, direct: await match(refAnchor, clip), tcRawStart: tcHint?.rawStart });
  }

  // Place the most confident match first; weaker clips may align better to those placed after.
  candidates.sort((a, b) => (b.direct?.confidence ?? 0) - (a.direct?.confidence ?? 0));
  for (const { clip, direct, tcRawStart } of candidates) {
    throwIfAborted(signal);
    let best = direct;
    for (const anchor of anchors.slice(1)) {
      const hit = await match(anchor, clip);
      if (hit && hit.confidence > (best?.confidence ?? 0)) best = hit;
    }
    if (!best) {
      if (tcRawStart !== undefined) {
        placements.push(timecodePlacement(clip.clipId, tcRawStart));
        anchors.push({ rawStart: tcRawStart, clip });
        continue;
      }
      report.failures.push({ clipId: clip.clipId, message: "No confident alignment — clips may not overlap." });
      continue;
    }
    placements.push({ clipId: clip.clipId, rawStart: best.rawStart, confidence: best.confidence, method: "audio", driftRatio: best.driftRatio, retimedSpeed: best.retimedSpeed });
    anchors.push({ rawStart: best.rawStart, clip });
  }
  throwIfAborted(signal);

  // Validate moves before applying group shift; overlap results are preserved.
  const allMoves: ClipMove[] = [];
  const movedIds = new Set<string>();
  const plannedDurations = new Map<string, number>();
  const plannedDuration = (clipId: string): number => plannedDurations.get(clipId) ?? liveClip(clipId)?.durationFrames ?? 0;

  const queueMove = (clipId: string, rawStart: number): string | null => {
    const loc = editor.findClip(clipId);
    if (!loc) return "Clip not found.";
    const delta = rawStart - editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame;
    const moves: ClipMove[] = [{ clipId, toTrack: loc.trackIndex, toFrame: rawStart }];
    // Include all linked partners, regardless of current positions, to avoid splitting pairs when shifting.
    for (const pid of linkedPartnerIds(editor, clipId)) {
      if (pid === referenceClipId) continue;
      const pLoc = editor.findClip(pid);
      if (!pLoc) continue;
      moves.push({ clipId: pid, toTrack: pLoc.trackIndex, toFrame: editor.timeline.tracks[pLoc.trackIndex].clips[pLoc.clipIndex].startFrame + delta });
    }
    if (clipId !== referenceClipId && moveWouldClobberReference(editor, moves, referenceClipId, plannedDuration)) {
      return "Shares the reference's track — move it to its own track first.";
    }
    if (movesOverlapQueued(moves, allMoves, plannedDuration)) return "Overlaps another clip being synced on the same track.";
    for (const move of moves) {
      if (!movedIds.has(move.clipId)) {
        movedIds.add(move.clipId);
        allMoves.push(move);
      }
    }
    return null;
  };

  let accepted: Accepted[] = [];
  let retimes: Retime[] = [];
  let stagedFailures: { clipId: string; message: string }[] = [];
  const skippedRetimeBearers: string[] = [];
  let shift = 0;

  // A skipped retime shrinks footprints and can unblock other moves; requeue until stable.
  for (;;) {
    allMoves.length = 0;
    movedIds.clear();
    plannedDurations.clear();
    accepted = [];
    retimes = [];
    stagedFailures = [];

    for (const p of placements) {
      const clip = liveClip(p.clipId);
      if (!clip) {
        stagedFailures.push({ clipId: p.clipId, message: "Clip not found." });
        continue;
      }
      let retime: { ids: string[]; speed: number } | undefined;
      if (p.retimedSpeed !== undefined && p.retimedSpeed !== clip.speed && !skippedRetimeBearers.includes(p.clipId)) {
        const unitIds = [p.clipId, ...linkedPartnerIds(editor, p.clipId).filter((id) => id !== referenceClipId)];
        retime = { ids: unitIds, speed: p.retimedSpeed };
        for (const id of unitIds) {
          const unitClip = liveClip(id);
          if (unitClip) plannedDurations.set(id, retimedDurationFrames(unitClip.durationFrames, unitClip.speed, p.retimedSpeed));
        }
      }
      const failure = queueMove(p.clipId, p.rawStart);
      if (failure) {
        for (const id of retime?.ids ?? []) plannedDurations.delete(id);
        stagedFailures.push({ clipId: p.clipId, message: failure });
        continue;
      }
      accepted.push({ clipId: p.clipId, rawStart: p.rawStart, confidence: p.confidence, method: p.method, currentStart: clip.startFrame });
      if (retime) retimes.push({ ids: retime.ids, speed: retime.speed, driftPpm: p.driftRatio * 1_000_000, bearerId: p.clipId });
    }

    // Shift right if any accepted move (partners included) starts before frame 0.
    shift = Math.max(0, allMoves.length === 0 ? 0 : -Math.min(...allMoves.map((m) => m.toFrame)));
    if (shift > 0) {
      const liveRef = liveClip(referenceClipId);
      const failure = liveRef ? queueMove(referenceClipId, liveRef.startFrame) : "Reference clip unavailable.";
      if (failure) {
        report.shiftedFrames = shift;
        report.failures.push(...stagedFailures);
        report.failures.push(...accepted.map((a) => ({ clipId: a.clipId, message: failure })));
        return report;
      }
    }

    const blockedBearers = retimes
      .filter((retime) =>
        retime.ids.some((id) => {
          const move = allMoves.find((m) => m.clipId === id);
          const newDuration = plannedDurations.get(id);
          if (!move || newDuration === undefined) return false;
          return retimeGrowthWouldClobberUnmovedClip(editor, id, move.toFrame + shift, newDuration, movedIds);
        }),
      )
      .map((r) => r.bearerId);
    if (blockedBearers.length === 0) break;
    skippedRetimeBearers.push(...blockedBearers);
  }

  report.shiftedFrames = shift;
  report.failures.push(...stagedFailures);
  report.synced = accepted.map((a) => ({ clipId: a.clipId, offsetFrames: a.rawStart + shift - a.currentStart, confidence: a.confidence, method: a.method }));
  const acceptedIds = new Set(accepted.map((a) => a.clipId));
  report.retimeSkipped = skippedRetimeBearers
    .filter((id) => acceptedIds.has(id))
    .map((clipId) => ({ clipId, message: "Drift correction skipped — it would overwrite an adjacent clip." }));
  report.retimed = retimes.map((r) => ({ clipId: r.bearerId, driftPpm: r.driftPpm }));

  const retimedIds = new Set(retimes.flatMap((r) => r.ids));
  const moves: ClipMove[] = allMoves.flatMap((move) => {
    const clip = liveClip(move.clipId);
    if (!clip || !(move.toFrame + shift !== clip.startFrame || retimedIds.has(move.clipId))) return [];
    return [{ clipId: move.clipId, toTrack: move.toTrack, toFrame: move.toFrame + shift }];
  });
  if (moves.length > 0 || retimes.length > 0) {
    throwIfAborted(signal);
    const mutation = (): void => {
      for (const retime of retimes) commitClipSpeed(editor, retime.ids, retime.speed, false);
      if (moves.length > 0) moveClips(editor, moves);
    };
    if (options.apply) await options.apply(mutation);
    else editor.perform("Synchronize", mutation);
  }
  return report;
}

/** Selection → reference + targets for the Synchronize menu; undefined when fewer than two units are selected. */
export function syncSelection(editor: Editor): { referenceClipId: string; targetClipIds: string[] } | undefined {
  const selected = editor.timeline.tracks
    .flatMap((t) => t.clips)
    .filter((c) => editor.ui.selectedClipIds.has(c.id) && c.multicamGroupId === undefined);
  const units = new Map<string, Clip[]>();
  for (const clip of selected) {
    const key = clip.linkGroupId ?? clip.id;
    units.set(key, [...(units.get(key) ?? []), clip]);
  }

  // Prefer the audio bearer; a video clip with no audio can still sync by timecode.
  const bearers: { unit: Clip[]; clip: Clip }[] = [];
  for (const unit of units.values()) {
    const clip =
      unit.find((c) => c.mediaType === "audio" && captionCanTranscribe(editor, c)) ??
      unit.find((c) => captionCanTranscribe(editor, c)) ??
      unit.find((c) => c.mediaType === "video");
    if (clip) bearers.push({ unit, clip });
  }
  if (bearers.length < 2) return undefined;

  const rank = (b: { unit: Clip[] }): [number, number, number] => [
    b.unit.some((c) => c.linkGroupId !== undefined) ? 0 : 1,
    b.unit.some((c) => clipTypeIsVisual(c.mediaType)) ? 0 : 1,
    Math.min(...b.unit.map((c) => c.startFrame)),
  ];
  const ordered = [...bearers].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
  const targets = ordered
    .slice(1)
    .sort((a, b) => a.clip.startFrame - b.clip.startFrame)
    .map((b) => b.clip.id);
  return { referenceClipId: ordered[0].clip.id, targetClipIds: targets };
}

export function retimeGrowthWouldClobberUnmovedClip(
  editor: Editor,
  clipId: string,
  finalStart: number,
  newDuration: number,
  movedIds: ReadonlySet<string>,
): boolean {
  const loc = editor.findClip(clipId);
  if (!loc) return false;
  const track = editor.timeline.tracks[loc.trackIndex];
  const clip = track.clips[loc.clipIndex];
  const grownStart = finalStart + clip.durationFrames;
  const grownEnd = finalStart + newDuration;
  if (!(grownEnd > grownStart)) return false;
  return track.clips.some(
    (c) => c.id !== clip.id && !movedIds.has(c.id) && c.startFrame < grownEnd && c.startFrame + c.durationFrames > grownStart,
  );
}

function moveWouldClobberReference(
  editor: Editor,
  moves: readonly ClipMove[],
  referenceClipId: string,
  durationOf: (clipId: string) => number,
): boolean {
  const refLoc = editor.findClip(referenceClipId);
  if (!refLoc) return false;
  const ref = editor.timeline.tracks[refLoc.trackIndex].clips[refLoc.clipIndex];
  const refEnd = ref.startFrame + ref.durationFrames;
  return moves.some((m) => m.toTrack === refLoc.trackIndex && m.toFrame < refEnd && ref.startFrame < m.toFrame + durationOf(m.clipId));
}

function movesOverlapQueued(moves: readonly ClipMove[], queued: readonly ClipMove[], durationOf: (clipId: string) => number): boolean {
  for (const move of moves) {
    const end = move.toFrame + durationOf(move.clipId);
    for (const other of queued) {
      if (other.toTrack === move.toTrack && move.toFrame < other.toFrame + durationOf(other.clipId) && other.toFrame < end) return true;
    }
  }
  return false;
}

/** `TimelineView.synchronizeSummary`: the toast text after a Synchronize menu run. */
export function synchronizeSummary(report: SyncBatchReport): string {
  const first = report.failures[0];
  if (report.synced.length === 0 && first) {
    return report.failures.length === 1 ? first.message : `Couldn't align ${report.failures.length} clips.`;
  }
  const byTimecode = report.synced.filter((s) => s.method === "timecode").length;
  const byAudio = report.synced.length - byTimecode;
  const summary = report.synced.length === 1 ? "Synchronized 1 clip" : `Synchronized ${report.synced.length} clips`;
  const details: string[] = [];
  if (byTimecode === 0) details.push("by audio");
  else if (byAudio === 0) details.push("by timecode");
  else details.push(`${byTimecode} by timecode, ${byAudio} by audio`);
  if (report.shiftedFrames > 0) details.push("group moved right to fit");
  if (report.retimed.length > 0) details.push("drift-corrected");
  if (report.retimeSkipped.length > 0) details.push("drift correction skipped — it would overwrite an adjacent clip");
  if (report.failures.length > 0) details.push(`${report.failures.length} couldn't align`);
  return `${summary}: ${details.join(", ")}.`;
}
