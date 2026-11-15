import { describe, expect, it } from "vitest";
import { correlate, exactCandidates, seededCorrelate } from "./audioSyncCorrelator";

// Port of Tests/PalmierProTests/Audio/AudioSyncCorrelatorTests.swift (same LCG so signals match the Swift ones).

const mask64 = (1n << 64n) - 1n;

function signal(count: number, seed = 0x9e3779b97f4a7c15n): Float32Array {
  let state = seed;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask64;
    out[i] = Number((state >> 33n) % 1000n) / 1000;
  }
  return out;
}

const slice = (a: Float32Array, from: number, to?: number): Float32Array => a.slice(from, to);

describe("AudioSyncCorrelator", () => {
  it("detectsZeroLagOnIdenticalSignals", () => {
    const s = signal(500);
    const r = correlate(s, s, 50);
    expect(r?.lagHops).toBe(0);
    expect(r?.confidence).toBeGreaterThan(0.99);
  });

  it("detectsPositiveLag", () => {
    const base = signal(600);
    const r = correlate(base, slice(base, 20), 100);
    expect(r?.lagHops).toBe(20);
    expect(r?.confidence).toBeGreaterThan(0.99);
  });

  it("detectsNegativeLag", () => {
    const base = signal(600);
    const r = correlate(slice(base, 15), base, 100);
    expect(r?.lagHops).toBe(-15);
    expect(r?.confidence).toBeGreaterThan(0.99);
  });

  it("isInvariantToGain", () => {
    const base = signal(400);
    const target = slice(base, 10).map((v) => v * 0.25 + 0.05);
    const r = correlate(base, target, 60);
    expect(r?.lagHops).toBe(10);
    expect(r?.confidence).toBeGreaterThan(0.95);
  });

  it("lowConfidenceOnUncorrelatedSignals", () => {
    const r = correlate(signal(500, 1n), signal(500, 999n), 50);
    expect(r).not.toBeNull();
    expect(r?.confidence).toBeLessThan(0.5);
  });

  it("returnsNilWhenOverlapTooSmall", () => {
    expect(correlate(signal(8), signal(8), 0)).toBeNull();
  });

  it("handlesEmptyInput", () => {
    expect(correlate(new Float32Array(0), Float32Array.of(1, 2, 3), 5)).toBeNull();
    expect(correlate(Float32Array.of(1, 2, 3), new Float32Array(0), 5)).toBeNull();
  });

  it("seededCorrelationChoosesStrongerFullWindowMatch", async () => {
    const target = signal(300, 7n);
    const interference = signal(300, 99n);
    const reference = new Float32Array(1_000);
    reference.set(target, 100);
    reference.set(target.map((v, i) => v * 0.6 + interference[i] * 0.4), 600);
    const r = await seededCorrelate({
      reference, target, seedHops: 600, seedWindowHops: 10, maxLagHops: 200, minOverlapHops: 100, minConfidence: 0.5,
    });
    expect(r?.lagHops).toBe(100);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  });

  it("seededCorrelateObservesCallingTaskCancellation", async () => {
    const s = signal(2_000);
    const controller = new AbortController();
    controller.abort();
    const r = await seededCorrelate(
      { reference: s, target: s, seedHops: undefined, seedWindowHops: 10, maxLagHops: 500, minOverlapHops: 100, minConfidence: 0.5 },
      controller.signal,
    );
    expect(r).toBeNull();
  });

  it("edgePeakInRefinedRangeIsNotSuppressedByNeighboringRange", () => {
    const omega = (2 * Math.PI) / 64;
    const reference = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * omega));
    const target = Float32Array.from({ length: 200 }, (_, i) => Math.sin((i + 10) * omega));
    const candidates = exactCandidates(reference, target, [{ lower: 0, upper: 2 }, { lower: 9, upper: 11 }], 16);
    expect(candidates[0]?.lagHops).toBe(10);
    expect(candidates.some((c) => c.lagHops === 2)).toBe(true);
  });

  it("requestedOverlapAdaptsForShortClips", () => {
    const samples = signal(120);
    const r = correlate(samples, samples, 20, 0, 300);
    expect(r?.lagHops).toBe(0);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  });

  it("multiresolutionSearchRefinesToExactHop", () => {
    const base = signal(2_000);
    const r = correlate(base, slice(base, 37), 400, 0, 300);
    expect(r?.lagHops).toBe(37);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  });

  it("pyramidSearchFindsLargeNonalignedLag", () => {
    const base = signal(25_000);
    const lag = 20_003;
    const r = correlate(base, slice(base, lag, lag + 4_000), 24_000, 0, 1_000);
    expect(r?.lagHops).toBe(lag);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  });

  it("pyramidSearchRefinesCompetingCoarsePeaks", () => {
    const target = signal(512, 73n);
    const coarseAlias = new Float32Array(target.length);
    for (let i = 0; i < target.length; i += 2) {
      const pair = target.slice(i, Math.min(i + 2, target.length)).reverse();
      coarseAlias.set(pair, i);
    }
    const reference = new Float32Array(6_000);
    reference.set(coarseAlias, 800);
    reference.set(target, 5_000);
    const r = correlate(reference, target, 5_500, 0, 256);
    expect(r?.lagHops).toBe(5_000);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  });

  it("consensusFitsClockDriftAcrossLongRecordings", async () => {
    const drift = 0.0003;
    const noise = signal(121_000, 5n);
    const reference = new Float32Array(noise.length);
    let running = 0;
    for (let i = 0; i < noise.length; i++) {
      running += (noise[i] - running) * 0.05;
      reference[i] = running;
    }
    const smooth = (x: number): number => {
      const i = Math.trunc(x);
      if (i + 1 >= reference.length) return reference[Math.min(i, reference.length - 1)];
      const frac = x - i;
      return reference[i] * (1 - frac) + reference[i + 1] * frac;
    };
    const head = 400;
    const target = Float32Array.from({ length: 110_000 }, (_, i) => smooth(head + i * (1 + drift)));
    const r = await seededCorrelate({
      reference, target, seedHops: undefined, seedWindowHops: 10, maxLagHops: 120_000, minOverlapHops: 1_200, minConfidence: 0.5,
    });
    expect(r).not.toBeNull();
    expect(Math.abs((r?.lagHops ?? 0) - head)).toBeLessThanOrEqual(8);
    expect(Math.abs((r?.driftRatio ?? 0) - drift)).toBeLessThan(0.00005);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.8);
  }, 120_000);

  it("consensusReportsZeroDriftForCleanCopies", async () => {
    const reference = signal(120_000, 9n);
    const target = slice(reference, 500, 110_500);
    const r = await seededCorrelate({
      reference, target, seedHops: undefined, seedWindowHops: 10, maxLagHops: 120_000, minOverlapHops: 1_200, minConfidence: 0.5,
    });
    expect(r?.lagHops).toBe(500);
    expect(r?.driftRatio).toBe(0);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.99);
  }, 120_000);
});

describe("AudioSyncCorrelator (synthetic robustness)", () => {
  it("findsKnownOffsetThroughAdditiveNoise", () => {
    const base = signal(3_000, 11n);
    const noise = signal(3_000, 12n);
    const lag = 123;
    const target = slice(base, lag, lag + 2_000).map((v, i) => v + 0.3 * (noise[i] - 0.5));
    const r = correlate(base, target, 400, 0, 300);
    expect(r?.lagHops).toBe(lag);
    expect(r?.confidence ?? 0).toBeGreaterThan(0.8);
  });

  it("invertedPolarityNeverReportsAConfidentMatch", () => {
    const base = signal(1_000, 21n);
    const inverted = slice(base, 40).map((v) => 1 - v);
    const r = correlate(base, inverted, 100);
    expect(r?.confidence ?? 0).toBeLessThan(0.5);
  });

  it("driftBeyondPhysicalLimitIsNotReportedAsDrift", async () => {
    const reference = signal(121_000, 31n);
    const smoothed = new Float32Array(reference.length);
    let running = 0;
    for (let i = 0; i < reference.length; i++) {
      running += (reference[i] - running) * 0.05;
      smoothed[i] = running;
    }
    const drift = 0.002;
    const at = (x: number): number => {
      const i = Math.trunc(x);
      if (i + 1 >= smoothed.length) return smoothed[Math.min(i, smoothed.length - 1)];
      return smoothed[i] * (1 - (x - i)) + smoothed[i + 1] * (x - i);
    };
    const target = Float32Array.from({ length: 100_000 }, (_, i) => at(200 + i * (1 + drift)));
    const r = await seededCorrelate({
      reference: smoothed, target, seedHops: undefined, seedWindowHops: 10, maxLagHops: 120_000, minOverlapHops: 1_200, minConfidence: 0.3,
    });
    expect(Math.abs(r?.driftRatio ?? 0)).toBeLessThanOrEqual(0.0005);
  }, 120_000);
});
