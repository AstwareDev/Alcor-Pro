// Port of Audio/Analysis/VoiceActivity.swift (analysis types, mask expansion, JSON sidecar cache) plus the speech-swift
// VADPipeline.binarize / filterDurations the Swift calls with VADConfig.sileroDefault (soniqo/speech-swift v0.0.21).
// Probabilities come from an injected `VadEngine` (Silero ONNX in a worker; see sileroEngine.ts).
import { joinPath } from "../model";
import { sizeMtimeTag } from "../media/cacheKey";
import { diskCacheDirectory } from "../media/diskCache";
import { mediaIo, type MediaIo } from "../media/io";
import { vadChunkDuration } from "./silenceRemovalSettings";

export const vadSampleRate = 16_000;
export const vadChunkSize = 512;
export { vadChunkDuration };

export interface SpeechSpan {
  start: number;
  end: number;
}

export interface VoiceAnalysis {
  /** Number of 32 ms VAD cells spanning the full source duration. */
  chunkCount: number;
  /** Speech spans in source seconds. */
  segments: SpeechSpan[];
}

/** Per-cell speech flags; index maps uniformly onto the source duration (`Analysis.mask`). */
export function analysisMask(analysis: VoiceAnalysis): boolean[] {
  const mask = new Array<boolean>(analysis.chunkCount).fill(false);
  for (const span of analysis.segments) {
    const lo = Math.max(0, Math.trunc(span.start / vadChunkDuration));
    const hi = Math.min(analysis.chunkCount, Math.trunc(Math.ceil(span.end / vadChunkDuration)));
    if (lo >= hi) continue;
    for (let i = lo; i < hi; i++) mask[i] = true;
  }
  return mask;
}

export function chunkCountForSamples(sampleCount: number): number {
  return Math.trunc((sampleCount + vadChunkSize - 1) / vadChunkSize);
}

// VADConfig.sileroDefault. The Swift pipeline runs in Float32, so every step is rounded with fround.
const f = Math.fround;
const sileroDefault = {
  onset: f(0.5),
  offset: f(0.35),
  minSpeechDuration: f(0.25),
  minSilenceDuration: f(0.1),
} as const;

/** Hysteresis thresholding then duration filtering over one probability per 512-sample chunk (`VADPipeline.binarize`). */
export function binarizeSpeech(probabilities: ArrayLike<number>): SpeechSpan[] {
  const chunkDuration = f(f(vadChunkSize) / f(vadSampleRate));
  // windowDuration = Float(count) * chunkDuration and framesPerChunk = count, so frameDuration = window / count.
  const frameDuration = probabilities.length === 0 ? chunkDuration : f(f(f(probabilities.length) * chunkDuration) / f(probabilities.length));
  const raw: { start: number; end: number }[] = [];
  let inSpeech = false;
  let speechStart = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const prob = probabilities[i];
    const time = f(f(i) * frameDuration);
    if (!inSpeech && prob >= sileroDefault.onset) {
      inSpeech = true;
      speechStart = time;
    } else if (inSpeech && prob < sileroDefault.offset) {
      inSpeech = false;
      raw.push({ start: speechStart, end: time });
    }
  }
  if (inSpeech) raw.push({ start: speechStart, end: f(f(probabilities.length) * frameDuration) });
  return filterDurations(raw).map((s) => ({ start: s.start, end: s.end }));
}

function filterDurations(segments: { start: number; end: number }[]): { start: number; end: number }[] {
  const filtered = segments.filter((s) => f(s.end - s.start) >= sileroDefault.minSpeechDuration);
  if (filtered.length === 0) return [];
  const merged: { start: number; end: number }[] = [];
  let current = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    const next = filtered[i];
    if (f(next.start - current.end) < sileroDefault.minSilenceDuration) current = { start: current.start, end: next.end };
    else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

/** One streaming pass over a file's 16 kHz mono samples. Model state is reset by `VadEngine.begin`. */
export interface VadRun {
  push(samples: Float32Array): Promise<void>;
  finish(): Promise<VoiceAnalysis>;
  /** Frees the engine for the next run; safe after `finish` and required when abandoning a run. */
  release(): void;
}

export interface VadEngine {
  begin(signal?: AbortSignal): Promise<VadRun>;
}

// ---- JSON sidecar cache (`<cacheDir>/AudioAnalysis/<mediaRef>_<size>_<mtimeSec>_vad.json`) ----

const cacheDirectoryName = "AudioAnalysis";

async function analysisPath(io: MediaIo, sourcePath: string, mediaRef: string): Promise<string> {
  const stat = await io.stat(sourcePath);
  return joinPath(await diskCacheDirectory(cacheDirectoryName), `${mediaRef}_${sizeMtimeTag(stat)}_vad.json`);
}

function decodeAnalysis(text: string): VoiceAnalysis | undefined {
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json !== "object" || json === null) return undefined;
    const o = json as Record<string, unknown>;
    if (typeof o.chunkCount !== "number" || !Array.isArray(o.segments)) return undefined;
    const segments: SpeechSpan[] = [];
    for (const s of o.segments) {
      if (typeof s !== "object" || s === null) return undefined;
      const span = s as Record<string, unknown>;
      if (typeof span.start !== "number" || typeof span.end !== "number") return undefined;
      segments.push({ start: span.start, end: span.end });
    }
    return { chunkCount: o.chunkCount, segments };
  } catch {
    return undefined;
  }
}

export async function cachedAnalysis(sourcePath: string, mediaRef: string): Promise<VoiceAnalysis | undefined> {
  const io = await mediaIo();
  try {
    const bytes = await io.readAll(await analysisPath(io, sourcePath, mediaRef));
    return decodeAnalysis(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Writes the sidecar and removes stale entries for the same `mediaRef` (source replaced on disk). */
export async function cacheAnalysis(analysis: VoiceAnalysis, sourcePath: string, mediaRef: string): Promise<void> {
  const io = await mediaIo();
  const output = await analysisPath(io, sourcePath, mediaRef);
  const dir = await diskCacheDirectory(cacheDirectoryName);
  await io.mkdir(dir);
  try {
    for (const entry of await io.list(dir)) {
      if (entry.name.startsWith(`${mediaRef}_`) && entry.path !== output) await io.remove(entry.path).catch(() => undefined);
    }
  } catch {
    // directory listing is best effort, like `try? contentsOfDirectory`
  }
  await io.writeBytes(output, new TextEncoder().encode(JSON.stringify(analysis)));
}

export async function cacheNoAudioAnalysis(sourcePath: string, mediaRef: string): Promise<VoiceAnalysis> {
  const analysis: VoiceAnalysis = { chunkCount: 0, segments: [] };
  await cacheAnalysis(analysis, sourcePath, mediaRef);
  return analysis;
}
