import { sourceSpan } from "../../captions/captionTranscriptMapper";
import { parseSubtitleFile } from "../../captions/subtitleFileParser";
import { folderIdsIncludingDescendants } from "../../media/folders";
import { mediaIo } from "../../media/io";
import { lastPathComponent } from "../../media/paths";
import { clipEndFrame, generationStatusSerialized, type Clip, type MediaAsset } from "../../model";
import type { TranscriptionResult } from "../../transcription/transcription";
import { swiftRound } from "../../util/math";
import { inspectBackend, inspectGridNote, type SampledFrame } from "./inspectBackend";
import { jsonRounded, jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { folderIdAtPath, allFolderPaths } from "./organizeTools";
import { folderPathString, timelineEntries } from "./timelinePayload";
import { ToolError, argBool, argDouble, argInt, argString, argStringArray, requireString, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolBlock, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Media.swift: get_media (library inventory) and inspect_media (frames, EXIF, transcription).

const getMediaAllowedKeys = ["ids", "folder", "pending"];
const getMediaPromptLimit = 100;
const inspectMediaAllowedKeys = ["mediaRef", "clipId", "maxFrames", "startSeconds", "endSeconds", "wordTimestamps", "overview", "language"];
const defaultReadVideoFrames = 6;
const readVideoMaxFrames = 12;
const subtitleInspectCueLimit = 500;
const inspectMaxSegments = 400;
const transcriptWordLimit = 10000;

type Meta = Record<string, unknown>;

function truncatedPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined || prompt === "") return undefined;
  const chars = Array.from(prompt);
  return chars.length > getMediaPromptLimit ? `${chars.slice(0, getMediaPromptLimit).join("")}…` : prompt;
}

function encodeMeta(meta: Meta, failure = "Failed to encode metadata"): string {
  try {
    return jsonString(roundJSONFloatingPointNumbers(meta, 3));
  } catch {
    throw new ToolError(failure);
  }
}

// MARK: - get_media

export function getMedia({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, getMediaAllowedKeys, "get_media");
  const idFilter = new Set(argStringArray(args, "ids"));
  const pendingOnly = argBool(args, "pending") ?? false;
  let folderScope: Set<string> | undefined;
  const folderPath = argString(args, "folder");
  if (folderPath !== undefined) folderScope = folderIdsIncludingDescendants(editor, new Set([folderIdAtPath(editor, folderPath)]));

  const assets: Meta[] = [];
  for (const entry of editor.doc.mediaManifest.entries) {
    if (idFilter.size > 0 && !idFilter.has(entry.id)) continue;
    const status = entry.generationStatus;
    const pending = status !== undefined && status !== "none";
    if (pendingOnly && !pending) continue;
    if (folderScope && (entry.folderId === undefined || !folderScope.has(entry.folderId))) continue;
    const a: Meta = { id: entry.id, name: entry.name, type: entry.type };
    if (entry.duration > 0) a.durationSeconds = entry.duration;
    if (entry.sourceWidth !== undefined && entry.sourceHeight !== undefined) {
      a.width = entry.sourceWidth;
      a.height = entry.sourceHeight;
    }
    if (entry.sourceFPS !== undefined) a.fps = entry.sourceFPS;
    if (entry.hasAudio === true && entry.type === "video") a.hasAudio = true;
    const path = folderPathString(editor, entry.folderId);
    if (path !== undefined) a.folder = path;
    if (pending) a.generationStatus = status;
    const input = entry.generationInput;
    if (input?.draft === true) {
      a.draft = true;
      if (!pending && input.backendJobId !== undefined && (input.resultURLs?.length ?? 0) >= 2) a.canEnhanceDraft = true;
    }
    const prompt = truncatedPrompt(input?.prompt);
    if (prompt !== undefined) a.prompt = prompt;
    assets.push(a);
  }

  const payload: Meta = { assets };
  // Full inventory only on unfiltered reads; filtered reads (polling) stay minimal.
  if (idFilter.size === 0 && !pendingOnly && folderScope === undefined) {
    const folderPaths = allFolderPaths(editor);
    if (folderPaths.length > 0) payload.folders = folderPaths;
    payload.timelines = timelineEntries(editor, true);
  }
  return ok(encodeMeta(payload, "Failed to encode media library"));
}

// MARK: - inspect_media

interface ClipMapping {
  clip: Clip;
  fps: number;
}

/** Swift `Double` description: whole numbers keep a ".0". */
function swiftDouble(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

function round2OrNull(x: number | undefined): number | null {
  return x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(2));
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

function timelineMappingMeta(clip: Clip, fps: number): Meta {
  return {
    clipId: clip.id,
    clipStartFrame: clip.startFrame,
    clipEndFrame: clipEndFrame(clip),
    fps,
    note: "transcription segments/words are project frames for this clip; out-of-range entries are dropped.",
  };
}

function transcriptionMeta(transcript: TranscriptionResult, mapping: ClipMapping | undefined, includeWords: boolean): Meta {
  const out: Meta = { timing: mapping === undefined ? "sourceSeconds" : "projectFrames" };
  if (transcript.language !== undefined) out.language = transcript.language;

  const rows: { row: unknown[]; sourceEnd: number }[] = [];
  for (const s of transcript.segments) {
    if (mapping) {
      const f = spanFrames(s.start, s.end, mapping.clip, mapping.fps);
      if (f) rows.push({ row: [s.text, f.start, f.end], sourceEnd: s.end });
    } else {
      rows.push({ row: [s.text, round2OrNull(s.start), round2OrNull(s.end)], sourceEnd: s.end });
    }
  }
  const shown = rows.slice(0, inspectMaxSegments);
  out.segments = shown.map((r) => r.row);
  if (rows.length > inspectMaxSegments && shown.length > 0) {
    out.totalSegments = rows.length;
    out.nextStartSeconds = round2OrNull(shown[shown.length - 1].sourceEnd);
    out.segmentsNote = `First ${inspectMaxSegments} of ${rows.length} segments. Continue with startSeconds = nextStartSeconds.`;
  }

  if (includeWords) {
    const words: unknown[][] = [];
    for (const w of transcript.words) {
      if (mapping) {
        if (w.start === undefined || w.end === undefined) continue;
        const f = spanFrames(w.start, w.end, mapping.clip, mapping.fps);
        if (f) words.push([w.text, f.start, f.end]);
      } else {
        words.push([w.text, round2OrNull(w.start), round2OrNull(w.end)]);
      }
    }
    out.words = words.slice(0, transcriptWordLimit);
    if (words.length > transcriptWordLimit) {
      out.totalWords = words.length;
      out.wordsNote = `First ${transcriptWordLimit} of ${words.length} words. Narrow with startSeconds/endSeconds.`;
    }
  }
  return out;
}

/** Same vocabulary as get_media assets, so one asset never describes itself two ways. */
function baseMeta(asset: MediaAsset): Meta {
  const meta: Meta = {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    durationSeconds: jsonRounded(asset.duration, 3),
    fileName: lastPathComponent(asset.url),
  };
  if (asset.generationStatus.kind !== "none") meta.generationStatus = generationStatusSerialized(asset.generationStatus);
  if (asset.sourceWidth !== undefined) meta.width = asset.sourceWidth;
  if (asset.sourceHeight !== undefined) meta.height = asset.sourceHeight;
  if (asset.sourceFPS !== undefined) meta.fps = asset.sourceFPS;
  const prompt = truncatedPrompt(asset.generationInput?.prompt);
  if (prompt !== undefined) meta.prompt = prompt;
  return meta;
}

function sourceRange(args: ToolArgs, duration: number): { start: number; end: number } | undefined {
  const start = argDouble(args, "startSeconds");
  const end = argDouble(args, "endSeconds");
  if (start === undefined && end === undefined) return undefined;
  const s = Math.max(start ?? 0, 0);
  const e = Math.min(end ?? duration, duration);
  if (!(s < e)) throw new ToolError(`Invalid time range [${swiftDouble(s)}, ${swiftDouble(e)}] for media of duration ${swiftDouble(duration)}s`);
  return { start: s, end: e };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function inspectMedia(ctx: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const { editor, executor } = ctx;
  validateUnknownKeys(args, inspectMediaAllowedKeys, "inspect_media");
  const mediaRef = requireString(args, "mediaRef");
  const asset = executor.asset(mediaRef, editor);
  const io = await mediaIo();
  if ((await io.stat(asset.url)) === null) {
    const id = asset.id;
    switch (asset.generationStatus.kind) {
      case "preparing": throw new ToolError(`Asset ${id} is still preparing. Poll get_media and retry once generationStatus becomes 'none'.`);
      case "downloading": throw new ToolError(`Asset ${id} is still downloading. Poll get_media and retry once generationStatus becomes 'none'.`);
      case "generating": throw new ToolError(`Asset ${id} is still generating. Poll get_media and retry once generationStatus becomes 'none'.`);
      case "rendering": throw new ToolError(`Asset ${id} is still rendering. Poll get_media and retry once generationStatus becomes 'none'.`);
      case "failed": throw new ToolError(`Asset ${id} failed: ${asset.generationStatus.message}`);
      case "none": throw new ToolError(`Media file not on disk: ${lastPathComponent(asset.url)}`);
    }
  }

  let mapping: ClipMapping | undefined;
  const clipId = argString(args, "clipId");
  if (clipId !== undefined) {
    const loc = editor.findClip(clipId);
    if (!loc) throw new ToolError(`Clip not found: ${clipId}`);
    const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
    if (clip.mediaRef !== mediaRef) throw new ToolError(`Clip ${clipId} does not reference mediaRef ${mediaRef} (it references ${clip.mediaRef})`);
    mapping = { clip, fps: editor.timeline.fps };
  }

  const language = parseLanguage(args);

  switch (asset.type) {
    case "image": return readImage(asset);
    case "video": return readVideo(asset, args, mapping, language);
    case "audio": return readAudio(asset, args, mapping, language);
    case "lottie": return readLottie(asset, args);
    case "subtitle": return readSubtitle(asset);
    case "text": throw new ToolError("Text clips are not stored as media assets.");
    case "sequence": throw new ToolError("Sequences are timelines, not media assets. Use get_timeline.");
  }
}

/** Cloud transcription takes an ISO 639-1 code: the primary subtag of the BCP-47 `language` arg. */
function parseLanguage(args: ToolArgs): string | undefined {
  const lang = argString(args, "language");
  if (lang === undefined) return undefined;
  const base = lang.split(/[-_]/u)[0];
  return base === "" ? undefined : base.toLowerCase();
}

async function readSubtitle(asset: MediaAsset): Promise<ToolResult> {
  let cues;
  try {
    cues = await parseSubtitleFile(asset.url);
  } catch (e) {
    throw new ToolError(`Failed to parse subtitle file: ${errorMessage(e)}`);
  }
  const meta = baseMeta(asset);
  meta.cueCount = cues.length;
  if (cues.length > subtitleInspectCueLimit) meta.note = `Showing the first ${subtitleInspectCueLimit} of ${cues.length} cues.`;
  meta.cues = cues.slice(0, subtitleInspectCueLimit).map((cue) => ({ startSeconds: cue.startSeconds, endSeconds: cue.endSeconds, text: cue.text }));
  return ok(encodeMeta(meta));
}

async function readImage(asset: MediaAsset): Promise<ToolResult> {
  const encoded = await inspectBackend().readImage(asset.url);
  if (!encoded) throw new ToolError("Failed to read or decode image file");
  const fileSize = (await (await mediaIo()).stat(asset.url))?.size ?? 0;
  const meta = baseMeta(asset);
  meta.mimeType = encoded.mime;
  meta.byteSize = fileSize;
  meta.encodedByteSize = encoded.encodedByteSize;
  meta.coordinateGrid = inspectGridNote;
  // Only the pixel size is available (no ImageIO): orientation, depth and color model are not reported.
  meta.imageProperties = { pixelWidth: encoded.pixelWidth, pixelHeight: encoded.pixelHeight };
  const content: ToolBlock[] = [
    { kind: "image", base64: encoded.base64, mediaType: encoded.mime },
    { kind: "text", text: encodeMeta(meta) },
  ];
  return { content, isError: false };
}

async function readLottie(asset: MediaAsset, args: ToolArgs): Promise<ToolResult> {
  const count = Math.max(1, Math.min(argInt(args, "maxFrames") ?? defaultReadVideoFrames, readVideoMaxFrames));
  const size = asset.sourceWidth !== undefined && asset.sourceHeight !== undefined ? { width: asset.sourceWidth, height: asset.sourceHeight } : undefined;
  const sample = await inspectBackend().lottieFrames(asset.url, size, count);
  if (!sample || sample.frames.length === 0) throw new ToolError(`Failed to render Lottie frames from ${asset.name}`);
  const meta = baseMeta(asset);
  meta.framerate = sample.framerate;
  meta.frameCount = sample.frameCount;
  meta.durationSeconds = jsonRounded(sample.duration, 3);
  meta.sampledFrameIndices = sample.frames.map((f) => f.frameIndex);
  meta.coordinateGrid = inspectGridNote;
  meta.note = "Lottie frames sampled evenly across the animation; transparent areas composited over gray.";
  const images: ToolBlock[] = sample.frames.map((f) => ({ kind: "image", base64: f.base64, mediaType: "image/jpeg" }));
  return { content: [...images, { kind: "text", text: encodeMeta(meta) }], isError: false };
}

type TranscriptOutcome = { ok: true; transcript: TranscriptionResult } | { ok: false; error: string };

async function readVideo(asset: MediaAsset, args: ToolArgs, mapping: ClipMapping | undefined, language: string | undefined): Promise<ToolResult> {
  if (!(asset.duration > 0)) throw new ToolError(`Video has zero duration: ${asset.name}`);
  const range = sourceRange(args, asset.duration);
  const windowStart = range?.start ?? 0;
  const windowEnd = range?.end ?? asset.duration;

  const meta = baseMeta(asset);
  meta.hasAudio = asset.hasAudio;
  if (range) meta.timeRange = [range.start, range.end];

  const backend = inspectBackend();
  const wantsOverview = argBool(args, "overview") === true;
  const frameCount = Math.max(1, Math.min(argInt(args, "maxFrames") ?? defaultReadVideoFrames, readVideoMaxFrames));
  const transcriptTask: Promise<TranscriptOutcome> | undefined = asset.hasAudio
    ? backend
        .transcribe({ path: asset.url, range: range ? { start: range.start, end: range.end } : undefined, durationSeconds: asset.duration, language })
        .then((transcript): TranscriptOutcome => ({ ok: true, transcript }), (e: unknown): TranscriptOutcome => ({ ok: false, error: errorMessage(e) }))
    : undefined;

  const imageBlocks: ToolBlock[] = [];
  try {
    if (wantsOverview) {
      let sheet;
      try {
        sheet = await backend.overview(asset.url, windowStart, windowEnd);
      } catch (e) {
        throw new ToolError(`Overview failed: ${errorMessage(e)}`);
      }
      meta.overview = { tileTimestamps: sheet.timestamps.map((t) => jsonRounded(t, 3)) };
      imageBlocks.push({ kind: "image", base64: sheet.base64, mediaType: "image/jpeg" });
    } else {
      const times = Array.from({ length: frameCount }, (_, i) => windowStart + ((windowEnd - windowStart) * (i + 0.5)) / frameCount);
      const frames = await backend.videoFrames(asset.url, times);
      if (frames === "noVideoTrack") throw new ToolError(`No video track available in ${asset.name}`);
      if (frames.length === 0) throw new ToolError(`Failed to extract frames from ${asset.name}`);
      meta.frameTimestamps = frames.map((f: SampledFrame) => jsonRounded(f.timestamp, 3));
      meta.coordinateGrid = inspectGridNote;
      for (const f of frames) imageBlocks.push({ kind: "image", base64: f.base64, mediaType: "image/jpeg" });
    }
  } catch (e) {
    await transcriptTask;
    throw e;
  }

  const outcome = await transcriptTask;
  if (outcome?.ok === true) meta.transcription = transcriptionMeta(outcome.transcript, mapping, argBool(args, "wordTimestamps") ?? false);
  else if (outcome?.ok === false) meta.transcriptionError = outcome.error;
  if (mapping) meta.timelineMapping = timelineMappingMeta(mapping.clip, mapping.fps);
  return { content: [...imageBlocks, { kind: "text", text: encodeMeta(meta) }], isError: false };
}

async function readAudio(asset: MediaAsset, args: ToolArgs, mapping: ClipMapping | undefined, language: string | undefined): Promise<ToolResult> {
  const range = sourceRange(args, asset.duration);
  let transcript: TranscriptionResult;
  try {
    transcript = await inspectBackend().transcribe({
      path: asset.url,
      range: range ? { start: range.start, end: range.end } : undefined,
      durationSeconds: asset.duration > 0 ? asset.duration : undefined,
      language,
    });
  } catch (e) {
    throw new ToolError(`Transcription failed: ${errorMessage(e)}`);
  }
  const meta = baseMeta(asset);
  if (range) meta.timeRange = [range.start, range.end];
  Object.assign(meta, transcriptionMeta(transcript, mapping, argBool(args, "wordTimestamps") ?? false));
  if (mapping) meta.timelineMapping = timelineMappingMeta(mapping.clip, mapping.fps);
  return ok(encodeMeta(meta));
}
