import { makeTextAnimation, textAnimationIsActive, textStyleCaption, timelineTotalFrames, type TextAnimation, type TextMeasurer, type TextStyle, type Timeline } from "../model";
import { deepEqual } from "../model/equality";
import type { Editor } from "../editor/editor";
import {
  CaptionError, captionTargets, placeCaptionTrack, type CaptionCase, type TextClipSpec,
} from "../editor/mutations/captions";
import { canvasTextMeasurer } from "../preview/textRenderer";
import { newId } from "../util/id";
import {
  activeTranscriptionBackend, languageIdentifier, transcribeCached, type TranscribeRequest, type TranscriptionBackendId,
} from "../transcription/transcriptionBackend";
import { cachedCloudTranscript, hasCachedCloudTranscript } from "../transcription/transcriptCache";
import { TranscriptionError, type TranscriptionResult } from "../transcription/transcription";
import { buildCaptionSpecs, buildSubtitleCueSpecs } from "./captionSpecBuilder";
import { captionGapSettingsDefault, type CaptionGapSettings } from "./captionGapSettings";
import { sourceUnion } from "./captionTranscriptMapper";
import { captionDefaultCenter } from "./constants";
import { parseSubtitleFile } from "./subtitleFileParser";
import {
  dominantSpeechTrack, makeTimelineTranscriptDocument, type PreparedTarget, type TimelineTranscriptDocument,
} from "./transcriptBrowserModel";

// Port of the transcription-driven half of EditorViewModel+Captions.swift. Transcription runs through the user's
// own provider key (see src/transcription/transcriptionBackend.ts) instead of Palmier cloud / on-device Speech.

export interface CaptionRequest {
  sourceClipIds: string[];
  autoDetect: boolean;
  style: TextStyle;
  center: { x: number; y: number };
  textCase: CaptionCase;
  /** BCP-47 / ISO language code; undefined = auto-detect. */
  locale: string | undefined;
  maxWords: number | undefined;
  maxCharacters: number | undefined;
  gapSettings: CaptionGapSettings;
  /** Animation applied to every generated caption clip (timed from the transcript). */
  animation: TextAnimation;
}

export function makeCaptionRequest(p: Partial<CaptionRequest> = {}): CaptionRequest {
  return {
    sourceClipIds: p.sourceClipIds ?? [],
    autoDetect: p.autoDetect ?? false,
    style: p.style ?? textStyleCaption(),
    center: p.center ?? { ...captionDefaultCenter },
    textCase: p.textCase ?? "auto",
    locale: p.locale,
    maxWords: p.maxWords,
    maxCharacters: p.maxCharacters,
    gapSettings: p.gapSettings ?? captionGapSettingsDefault,
    animation: p.animation ?? makeTextAnimation(),
  };
}

export interface CaptionDeps {
  transcribe(req: TranscribeRequest): Promise<TranscriptionResult>;
  /** Undefined when no transcription key is available. */
  backend(): TranscriptionBackendId | undefined;
  measure: TextMeasurer;
  newGroupId(): string;
}

export const defaultCaptionDeps: CaptionDeps = {
  transcribe: (req) => transcribeCached(req),
  backend: activeTranscriptionBackend,
  measure: canvasTextMeasurer,
  newGroupId: newId,
};

interface PreparedTranscript {
  timelineId: string;
  timeline: Timeline;
  targets: PreparedTarget[];
  results: Map<string, TranscriptionResult>;
}

/** The timeline is "current" while its value (not just its identity) is unchanged. */
export function captionPreparationIsCurrent(editor: Editor, timelineId: string, snapshot: Timeline): boolean {
  return editor.doc.activeTimelineId === timelineId && (editor.timeline === snapshot || deepEqual(editor.timeline, snapshot));
}

export function resolvedCaptionTargets(editor: Editor, request: CaptionRequest): PreparedTarget[] {
  const candidates = request.autoDetect ? captionTargets(editor, []) : captionTargets(editor, request.sourceClipIds);
  const out: PreparedTarget[] = [];
  for (const c of candidates) {
    const loc = editor.findClip(c.id);
    if (!loc) continue;
    const track = editor.timeline.tracks[loc.trackIndex];
    out.push({ id: c.id, trackId: track.id, clip: track.clips[loc.clipIndex] });
  }
  return out;
}

interface TranscribeJob {
  mediaRef: string;
  path: string;
  range: ReturnType<typeof sourceUnion>;
  durationSeconds: number | undefined;
}

function transcribeJobs(editor: Editor, targets: readonly PreparedTarget[]): TranscribeJob[] {
  const clips = targets.map((t) => t.clip);
  const seen = new Set<string>();
  const jobs: TranscribeJob[] = [];
  for (const t of targets) {
    if (seen.has(t.clip.mediaRef)) continue;
    seen.add(t.clip.mediaRef);
    const asset = editor.mediaAsset(t.clip.mediaRef);
    if (!asset || editor.ui.offlineMediaRefs.has(asset.id) || editor.ui.missingMediaRefs.has(asset.id)) continue;
    jobs.push({
      mediaRef: t.clip.mediaRef,
      path: asset.url,
      range: sourceUnion(t.clip.mediaRef, clips, editor.timeline.fps),
      durationSeconds: asset.duration > 0 ? asset.duration : undefined,
    });
  }
  return jobs;
}

async function transcribeTargets(
  editor: Editor,
  targets: readonly PreparedTarget[],
  request: CaptionRequest,
  deps: CaptionDeps,
  signal?: AbortSignal,
): Promise<Map<string, TranscriptionResult>> {
  const backend = deps.backend();
  if (backend === undefined) throw new TranscriptionError("noBackend");
  const language = languageIdentifier(request.locale);
  const jobs = transcribeJobs(editor, targets);
  const outcomes = await Promise.all(
    jobs.map(async (job) => {
      try {
        const result = await deps.transcribe({ path: job.path, range: job.range, durationSeconds: job.durationSeconds, language, backend, signal });
        return { mediaRef: job.mediaRef, result };
      } catch (error) {
        return { mediaRef: job.mediaRef, error };
      }
    }),
  );
  signal?.throwIfAborted();
  const results = new Map<string, TranscriptionResult>();
  let firstError: unknown;
  for (const o of outcomes) {
    if (o.result !== undefined) results.set(o.mediaRef, o.result);
    else firstError ??= o.error;
  }
  if (results.size === 0 && firstError !== undefined) throw firstError;
  return results;
}

async function prepareTranscript(editor: Editor, request: CaptionRequest, deps: CaptionDeps, signal?: AbortSignal): Promise<PreparedTranscript> {
  const timelineId = editor.doc.activeTimelineId;
  const timelineSnapshot = editor.timeline;
  let targets = resolvedCaptionTargets(editor, request);
  if (targets.length === 0) throw new CaptionError("noSource");
  const results = await transcribeTargets(editor, targets, request, deps, signal);
  signal?.throwIfAborted();
  if (!captionPreparationIsCurrent(editor, timelineId, timelineSnapshot)) throw new CaptionError("timelineChanged");
  if (request.autoDetect) {
    const winner = dominantSpeechTrack(timelineSnapshot, targets, results);
    targets = winner === undefined ? [] : targets.filter((t) => t.trackId === winner);
  }
  return { timelineId, timeline: timelineSnapshot, targets, results };
}

/** Transcribes the request's source clips and places the captions on a new top track (one undo step). */
export async function generateCaptions(
  editor: Editor,
  request: CaptionRequest,
  deps: CaptionDeps = defaultCaptionDeps,
  signal?: AbortSignal,
  /** Swift `applying:`: wraps the placement so a caller can add follow-up edits in the same undo step. */
  applying?: (place: () => string[]) => string[],
): Promise<string[]> {
  const prepared = await prepareTranscript(editor, request, deps, signal);
  const tl = prepared.timeline;
  const animation = textAnimationIsActive(request.animation) ? request.animation : undefined;
  const specs = buildCaptionSpecs(
    {
      targets: prepared.targets.flatMap((t) => {
        const result = prepared.results.get(t.clip.mediaRef);
        return result ? [{ clip: t.clip, result }] : [];
      }),
      fps: tl.fps,
      timelineEndFrame: timelineTotalFrames(tl),
      canvasWidth: tl.width,
      canvasHeight: tl.height,
      style: request.style,
      center: request.center,
      textCase: request.textCase,
      maxWords: request.maxWords,
      maxCharacters: request.maxCharacters,
      gapSettings: request.gapSettings,
      animation,
      measure: deps.measure,
      ...(signal ? { signal } : {}),
    },
    deps.newGroupId,
  );
  signal?.throwIfAborted();
  if (!captionPreparationIsCurrent(editor, prepared.timelineId, tl)) throw new CaptionError("timelineChanged");
  if (specs.length === 0) return [];
  const place = (): string[] => placeCaptionTrack(editor, specs, "Generate Captions", { measure: deps.measure });
  return applying ? applying(place) : place();
}

/** Transcribes the request's source clips into transcript rows without touching the timeline. */
export async function timelineTranscript(
  editor: Editor,
  request: CaptionRequest,
  deps: CaptionDeps = defaultCaptionDeps,
  signal?: AbortSignal,
): Promise<TimelineTranscriptDocument> {
  const prepared = await prepareTranscript(editor, request, deps, signal);
  const document = makeTimelineTranscriptDocument(prepared.timeline, prepared.targets, prepared.results);
  if (!captionPreparationIsCurrent(editor, prepared.timelineId, prepared.timeline)) throw new CaptionError("timelineChanged");
  return document;
}

/** The transcript if every auto-detected source is already cached (no API call), otherwise undefined. */
export async function cachedTimelineTranscript(editor: Editor, signal?: AbortSignal): Promise<TimelineTranscriptDocument | undefined> {
  const timelineId = editor.doc.activeTimelineId;
  const snapshot = editor.timeline;
  const targets = resolvedCaptionTargets(editor, makeCaptionRequest({ autoDetect: true }));
  if (targets.length === 0) return undefined;
  const clips = targets.map((t) => t.clip);
  const seen = new Set<string>();
  const results = new Map<string, TranscriptionResult>();
  for (const target of targets) {
    if (seen.has(target.clip.mediaRef)) continue;
    seen.add(target.clip.mediaRef);
    const asset = editor.mediaAsset(target.clip.mediaRef);
    if (signal?.aborted || !asset) return undefined;
    const range = sourceUnion(target.clip.mediaRef, clips, snapshot.fps);
    const cached = await cachedCloudTranscript(asset.url, { range, language: undefined });
    if (!cached) return undefined;
    results.set(target.clip.mediaRef, cached);
  }
  if (signal?.aborted || !captionPreparationIsCurrent(editor, timelineId, snapshot)) return undefined;
  const winner = dominantSpeechTrack(snapshot, targets, results);
  if (winner === undefined) return undefined;
  return makeTimelineTranscriptDocument(snapshot, targets.filter((t) => t.trackId === winner), results);
}

/** Seconds of source audio that still need an API call for this request (0 when every transcript is cached). */
export async function captionUncachedSeconds(editor: Editor, request: CaptionRequest): Promise<number> {
  const targets = resolvedCaptionTargets(editor, request);
  const language = languageIdentifier(request.locale);
  let total = 0;
  for (const job of transcribeJobs(editor, targets)) {
    if (await hasCachedCloudTranscript(job.path, { range: job.range, language })) continue;
    total += job.range ? Math.max(0, job.range.end - job.range.start) : Math.max(0, job.durationSeconds ?? 0);
  }
  return total;
}

// MARK: - Subtitle files

/** Parses a subtitle file into caption specs sized for the current timeline. */
export async function subtitleCaptionSpecs(editor: Editor, path: string, deps: Pick<CaptionDeps, "measure" | "newGroupId"> = defaultCaptionDeps): Promise<TextClipSpec[]> {
  const tl = editor.timeline;
  const cues = await parseSubtitleFile(path);
  return buildSubtitleCueSpecs(
    cues,
    { fps: tl.fps, canvasWidth: tl.width, canvasHeight: tl.height, style: textStyleCaption(), center: { ...captionDefaultCenter }, measure: deps.measure },
    deps.newGroupId,
  );
}

/** Imports an SRT or WebVTT file as one caption group on a new top track. One undo step. */
export async function importCaptions(editor: Editor, path: string, deps: Pick<CaptionDeps, "measure" | "newGroupId"> = defaultCaptionDeps): Promise<string[]> {
  const owningTimelineId = editor.doc.activeTimelineId;
  const preparationTimeline = editor.timeline;
  const specs = await subtitleCaptionSpecs(editor, path, deps);
  if (!captionPreparationIsCurrent(editor, owningTimelineId, preparationTimeline)) throw new CaptionError("timelineChanged");
  return placeCaptionTrack(editor, specs, "Add Captions", { measure: deps.measure });
}

/** Places each subtitle asset's cues as one caption group on a new top track; failures raise a toast. */
export async function placeCaptionsFromSubtitleAssets(
  editor: Editor,
  assets: readonly { id: string; name: string; type: string; url: string }[],
  deps: Pick<CaptionDeps, "measure" | "newGroupId"> = defaultCaptionDeps,
): Promise<void> {
  for (const asset of assets) {
    if (asset.type !== "subtitle") continue;
    if (editor.ui.offlineMediaRefs.has(asset.id) || editor.ui.missingMediaRefs.has(asset.id)) {
      editor.showToast(`Can't add captions — "${asset.name}" is offline.`, "error");
      continue;
    }
    try {
      await importCaptions(editor, asset.url, deps);
    } catch (error) {
      editor.showToast(`Can't add captions from "${asset.name}" — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}
