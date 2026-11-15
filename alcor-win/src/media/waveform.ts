import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, type InputAudioTrack } from "mediabunny";
import { joinPath } from "../model";
import { diskCacheKey } from "./cacheKey";
import { abortError, AsyncSemaphore, InflightMap, isAbortError, throwIfAborted, yieldToUi } from "./concurrency";
import { diskCacheDirectory } from "./diskCache";
import { mediaIo } from "./io";
import { ByteLru } from "./lru";
import { mediaUrl } from "./mediaUrl";
import {
  envelopeSampleRate, makeEnvelopeAccumulator, makeLinearResampler, makePeakAccumulator, mixToMono, peakEnvelopeRate,
  type AudioEnvelope,
} from "./peaks";
import { waveformGateValue } from "./thumbnailMath";
import { emitVisualReady } from "./visualEvents";

export class NoAudioTrackError extends Error {
  constructor(name: string) {
    super(`No audio track in ${name}`);
  }
}

/** Seconds; `AudioTrackReader.read(range:)`. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Spend at most this long decoding before handing the thread back to the UI. */
const sliceBudgetMs = 8;

async function openAudio(path: string): Promise<{ input: Input<UrlSource>; track: InputAudioTrack }> {
  const input = new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new NoAudioTrackError(path);
    if (!(await track.canDecode())) throw new Error(`Audio codec not decodable in ${path}`);
    return { input, track };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/**
 * `AudioTrackReader.read`: streams the first audio track as mono Float32 chunks (channel average),
 * never holding more than one decoded packet. Yields to the UI between slices and honours `signal`.
 */
export async function readMonoChunks(
  track: InputAudioTrack,
  range: TimeRange | undefined,
  signal: AbortSignal | undefined,
  onChunk: (mono: Float32Array, sampleRate: number) => void,
): Promise<void> {
  const sink = new AudioSampleSink(track);
  let sliceStart = performance.now();
  for await (const sample of sink.samples(range?.start, range?.end)) {
    try {
      throwIfAborted(signal);
      const sr = sample.sampleRate;
      let frameOffset = 0;
      let frameCount = sample.numberOfFrames;
      if (range) {
        frameOffset = Math.max(0, Math.round((range.start - sample.timestamp) * sr));
        frameCount = Math.min(frameCount, Math.round((range.end - sample.timestamp) * sr)) - frameOffset;
      }
      if (frameCount <= 0) continue;
      const planes: Float32Array[] = [];
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const plane = new Float32Array(frameCount);
        sample.copyTo(plane, { planeIndex: c, format: "f32-planar", frameOffset, frameCount });
        planes.push(plane);
      }
      onChunk(mixToMono(planes), sr);
    } finally {
      sample.close();
    }
    if (performance.now() - sliceStart > sliceBudgetMs) {
      await yieldToUi();
      sliceStart = performance.now();
    }
  }
}

/** `WaveformExtractor.peakEnvelope`: dB-normalised peaks (0 = loud, 1 = silence), at most 240 000 of them. */
export async function extractPeakEnvelope(path: string, range?: TimeRange, signal?: AbortSignal): Promise<Float32Array> {
  const { input, track } = await openAudio(path);
  try {
    const span = range ? range.end - range.start : await input.computeDuration();
    const acc = makePeakAccumulator(peakEnvelopeRate(span));
    await readMonoChunks(track, range, signal, (mono, sampleRate) => acc.push(mono, sampleRate));
    return acc.finish();
  } finally {
    input.dispose();
  }
}

/** `AudioEnvelopeExtractor.extract`: log-energy envelope at 2.5 ms hops over 16 kHz mono. */
export async function extractAudioEnvelope(path: string, range?: TimeRange, signal?: AbortSignal): Promise<AudioEnvelope> {
  const { input, track } = await openAudio(path);
  try {
    const acc = makeEnvelopeAccumulator();
    let resampler: ReturnType<typeof makeLinearResampler> | undefined;
    await readMonoChunks(track, range, signal, (mono, sampleRate) => {
      resampler ??= makeLinearResampler(sampleRate, envelopeSampleRate);
      acc.push(resampler.push(mono));
    });
    return acc.finish();
  } finally {
    input.dispose();
  }
}

// ---- cached peaks (MediaVisualCache.loadOrGenerateWaveform) ----

const memoryBudgetBytes = 64 * 1024 * 1024;
const waveformGate = new AsyncSemaphore(waveformGateValue);
const peaksMemory = new ByteLru<Float32Array>(memoryBudgetBytes);
const latestKeyByPath = new Map<string, string>();
const flights = new InflightMap<Float32Array | null>();

const cacheDirectoryName = "MediaVisualCache";

async function cacheFile(key: string): Promise<string> {
  return joinPath(await diskCacheDirectory(cacheDirectoryName), `${key}.waveform2`);
}

export function encodePeaks(peaks: Float32Array): Uint8Array {
  return new Uint8Array(peaks.buffer, peaks.byteOffset, peaks.byteLength);
}

/** Rejects empty or truncated files like `loadWaveform` (non-empty, multiple of 4 bytes). */
export function decodePeaks(bytes: Uint8Array): Float32Array | undefined {
  if (bytes.length === 0 || bytes.length % 4 !== 0) return undefined;
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, copy.length / 4);
}

async function loadFromDisk(file: string): Promise<Float32Array | undefined> {
  const io = await mediaIo();
  try {
    if (!(await io.stat(file))) return undefined;
    return decodePeaks(await io.readAll(file));
  } catch {
    return undefined;
  }
}

async function saveToDisk(file: string, peaks: Float32Array): Promise<void> {
  try {
    await (await mediaIo()).writeBytes(file, encodePeaks(peaks));
  } catch {
    // the cache is best effort
  }
}

/**
 * Peaks for the file's first audio track: memory, then disk cache (keyed on path + size + mtime), then decode
 * (at most 2 at a time). Null when the file has no decodable audio.
 */
export async function getWaveform(path: string, signal?: AbortSignal): Promise<Float32Array | null> {
  const io = await mediaIo();
  const stat = await io.stat(path);
  if (!stat || stat.isDir) return null;
  const key = await diskCacheKey(path, stat);
  latestKeyByPath.set(path, key);
  const hit = peaksMemory.get(key);
  if (hit) return hit;
  return flights.run(
    key,
    async (flightSignal) => {
      const file = await cacheFile(key);
      const cached = await loadFromDisk(file);
      if (cached) {
        peaksMemory.set(key, cached, cached.byteLength);
        emitVisualReady({ kind: "waveform", path });
        return cached;
      }
      return waveformGate.run(async () => {
        let peaks: Float32Array;
        try {
          peaks = await extractPeakEnvelope(path, undefined, flightSignal);
        } catch (e) {
          if (flightSignal.aborted) throw abortError();
          if (isAbortError(e)) throw e;
          return null;
        }
        if (peaks.length === 0) return null;
        await saveToDisk(file, peaks);
        peaksMemory.set(key, peaks, peaks.byteLength);
        emitVisualReady({ kind: "waveform", path });
        return peaks;
      }, flightSignal);
    },
    signal,
  );
}

/** Synchronous lookup for draw calls; undefined until `getWaveform` has completed for the file's current version. */
export function peekWaveform(path: string): Float32Array | undefined {
  const key = latestKeyByPath.get(path);
  return key === undefined ? undefined : peaksMemory.peek(key);
}

export function invalidateWaveform(path: string): void {
  const key = latestKeyByPath.get(path);
  if (key !== undefined) peaksMemory.delete(key);
  latestKeyByPath.delete(path);
}

export function clearWaveformMemory(): void {
  peaksMemory.clear();
  latestKeyByPath.clear();
}
