// Pure frame-selection logic of Search/Indexing/FrameSampler.swift and VisualIndexer.swift: luma scene changes start new
// shots, a coverage floor keeps long static shots represented, and kept frames become embedding rows.
import type { EmbeddingRow } from "./embeddingStore";

/** Bumped whenever sampling changes, so cached indexes are rebuilt. */
export const samplerVersion = 1;

export interface SamplerOptions {
  candidateInterval: number;
  coverageFloor: number;
  promoteDiff: number;
  /** Caps decoded candidates per video by widening the interval on long footage. */
  maxCandidates: number;
}

export const defaultSamplerOptions: SamplerOptions = { candidateInterval: 2, coverageFloor: 8, promoteDiff: 12, maxCandidates: 90 };

export const lumaCells = 8;

/** Mean luma per cell of an 8x8 RGBA downsample: a cheap visual-change fingerprint. */
export function lumaGrid(rgba: ArrayLike<number>): Float32Array {
  const n = lumaCells * lumaCells;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4] as number) * 0.299 + (rgba[i * 4 + 1] as number) * 0.587 + (rgba[i * 4 + 2] as number) * 0.114;
  }
  return out;
}

export function lumaMeanDiff(a: Float32Array, b: Float32Array): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs((a[i] as number) - (b[i] as number));
  return diff / a.length;
}

/** Candidate timestamps: midpoints of `interval`-long slices; a clip shorter than one slice samples its middle. */
export function candidateTimes(duration: number, options: SamplerOptions = defaultSamplerOptions): number[] {
  if (!(duration > 0)) return [];
  const interval = Math.max(options.candidateInterval, duration / options.maxCandidates);
  const times: number[] = [];
  for (let t = interval / 2; t < duration; t += interval) times.push(t);
  return times.length === 0 ? [duration / 2] : times;
}

/** Decides per candidate whether it starts a new shot and whether it is kept. */
export class ShotSelector {
  private lastGrid: Float32Array | undefined;
  private lastKept = -Infinity;
  private lastTime = -Infinity;

  constructor(private readonly options: SamplerOptions = defaultSamplerOptions) {}

  consider(time: number, grid: Float32Array): { keep: boolean; isNewShot: boolean } {
    if (!(time > this.lastTime)) return { keep: false, isNewShot: false };
    this.lastTime = time;
    const isNewShot = this.lastGrid === undefined || lumaMeanDiff(grid, this.lastGrid) > this.options.promoteDiff;
    this.lastGrid = grid;
    if (!isNewShot && time - this.lastKept < this.options.coverageFloor) return { keep: false, isNewShot };
    this.lastKept = time;
    return { keep: true, isNewShot };
  }
}

/** The first shot starts at 0; each shot ends where the next begins (the last at `duration`). */
export function buildRows(frames: readonly { time: number; isNewShot: boolean }[], duration: number): EmbeddingRow[] {
  const shotStarts: number[] = [];
  const shotOf: number[] = [];
  for (const frame of frames) {
    if (frame.isNewShot) shotStarts.push(shotStarts.length === 0 ? 0 : frame.time);
    shotOf.push(shotStarts.length - 1);
  }
  return frames.map((frame, i) => {
    const shot = shotOf[i] as number;
    return {
      time: frame.time,
      shotStart: shotStarts[shot] as number,
      shotEnd: shot + 1 < shotStarts.length ? (shotStarts[shot + 1] as number) : duration,
    };
  });
}
