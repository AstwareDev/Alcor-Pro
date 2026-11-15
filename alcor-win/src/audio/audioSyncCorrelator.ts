import { swiftRound } from "../util/math";

// Port of Audio/AudioSyncCorrelator.swift: normalised cross-correlation of 2.5 ms log-energy envelopes, a 2x
// pyramid search for wide lag ranges, and a five-chunk consensus that fits recorder clock drift.

export interface CorrelationResult {
  lagHops: number;
  confidence: number;
  driftRatio: number;
  /** Fractional lag from the drift fit; use for placement so hop rounding cannot flip a near-half-frame result. */
  exactLagHops: number;
}

export function makeCorrelationResult(lagHops: number, confidence: number, driftRatio = 0, exactLagHops?: number): CorrelationResult {
  return { lagHops, confidence, driftRatio, exactLagHops: exactLagHops ?? lagHops };
}

export const minOverlap = 16;
const pyramidStride = 2;
/** Lag ranges up to this size are searched exactly; larger ones go through the pyramid. */
const maxExactLagCount = 4_096;
const maxCandidates = 16;
// Consensus constants assume the 2.5 ms sync envelope hop.
/** 60-second chunks: long enough to correlate reliably, short enough that drift stays sub-hop within one. */
const consensusChunkHops = 24_000;
const consensusChunkCount = 5;
/** Chunk lags within 1 s of each other count as agreeing. */
const consensusToleranceHops = 400;
/** Search radius around the previous chunk's lag before rescanning the full windows. */
const reacquireRadiusHops = 800;
/** Below this chunk spread (2.5 min) the fitted slope is dominated by hop quantization. */
const driftFitMinSpanHops = 60_000;
/** Recorder crystals disagree by tens of ppm; a larger fitted slope means mismatched content, not drift. */
const maxDriftRatio = 0.0005;
/** Slopes below ~one frame per hour are quantization noise, not drift. */
const minDriftRatio = 0.00002;

export interface SeededCorrelateParams {
  reference: Float32Array;
  target: Float32Array;
  seedHops: number | undefined;
  seedWindowHops: number;
  maxLagHops: number;
  minOverlapHops: number;
  minConfidence: number;
}

interface LagWindow {
  center: number;
  radius: number;
}

export interface LagRange {
  lower: number;
  upper: number;
}

/** Synchronous core of `seededCorrelate`; an aborted `signal` yields null (Swift `Task.isCancelled`). */
export function seededCorrelateSync(p: SeededCorrelateParams, signal?: AbortSignal): CorrelationResult | null {
  const windows: LagWindow[] = [{ center: 0, radius: p.maxLagHops }];
  if (p.seedHops !== undefined) windows.push({ center: p.seedHops, radius: p.seedWindowHops });
  return alignByConsensus(p.reference, p.target, windows, p.minOverlapHops, p.minConfidence, signal);
}

export async function seededCorrelate(p: SeededCorrelateParams, signal?: AbortSignal): Promise<CorrelationResult | null> {
  return seededCorrelateSync(p, signal);
}

interface ChunkHit {
  start: number;
  center: number;
  clipLag: number;
  confidence: number;
}

function alignByConsensus(
  reference: Float32Array,
  target: Float32Array,
  windows: readonly LagWindow[],
  minOverlapHops: number,
  minConfidence: number,
  signal: AbortSignal | undefined,
): CorrelationResult | null {
  const bestAcrossWindows = (chunk: Float32Array, chunkStart: number, overlap: number): CorrelationResult | null => {
    let best: CorrelationResult | null = null;
    for (const window of windows) {
      if (signal?.aborted) return null;
      const candidate = correlate(reference, chunk, window.radius, window.center + chunkStart, overlap, signal);
      if (candidate && candidate.confidence > (best?.confidence ?? -Infinity)) best = candidate;
    }
    return best;
  };

  const chunkHops = Math.min(target.length, consensusChunkHops);
  let starts = [0];
  if (target.length > chunkHops) {
    const maxStart = target.length - chunkHops;
    const set = new Set<number>();
    for (let i = 0; i < consensusChunkCount; i++) set.add(Math.trunc((maxStart * i) / (consensusChunkCount - 1)));
    starts = [...set].sort((a, b) => a - b);
  }

  const hits: ChunkHit[] = [];
  for (const start of starts) {
    if (signal?.aborted) return null;
    const chunk = target.subarray(start, start + chunkHops);
    if (isConstant(chunk)) continue;
    const overlap = Math.min(Math.max(minOverlapHops, Math.trunc(chunk.length / 2)), chunk.length);

    let best: CorrelationResult | null = null;
    const prev = hits.at(-1);
    if (prev) {
      best = correlate(reference, chunk, reacquireRadiusHops, prev.clipLag + start, overlap, signal);
      if (best && best.confidence < minConfidence) best = null;
    }
    best ??= bestAcrossWindows(chunk, start, overlap);
    if (!best || best.confidence < minConfidence) continue;
    hits.push({ start, center: start + chunk.length / 2, clipLag: best.lagHops - start, confidence: best.confidence });
  }

  if (hits.length === 0) {
    const best = bestAcrossWindows(target, 0, minOverlapHops);
    return best && best.confidence >= minConfidence ? best : null;
  }

  const sorted = [...hits].sort((a, b) => a.clipLag - b.clipLag);
  let cluster: ChunkHit[] = sorted;
  let clusterScore = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].clipLag - sorted[i].clipLag <= consensusToleranceHops) j += 1;
    const candidate = sorted.slice(i, j + 1);
    const score = candidate.reduce((acc, h) => acc + h.confidence, 0);
    if (score > clusterScore) {
      clusterScore = score;
      cluster = candidate;
    }
  }
  const confidence = cluster.reduce((acc, h) => acc + h.confidence, 0) / cluster.length;

  const centers = cluster.map((h) => h.center);
  const span = Math.max(...centers) - Math.min(...centers);
  if (cluster.length >= 3 && span >= driftFitMinSpanHops) {
    const n = cluster.length;
    const meanX = cluster.reduce((acc, h) => acc + h.center, 0) / n;
    const meanY = cluster.reduce((acc, h) => acc + h.clipLag, 0) / n;
    const varX = cluster.reduce((acc, h) => acc + (h.center - meanX) * (h.center - meanX), 0);
    const cov = cluster.reduce((acc, h) => acc + (h.center - meanX) * (h.clipLag - meanY), 0);
    const slope = varX > 0 ? cov / varX : 0;
    if (Math.abs(slope) >= minDriftRatio && Math.abs(slope) <= maxDriftRatio) {
      const maxResidual = Math.max(...cluster.map((h) => Math.abs(h.clipLag - (meanY + slope * (h.center - meanX)))));
      if (maxResidual <= consensusToleranceHops) {
        const lagAtHead = meanY - slope * meanX;
        return makeCorrelationResult(swiftRound(lagAtHead), confidence, slope, lagAtHead);
      }
    }
  }
  const anchor = cluster.reduce((a, h) => (h.start < a.start ? h : a), cluster[0]);
  return makeCorrelationResult(anchor.clipLag, confidence);
}

function isConstant(samples: Float32Array): boolean {
  for (let i = 1; i < samples.length; i++) if (samples[i] !== samples[0]) return false;
  return true;
}

export function correlate(
  reference: Float32Array,
  target: Float32Array,
  maxLagHops: number,
  centerLagHops = 0,
  minOverlapHops: number = minOverlap,
  signal?: AbortSignal,
): CorrelationResult | null {
  if (reference.length === 0 || target.length === 0 || maxLagHops < 0) return null;
  const shorterCount = Math.min(reference.length, target.length);
  const adaptiveOverlap = Math.max(minOverlap, Math.trunc(shorterCount / 2));
  const requiredOverlap = Math.min(Math.max(minOverlap, minOverlapHops), adaptiveOverlap);
  if (shorterCount < requiredOverlap) return null;

  const validLower = requiredOverlap - target.length;
  const validUpper = reference.length - requiredOverlap;
  const lower = Math.max(validLower, centerLagHops - maxLagHops);
  const upper = Math.min(validUpper, centerLagHops + maxLagHops);
  if (lower > upper) return null;

  return correlateCandidates(reference, target, { lower, upper }, requiredOverlap, signal)[0] ?? null;
}

function correlateCandidates(
  reference: Float32Array,
  target: Float32Array,
  lagRange: LagRange,
  minOverlapHops: number,
  signal: AbortSignal | undefined,
): CorrelationResult[] {
  const lagCount = lagRange.upper - lagRange.lower + 1;
  if (lagCount <= maxExactLagCount || reference.length < pyramidStride * minOverlap || target.length < pyramidStride * minOverlap) {
    return exactCandidates(reference, target, [lagRange], minOverlapHops, signal);
  }

  const coarseTarget = downsample(target, pyramidStride);
  const mapped: CorrelationResult[] = [];
  for (let phase = 0; phase < pyramidStride; phase++) {
    const coarseLower = Math.ceil((lagRange.lower - phase) / pyramidStride);
    const coarseUpper = Math.floor((lagRange.upper - phase) / pyramidStride);
    if (coarseLower > coarseUpper) continue;
    const candidates = correlateCandidates(
      downsample(reference, pyramidStride, phase),
      coarseTarget,
      { lower: coarseLower, upper: coarseUpper },
      Math.max(4, Math.trunc((minOverlapHops + pyramidStride - 1) / pyramidStride)),
      signal,
    );
    for (const c of candidates) mapped.push(makeCorrelationResult(c.lagHops * pyramidStride + phase, c.confidence));
  }
  const coarse = rankedCandidates(mapped);
  if (coarse.length === 0) return [];

  const radius = pyramidStride * 2;
  const ranges = coarse.map((c) => ({
    lower: Math.max(lagRange.lower, c.lagHops - radius),
    upper: Math.min(lagRange.upper, c.lagHops + radius),
  }));
  return exactCandidates(reference, target, merged(ranges), minOverlapHops, signal);
}

export function exactCandidates(
  reference: Float32Array,
  target: Float32Array,
  lagRanges: readonly LagRange[],
  minOverlapHops: number,
  signal?: AbortSignal,
): CorrelationResult[] {
  const ref = Float64Array.from(reference);
  const tgt = Float64Array.from(target);
  const results: CorrelationResult[] = [];
  for (const range of lagRanges) {
    for (let lag = range.lower; lag <= range.upper; lag++) {
      if (signal?.aborted) return [];
      const iStart = Math.max(0, -lag);
      const iEnd = Math.min(tgt.length, ref.length - lag);
      const n = iEnd - iStart;
      if (n < minOverlapHops) continue;

      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      const offset = iStart + lag;
      for (let i = 0; i < n; i++) {
        const x = tgt[iStart + i];
        const y = ref[offset + i];
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
      const cov = sxy - (sx * sy) / n;
      const vx = sxx - (sx * sx) / n;
      const vy = syy - (sy * sy) / n;
      const denom = Math.sqrt(vx * vy);
      if (!(denom > 0)) continue;
      results.push(makeCorrelationResult(lag, Math.max(0, cov / denom)));
    }
  }
  const peaks = results.filter((result, index) => {
    const prev = results[index - 1];
    const next = results[index + 1];
    const leftIsLower = prev === undefined || prev.lagHops !== result.lagHops - 1 || result.confidence >= prev.confidence;
    const rightIsLower = next === undefined || next.lagHops !== result.lagHops + 1 || result.confidence >= next.confidence;
    return leftIsLower && rightIsLower;
  });
  return rankedCandidates(peaks.length === 0 ? results : peaks);
}

function rankedCandidates(candidates: readonly CorrelationResult[]): CorrelationResult[] {
  const ranked = [...candidates].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const da = Math.abs(a.lagHops);
    const db = Math.abs(b.lagHops);
    return da === db ? a.lagHops - b.lagHops : da - db;
  });
  const selected: CorrelationResult[] = [];
  for (const candidate of ranked) {
    if (selected.every((s) => Math.abs(s.lagHops - candidate.lagHops) > 2)) {
      selected.push(candidate);
      if (selected.length === maxCandidates) break;
    }
  }
  return selected;
}

function downsample(samples: Float32Array, stride: number, offset = 0): Float32Array {
  if (offset >= samples.length) return new Float32Array(0);
  if (stride <= 1) return samples.slice(offset);
  const out = new Float32Array(Math.ceil((samples.length - offset) / stride));
  let o = 0;
  for (let start = offset; start < samples.length; start += stride) {
    const end = Math.min(start + stride, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum = Math.fround(sum + samples[i]);
    out[o++] = sum / (end - start);
  }
  return out;
}

function merged(ranges: readonly LagRange[]): LagRange[] {
  const sorted = [...ranges].sort((a, b) => a.lower - b.lower);
  if (sorted.length === 0) return [];
  let current = sorted[0];
  const result: LagRange[] = [];
  for (const range of sorted.slice(1)) {
    if (range.lower <= current.upper + 1) current = { lower: current.lower, upper: Math.max(current.upper, range.upper) };
    else {
      result.push(current);
      current = range;
    }
  }
  result.push(current);
  return result;
}
