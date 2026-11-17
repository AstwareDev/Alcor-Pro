import { createSignal } from "solid-js";
import { convertToTempFile, removeTempFiles } from "../generation/preprocessing/mediaConvert";
import { transcribe as scribeTranscribe } from "../generation/providers/elevenlabs";
import { transcribe as whisperTranscribe } from "../generation/providers/openai";
import { providersWithKeys } from "../generation/providers/registry";
import type { Transcript, TranscribeOptions } from "../generation/providers/transcription";
import type { ProviderId } from "../generation/providers/types";
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { defaultStorage, type KeyValueStorage } from "../settings/storage";
import { sharedLocalTranscriber } from "./localTranscription";
import { cachedCloudTranscript, storeCloudTranscript, type SourceRange } from "./transcriptCache";
import {
  stitchTranscriptionResults, transcriptionOffsetting, transcriptionResultFromProvider, TranscriptionError,
  type TranscriptionResult,
} from "./transcription";

// Replaces TranscriptionBackend.swift / CloudTranscription.swift (Palmier cloud) with the user's own provider key:
// ElevenLabs Scribe preferred, OpenAI Whisper as the fallback. "local" is Whisper on this PC (`localTranscription.ts`,
// the stand-in for the on-device Speech of Transcription.swift); it needs no key and is used when no cloud key is set.

export type CloudBackendId = "elevenlabs" | "openai";
export type TranscriptionBackendId = CloudBackendId | "local";
export type TranscriptionPreference = "auto" | TranscriptionBackendId;

export const cloudBackendIds: readonly CloudBackendId[] = ["elevenlabs", "openai"];
export const transcriptionBackendIds: readonly TranscriptionBackendId[] = [...cloudBackendIds, "local"];

export function transcriptionBackendLabel(id: TranscriptionBackendId): string {
  switch (id) {
    case "elevenlabs": return "ElevenLabs Scribe";
    case "openai": return "OpenAI Whisper";
    case "local": return "On this PC";
  }
}

// MARK: - Choosing a backend

const preferenceKey = "transcriptionBackend";

function readPreference(storage: KeyValueStorage): TranscriptionPreference {
  const raw = storage.getItem(preferenceKey);
  return raw === "elevenlabs" || raw === "openai" || raw === "local" ? raw : "auto";
}

const [preference, setPreferenceSignal] = createSignal<TranscriptionPreference>(readPreference(defaultStorage()));

/** Reactive. */
export function transcriptionPreference(): TranscriptionPreference {
  return preference();
}

export function setTranscriptionPreference(value: TranscriptionPreference, storage: KeyValueStorage = defaultStorage()): void {
  setPreferenceSignal(value);
  if (value === "auto") storage.removeItem(preferenceKey);
  else storage.setItem(preferenceKey, value);
}

/**
 * The backend to use: the user's explicit preference when it is usable (a cloud one needs its key), otherwise
 * ElevenLabs, then OpenAI, then this PC.
 */
export function chooseBackend(pref: TranscriptionPreference, keyed: ReadonlySet<ProviderId>): TranscriptionBackendId {
  if (pref === "local") return pref;
  if (pref !== "auto" && keyed.has(pref)) return pref;
  return cloudBackendIds.find((id) => keyed.has(id)) ?? "local";
}

/** Reactive: the backend `transcribeMedia` would use right now. */
export function activeTranscriptionBackend(): TranscriptionBackendId {
  return chooseBackend(preference(), providersWithKeys());
}

// MARK: - Chunking

/** Longest audio sent in one request: a mono-ish AAC chunk stays far below OpenAI's 25 MB upload limit. */
export const maxChunkSeconds = 600;
/** On-device transcription windows the audio itself, so the whole file goes in one piece. */
export const localChunkSeconds = 24 * 3600;

export function planChunks(range: SourceRange, chunkSeconds = maxChunkSeconds): SourceRange[] {
  const chunks: SourceRange[] = [];
  const total = range.end - range.start;
  if (!(total > 0) || !(chunkSeconds > 0)) return chunks;
  const count = Math.ceil(total / chunkSeconds);
  // Even pieces avoid a tiny trailing chunk.
  const size = total / count;
  for (let i = 0; i < count; i++) {
    chunks.push({ start: range.start + i * size, end: i === count - 1 ? range.end : range.start + (i + 1) * size });
  }
  return chunks;
}

// MARK: - Transcribing

export interface TranscriptionDeps {
  /** Extracts the audio of `range` (whole file when omitted) into a temp file and returns its path. */
  extractAudio(path: string, range: SourceRange | undefined, signal?: AbortSignal): Promise<string>;
  removeTemp(paths: readonly string[]): Promise<void>;
  transcribe(backend: TranscriptionBackendId, path: string, options: TranscribeOptions, signal?: AbortSignal): Promise<Transcript>;
}

const extractionGate = new AsyncSemaphore(2);

async function extractAudioTrack(path: string, range: SourceRange | undefined, signal?: AbortSignal): Promise<string> {
  await extractionGate.wait(signal);
  try {
    return await convertToTempFile(
      { inputPath: path, container: "m4a", audioOnly: true, ...(range ? { trim: range } : {}) },
      "palmier-stt",
      signal,
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new TranscriptionError("audioExtractionFailed", e instanceof Error ? e.message : String(e));
  } finally {
    extractionGate.signal();
  }
}

export const defaultTranscriptionDeps: TranscriptionDeps = {
  extractAudio: extractAudioTrack,
  removeTemp: removeTempFiles,
  transcribe: (backend, path, options, signal) => {
    switch (backend) {
      case "elevenlabs": return scribeTranscribe(path, options, signal);
      case "openai": return whisperTranscribe(path, options, signal);
      case "local": return sharedLocalTranscriber().transcribe(path, options, signal);
    }
  },
};

export interface TranscribeRequest {
  path: string;
  /** Source-time window; omit to transcribe the whole file (then `durationSeconds` bounds the chunking). */
  range?: SourceRange | undefined;
  durationSeconds?: number | undefined;
  /** ISO 639-1 code; omit to auto-detect. */
  language?: string | undefined;
  backend: TranscriptionBackendId;
  signal?: AbortSignal | undefined;
  /** Called after each chunk with the completed fraction. */
  onProgress?: ((fraction: number) => void) | undefined;
}

/** Port of `CloudTranscription.languageIdentifier`: the primary language subtag. */
export function languageIdentifier(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  const base = locale.split(/[-_]/u)[0];
  return base === "" ? undefined : base.toLowerCase();
}

/**
 * Extracts the audio in bounded chunks, transcribes each with the chosen backend and stitches the words back into
 * source time. No caching: see `transcribeCached`.
 */
export async function transcribeMedia(req: TranscribeRequest, deps: TranscriptionDeps = defaultTranscriptionDeps): Promise<TranscriptionResult> {
  throwIfAborted(req.signal);
  const window: SourceRange | undefined = req.range ?? (req.durationSeconds !== undefined && req.durationSeconds > 0 ? { start: 0, end: req.durationSeconds } : undefined);
  const chunks = window ? planChunks(window, req.backend === "local" ? localChunkSeconds : maxChunkSeconds) : [undefined];
  if (chunks.length === 0) throw new TranscriptionError("audioExtractionFailed", "Nothing to transcribe.");
  const parts: { result: TranscriptionResult; start: number; end: number }[] = [];
  for (const [i, chunk] of chunks.entries()) {
    throwIfAborted(req.signal);
    const temp = await deps.extractAudio(req.path, chunk, req.signal);
    const options: TranscribeOptions = {
      ...(req.language ? { language: req.language } : {}),
      // Slow on-device transcription reports progress from inside the chunk.
      ...(req.backend === "local" && chunk ? { durationSeconds: chunk.end - chunk.start } : {}),
      ...(req.backend === "local" && req.onProgress ? { onProgress: (f: number) => req.onProgress?.((i + f) / chunks.length) } : {}),
    };
    try {
      const transcript = await deps.transcribe(req.backend, temp, options, req.signal);
      const offset = chunk?.start ?? 0;
      const shifted = transcriptionOffsetting(transcriptionResultFromProvider(transcript), offset);
      parts.push({ result: shifted, start: chunk?.start ?? 0, end: chunk?.end ?? Number.POSITIVE_INFINITY });
    } finally {
      await deps.removeTemp([temp]);
    }
    req.onProgress?.((i + 1) / chunks.length);
  }
  return parts.length === 1 ? parts[0].result : stitchTranscriptionResults(parts);
}

/** Port of `CloudTranscription.transcribe`: cache lookup keyed by file identity, range and language. */
export async function transcribeCached(req: TranscribeRequest, deps: TranscriptionDeps = defaultTranscriptionDeps): Promise<TranscriptionResult> {
  const variant = { range: req.range, language: req.language };
  const hit = await cachedCloudTranscript(req.path, variant);
  if (hit) return hit;
  const result = await transcribeMedia(req, deps);
  throwIfAborted(req.signal);
  await storeCloudTranscript(result, req.path, variant);
  return result;
}
