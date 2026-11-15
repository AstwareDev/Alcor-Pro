import { clipEndFrame, type Clip } from "../../model";
import { deepEqual } from "../../model/equality";
import type { Editor } from "../../editor/editor";
import { captionTargets, captionTargetsForTracks, transcriptionTargets } from "../../editor/mutations/captions";
import { linkedPartnerIds } from "../../editor/mutations/linking";
import { makeCaptionRequest, defaultCaptionDeps, type CaptionDeps, type CaptionRequest } from "../../captions/captionGeneration";
import { sourceSpan, sourceUnion } from "../../captions/captionTranscriptMapper";
import { languageIdentifier } from "../../transcription/transcriptionBackend";
import { TranscriptionError, type TranscriptionResult } from "../../transcription/transcription";
import { swiftRound } from "../../util/math";
import { jsonString } from "./jsonFormat";
import { ToolError, argString, exactJSONInt, validateUnknownKeys } from "./toolArgs";
import { frameWindow } from "./toolExecutorAgentActivity";
import type { ToolExecutor } from "./toolExecutor";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Transcription.swift: get_transcript and the shared transcript session. Transcription runs
// through the user's own provider key (src/transcription); there is no Palmier cloud/local split, so the context's
// `provider` is the backend id and `language` is passed to it.

export const transcriptWordLimit = 10000;

const getTranscriptAllowedKeys = ["startFrame", "endFrame", "clipId", "trackIndex", "wordTimestamps", "language", "granularity"];

export interface TranscriptionToolContext {
  /** The transcription backend id ("elevenlabs" | "openai"), or "none" when no key is configured. */
  provider: string;
  /** BCP-47 speech language requested by the agent. */
  language: string | undefined;
}

export type TranscriptionScope = { kind: "automatic" } | { kind: "clips"; ids: string[] } | { kind: "track"; id: string };

export function scopeTargets(editor: Editor, scope: TranscriptionScope): Clip[] {
  switch (scope.kind) {
    case "automatic": return captionTargets(editor, []);
    case "clips": return transcriptionTargets(editor, scope.ids);
    case "track": return captionTargetsForTracks(editor, new Set([scope.id]));
  }
}

export function scopeCaptionRequest(editor: Editor, scope: TranscriptionScope): CaptionRequest {
  if (scope.kind === "automatic") return makeCaptionRequest({ autoDetect: true });
  return makeCaptionRequest({ sourceClipIds: scopeTargets(editor, scope).map((c) => c.id) });
}

interface TranscriptTargetSnapshot {
  clipId: string;
  mediaRef: string;
  startFrame: number;
  durationFrames: number;
  trimStartFrame: number;
  speed: number;
}

function targetSnapshot(clip: Clip): TranscriptTargetSnapshot {
  return {
    clipId: clip.id,
    mediaRef: clip.mediaRef,
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    trimStartFrame: clip.trimStartFrame,
    speed: clip.speed,
  };
}

export interface TranscriptSession {
  context: TranscriptionToolContext;
  scope: TranscriptionScope;
  timelineId: string;
  timelineFPS: number;
  targetSnapshot: TranscriptTargetSnapshot[];
}

export function makeTranscriptSession(editor: Editor, context: TranscriptionToolContext, scope: TranscriptionScope): TranscriptSession {
  return {
    context,
    scope,
    timelineId: editor.doc.activeTimelineId,
    timelineFPS: editor.timeline.fps,
    targetSnapshot: scopeTargets(editor, scope).map(targetSnapshot),
  };
}

export function transcriptSessionHasSameWordMapping(session: TranscriptSession, editor: Editor): boolean {
  return (
    session.timelineId === editor.doc.activeTimelineId &&
    session.timelineFPS === editor.timeline.fps &&
    deepEqual(session.targetSnapshot, scopeTargets(editor, session.scope).map(targetSnapshot))
  );
}

// `ToolExecutor.lastTranscriptSession`, kept per executor.
const sessions = new WeakMap<ToolExecutor, TranscriptSession>();

export function lastTranscriptSession(executor: ToolExecutor): TranscriptSession | undefined {
  return sessions.get(executor);
}

export function setLastTranscriptSession(executor: ToolExecutor, session: TranscriptSession): void {
  sessions.set(executor, session);
}

let transcriptionDeps: CaptionDeps = defaultCaptionDeps;

/** Test seam: swaps the transcription provider used by get_transcript / remove_words / add_captions. */
export function setTranscriptionToolDeps(deps: CaptionDeps | undefined): void {
  transcriptionDeps = deps ?? defaultCaptionDeps;
}

export function transcriptionToolDeps(): CaptionDeps {
  return transcriptionDeps;
}

export interface TimelineWord {
  index: number;
  clipId: string;
  trackIndex: number;
  clipStartFrame: number;
  clipEndFrame: number;
  text: string;
  startFrame: number;
  endFrame: number;
  speaker: string | undefined;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface TimelineTranscript {
  context: TranscriptionToolContext;
  words: TimelineWord[];
  skipped: SkippedFile[];
}

interface TimelineTranscriptGroup {
  clipId: string;
  trackIndex: number;
  clipStartFrame: number;
  clipEndFrame: number;
  words: TimelineWord[];
}

export function transcriptGroups(transcript: TimelineTranscript, clipId?: string): TimelineTranscriptGroup[] {
  const groups: TimelineTranscriptGroup[] = [];
  const words = transcript.words;
  let i = 0;
  while (i < words.length) {
    const id = words[i].clipId;
    let j = i + 1;
    while (j < words.length && words[j].clipId === id) j += 1;
    if (clipId === undefined || clipId === id) {
      groups.push({
        clipId: id,
        trackIndex: words[i].trackIndex,
        clipStartFrame: words[i].clipStartFrame,
        clipEndFrame: words[i].clipEndFrame,
        words: words.slice(i, j),
      });
    }
    i = j;
  }
  return groups;
}

/** Sentence-ish rows for comprehension reads; firstWordIndex is the handle back into word mode. */
function segmentRows(words: readonly TimelineWord[], fps: number): (string | number)[][] {
  const rows: (string | number)[][] = [];
  let run: TimelineWord[] = [];
  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) return;
    rows.push([first.index, run.map((w) => w.text).join(" "), first.startFrame, last.endFrame]);
    run = [];
  };
  for (const word of words) {
    const last = run[run.length - 1];
    if (last && (last.speaker !== word.speaker || word.startFrame - last.endFrame > fps || run.length >= 48)) flush();
    run.push(word);
    if (word.text.endsWith(".") || word.text.endsWith("!") || word.text.endsWith("?")) flush();
  }
  flush();
  return rows;
}

export function transcriptResponsePayload(
  transcript: TimelineTranscript,
  p: { fps: number; clipId?: string | undefined; startFrame?: number | undefined; endFrame?: number | undefined; maxWords: number; segments?: boolean },
): Record<string, unknown> {
  const segments = p.segments === true;
  const includesSpeakers = transcript.words.some((w) => w.speaker !== undefined);
  const clipsOut: Record<string, unknown>[] = [];
  let totalWords = 0;
  let remaining = p.maxWords;
  let lastEnd: number | undefined;
  const speakerRuns: (string | number | null)[][] = [];
  let speakerStarted = false;
  let currentSpeaker: string | undefined;

  for (const group of transcriptGroups(transcript, p.clipId)) {
    const visible: TimelineWord[] = [];
    for (const word of group.words) {
      if (p.startFrame !== undefined && word.endFrame <= p.startFrame) continue;
      if (p.endFrame !== undefined && word.startFrame >= p.endFrame) continue;
      totalWords += 1;
      if (!(remaining > 0)) continue;
      visible.push(word);
      remaining -= 1;
      lastEnd = word.endFrame;
      // Speakers as run-length turns, not a column repeated on every word.
      if (includesSpeakers && (!speakerStarted || currentSpeaker !== word.speaker)) {
        speakerStarted = true;
        currentSpeaker = word.speaker;
        speakerRuns.push([word.index, word.speaker ?? null]);
      }
    }
    if (visible.length === 0) continue;
    const clipOut: Record<string, unknown> = {
      clipId: group.clipId,
      trackIndex: group.trackIndex,
      startFrame: group.clipStartFrame,
      endFrame: group.clipEndFrame,
    };
    if (segments) clipOut.segments = segmentRows(visible, p.fps);
    else clipOut.words = visible.map((w) => [w.index, w.text, w.startFrame]);
    clipsOut.push(clipOut);
  }

  const out: Record<string, unknown> = {
    fps: p.fps,
    timing: "projectFrames",
    transcriptionSource: transcript.context.provider,
    clips: clipsOut,
  };
  if (segments) out.segmentFormat = ["firstWordIndex", "text", "start", "end"];
  else out.wordFormat = ["index", "text", "start"];
  if (includesSpeakers && speakerRuns.length > 0) {
    out.speakers = speakerRuns;
    out.speakersNote = "[firstWordIndex, speaker] — each run holds until the next entry.";
  }
  if (totalWords > p.maxWords) {
    out.totalWords = totalWords;
    if (lastEnd !== undefined) {
      out.nextStartFrame = lastEnd;
      out.wordsNote = `First ${p.maxWords} of ${totalWords} words. Continue with startFrame = nextStartFrame.`;
    }
  }
  if (transcript.skipped.length > 0) out.skipped = transcript.skipped;
  return out;
}

// MARK: - Scope

function linkedAudioScope(editor: Editor, clipIds: readonly string[]): TranscriptionScope | undefined {
  const partnerIds = clipIds.flatMap((id) => linkedPartnerIds(editor, id));
  if (partnerIds.length === 0) return undefined;
  const scope: TranscriptionScope = { kind: "clips", ids: partnerIds };
  return scopeTargets(editor, scope).length === 0 ? undefined : scope;
}

export function resolveTranscriptionScope(editor: Editor, args: ToolArgs, path: string): TranscriptionScope {
  const clipId = argString(args, "clipId");
  const rawTrackIndex = args.trackIndex;
  if (rawTrackIndex === undefined) {
    if (clipId === undefined) return { kind: "automatic" };
    if (!editor.findClip(clipId)) throw new ToolError(`Clip ${clipId} not found.`);
    const scope: TranscriptionScope = { kind: "clips", ids: [clipId] };
    if (scopeTargets(editor, scope).length > 0) return scope;
    const linked = linkedAudioScope(editor, [clipId]);
    if (linked) return linked;
    throw new ToolError(`Clip ${clipId} has no transcribable audio.`);
  }
  if (clipId !== undefined) throw new ToolError(`${path}: pass either clipId or trackIndex, not both.`);
  const trackIndex = exactJSONInt(rawTrackIndex);
  if (trackIndex === undefined) throw new ToolError(`${path}: trackIndex must be an integer.`);
  const tracks = editor.timeline.tracks;
  if (!(trackIndex >= 0 && trackIndex < tracks.length)) {
    const validRange = tracks.length === 0 ? "the timeline has no tracks" : `valid range: 0..${tracks.length - 1}`;
    throw new ToolError(`${path}: trackIndex ${trackIndex} is out of range (${validRange}).`);
  }
  const track = tracks[trackIndex];
  const scope: TranscriptionScope = { kind: "track", id: track.id };
  if (scopeTargets(editor, scope).length > 0) return scope;
  const linked = linkedAudioScope(editor, track.clips.map((c) => c.id));
  if (linked) return linked;
  throw new ToolError(`${path}: track ${trackIndex} has no transcribable audio.`);
}

export function transcriptionContext(args: ToolArgs): TranscriptionToolContext {
  return { provider: transcriptionDeps.backend() ?? "none", language: argString(args, "language") };
}

// MARK: - Words

interface TranscriptFragment {
  clipId: string;
  trackIndex: number;
  clip: Clip;
  path: string;
  mediaRef: string;
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

function spanFrames(start: number, end: number, clip: Clip, fps: number): { start: number; end: number } | undefined {
  const visible = sourceSpan(clip);
  const startFrame = Math.max(start * fps, visible.start);
  const endFrame = Math.min(end * fps, visible.end);
  if (!(endFrame > startFrame)) return undefined;
  const toTimeline = (sourceFrame: number): number =>
    swiftRound(clip.startFrame + (sourceFrame - visible.start) / Math.max(clip.speed, 0.0001));
  const mappedStart = toTimeline(startFrame);
  return { start: mappedStart, end: Math.max(mappedStart, toTimeline(endFrame)) };
}

function timelineRows(transcript: TranscriptionResult, clip: Clip, fps: number): { start: number; end: number; text: string; speaker: string | undefined }[] {
  const visible = sourceSpan(clip);
  const rows: { start: number; end: number; text: string; speaker: string | undefined }[] = [];
  for (const word of transcript.words) {
    if (word.start === undefined || word.end === undefined) continue;
    const midFrame = ((word.start + word.end) / 2) * fps;
    if (!(midFrame >= visible.start && midFrame < visible.end)) continue;
    const frames = spanFrames(word.start, word.end, clip, fps);
    if (frames) rows.push({ start: frames.start, end: frames.end, text: word.text, speaker: word.speaker });
  }
  return rows.sort((a, b) => a.start - b.start || a.end - b.end);
}

async function timelineWords(editor: Editor, session: TranscriptSession): Promise<{ words: TimelineWord[]; skipped: SkippedFile[] }> {
  const fps = editor.timeline.fps;
  const fragments: TranscriptFragment[] = [];
  const skipped: SkippedFile[] = [];
  for (const clip of scopeTargets(editor, session.scope)) {
    const loc = editor.findClip(clip.id);
    const asset = editor.mediaAsset(clip.mediaRef);
    if (!loc || !asset) continue;
    if (editor.ui.offlineMediaRefs.has(asset.id) || editor.ui.missingMediaRefs.has(asset.id)) {
      if (!skipped.some((s) => s.file === baseName(asset.url))) skipped.push({ file: baseName(asset.url), reason: "The media file is offline." });
      continue;
    }
    fragments.push({ clipId: clip.id, trackIndex: loc.trackIndex, clip, path: asset.url, mediaRef: clip.mediaRef });
  }

  const results = new Map<string, TranscriptionResult>();
  if (fragments.length > 0) {
    const deps = transcriptionDeps;
    const backend = deps.backend();
    if (backend === undefined) throw new TranscriptionError("noBackend");
    const language = languageIdentifier(session.context.language);
    const clips = fragments.map((f) => f.clip);
    const refs = [...new Set(fragments.map((f) => f.mediaRef))];
    type Outcome = { mediaRef: string; path: string; result?: TranscriptionResult; error?: string };
    const outcomes = await Promise.all(
      refs.map(async (mediaRef): Promise<Outcome> => {
        const path = fragments.find((f) => f.mediaRef === mediaRef)?.path ?? "";
        const duration = editor.mediaAsset(mediaRef)?.duration;
        try {
          const result = await deps.transcribe({
            path,
            range: sourceUnion(mediaRef, clips, fps),
            durationSeconds: duration !== undefined && duration > 0 ? duration : undefined,
            language,
            backend,
          });
          return { mediaRef, path, result };
        } catch (e) {
          return { mediaRef, path, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    for (const o of outcomes) {
      if (o.result !== undefined) results.set(o.mediaRef, o.result);
      else skipped.push({ file: baseName(o.path), reason: o.error ?? "Transcription failed." });
    }
  }

  const words: TimelineWord[] = [];
  const ordered = fragments.map((f, i) => ({ f, i })).sort((a, b) => a.f.clip.startFrame - b.f.clip.startFrame || a.i - b.i);
  for (const { f } of ordered) {
    const transcript = results.get(f.mediaRef);
    if (!transcript) continue;
    for (const row of timelineRows(transcript, f.clip, fps)) {
      words.push({
        index: words.length,
        clipId: f.clipId,
        trackIndex: f.trackIndex,
        clipStartFrame: f.clip.startFrame,
        clipEndFrame: clipEndFrame(f.clip),
        text: row.text,
        startFrame: row.start,
        endFrame: row.end,
        speaker: row.speaker,
      });
    }
  }
  return { words, skipped };
}

export async function timelineTranscript(editor: Editor, session: TranscriptSession): Promise<TimelineTranscript> {
  const { words, skipped } = await timelineWords(editor, session);
  return { context: session.context, words, skipped };
}

export async function getTranscript({ executor, editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, getTranscriptAllowedKeys, "get_transcript");
  const clipFilter = argString(args, "clipId");
  const window = frameWindow(args);

  const granularity = argString(args, "granularity") ?? "words";
  if (granularity !== "words" && granularity !== "segments") {
    throw new ToolError(`granularity must be 'words' or 'segments' (got '${granularity}')`);
  }

  const scope = resolveTranscriptionScope(editor, args, "get_transcript");
  const session = makeTranscriptSession(editor, transcriptionContext(args), scope);
  const transcript = await timelineTranscript(editor, session);
  setLastTranscriptSession(executor, session);

  return ok(
    jsonString(
      transcriptResponsePayload(transcript, {
        fps: editor.timeline.fps,
        clipId: clipFilter,
        startFrame: window?.start,
        endFrame: window?.end,
        maxWords: transcriptWordLimit,
        segments: granularity === "segments",
      }),
    ),
  );
}
