// Pure parts of BeatDetector.swift: chunk planning/stitching of the Beat This! logits and peak picking.

export interface BeatAnalysis {
  /** 0 when indeterminate */
  bpm: number;
  /** seconds in source media */
  beats: number[];
  downbeats: number[];
}

export interface BeatAnalysisCacheEntry {
  analysis: BeatAnalysis;
  fileTag: string;
}

// Model contract: 22050 Hz mono, hop 441 (50 logit frames/s), fixed 1500-frame chunks.
export const beatSampleRate = 22050;
export const beatHop = 441;
export const beatChunkFrames = 1500;
export const beatChunkSamples = (beatChunkFrames - 1) * beatHop;
// Frames discarded per chunk edge, matching Beat This border_size.
export const beatBorder = 6;
export const beatStrideFrames = beatChunkFrames - 2 * beatBorder;

export interface ChunkLogits {
  beat: Float32Array;
  downbeat: Float32Array;
}

export type ChunkRunner = (chunk: Float32Array) => Promise<ChunkLogits>;

/** Logit frames (20 ms) for `sampleCount` samples. */
export function beatFrameCount(sampleCount: number): number {
  return Math.max(1, Math.trunc(sampleCount / beatHop) + 1);
}

/** Chunk starts in frames relative to the piece; starts `border` frames early so frame 0 is interior. */
export function planBeatChunks(totalFrames: number): number[] {
  const starts: number[] = [];
  for (let chunkStart = -beatBorder; chunkStart + beatBorder < totalFrames; chunkStart += beatStrideFrames) starts.push(chunkStart);
  return starts;
}

/** Processes audio in overlapping chunks, keeping only the middle (non-border) frames, first write wins. */
export async function predictLogits(
  samples: Float32Array,
  runChunk: ChunkRunner,
  onProgress?: (fraction: number) => void,
): Promise<ChunkLogits> {
  const totalFrames = beatFrameCount(samples.length);
  const beat = new Float32Array(totalFrames).fill(Number.NEGATIVE_INFINITY);
  const downbeat = new Float32Array(totalFrames).fill(Number.NEGATIVE_INFINITY);
  const starts = planBeatChunks(totalFrames);
  for (let n = 0; n < starts.length; n++) {
    const chunkStart = starts[n] as number;
    const sampleStart = chunkStart * beatHop;
    const chunk = new Float32Array(beatChunkSamples);
    const srcLo = Math.max(0, sampleStart);
    const srcHi = Math.min(samples.length, sampleStart + beatChunkSamples);
    if (srcLo < srcHi) chunk.set(samples.subarray(srcLo, srcHi), srcLo - sampleStart);
    const out = await runChunk(chunk);
    if (out.beat.length !== beatChunkFrames || out.downbeat.length !== beatChunkFrames) throw new Error("Beat model returned an unexpected output size.");
    for (let i = beatBorder; i < beatChunkFrames - beatBorder; i++) {
      const global = chunkStart + i;
      if (global < 0 || global >= totalFrames) continue;
      if (beat[global] === Number.NEGATIVE_INFINITY) {
        beat[global] = out.beat[i] as number;
        downbeat[global] = out.downbeat[i] as number;
      }
    }
    onProgress?.((n + 1) / starts.length);
  }
  return { beat, downbeat };
}

/** Picks times (in seconds) where sigmoid(logit) is a local max above the threshold. */
export function pickPeaks(logits: ArrayLike<number>, threshold = 0.5): number[] {
  if (logits.length <= 2) return [];
  const times: number[] = [];
  for (let i = 1; i < logits.length - 1; i++) {
    const l = logits[i] as number;
    const p = 1 / (1 + Math.exp(-l));
    if (!(p >= threshold) || !(l >= (logits[i - 1] as number)) || !(l > (logits[i + 1] as number))) continue;
    times.push((i * beatHop) / beatSampleRate);
  }
  return times;
}

/** 60 / median inter-beat interval. */
export function estimateBPM(beats: readonly number[]): number | undefined {
  if (beats.length <= 2) return undefined;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push((beats[i] as number) - (beats[i - 1] as number));
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.trunc(intervals.length / 2)] as number;
  return median > 0 ? 60 / median : undefined;
}

export function analysisFromLogits(logits: ChunkLogits): BeatAnalysis {
  const beats = pickPeaks(logits.beat);
  return { bpm: estimateBPM(beats) ?? 0, beats, downbeats: pickPeaks(logits.downbeat) };
}

/** Parses a cached JSON sidecar; undefined when it is not a valid analysis (Swift `try? JSONDecoder().decode`). */
export function decodeBeatAnalysis(text: string): BeatAnalysis | undefined {
  try {
    const v = JSON.parse(text) as Partial<Record<keyof BeatAnalysis, unknown>>;
    const numbers = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === "number");
    if (typeof v.bpm !== "number" || !numbers(v.beats) || !numbers(v.downbeats)) return undefined;
    return { bpm: v.bpm, beats: v.beats, downbeats: v.downbeats };
  } catch {
    return undefined;
  }
}
