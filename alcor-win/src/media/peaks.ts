import { swiftRound } from "../util/math";

/* Pure maths of WaveformExtractor, AudioEnvelopeExtractor and ClipRenderer.drawWaveform. */

export const waveformSamplesPerSecond = 200;
export const waveformNoiseFloorDb = -50;
export const waveformMaxSamples = 240_000;

export const envelopeSampleRate = 16_000;
export const envelopeHopSeconds = 0.0025;

/** Peak-envelope sampling rate for a span (seconds): capped so a long file never exceeds `waveformMaxSamples`. */
export function peakEnvelopeRate(span: number): number {
  return Number.isFinite(span) && span > 0
    ? Math.min(waveformSamplesPerSecond, waveformMaxSamples / span)
    : waveformSamplesPerSecond;
}

export function peakHopSize(sampleRate: number, rate: number): number {
  return Math.max(1, swiftRound(sampleRate / rate));
}

/** 0 = loud (0 dBFS), 1 = at or below the noise floor / silence. */
export function normalizedPeak(peak: number): number {
  if (!(peak > 0)) return 1;
  const db = 20 * Math.log10(peak);
  const clamped = Math.min(0, Math.max(waveformNoiseFloorDb, db));
  return clamped / waveformNoiseFloorDb;
}

export interface PeakAccumulator {
  /** Mono samples at `sampleRate`; chunks may be any length. */
  push(samples: Float32Array, sampleRate: number): void;
  finish(): Float32Array;
}

/** Streaming port of the hop loop in `peekEnvelope`: max |x| per hop, carried across chunk boundaries. */
export function makePeakAccumulator(rate: number): PeakAccumulator {
  const out: number[] = [];
  let carryPeak = 0;
  let carryCount = 0;
  let hopSize = 0;
  return {
    push(samples, sampleRate) {
      if (hopSize === 0) hopSize = peakHopSize(sampleRate, rate);
      const count = samples.length;
      let i = 0;
      while (i < count) {
        const take = Math.min(hopSize - carryCount, count - i);
        let localMax = 0;
        for (let j = i; j < i + take; j++) {
          const v = Math.abs(samples[j]);
          if (v > localMax) localMax = v;
        }
        if (localMax > carryPeak) carryPeak = localMax;
        carryCount += take;
        i += take;
        if (carryCount === hopSize) {
          out.push(normalizedPeak(carryPeak));
          carryPeak = 0;
          carryCount = 0;
        }
      }
    },
    finish() {
      if (carryCount > 0) {
        out.push(normalizedPeak(carryPeak));
        carryPeak = 0;
        carryCount = 0;
      }
      return Float32Array.from(out);
    },
  };
}

export interface AudioEnvelope {
  hopSeconds: number;
  samples: Float32Array;
}

export function audioEnvelopeDuration(e: AudioEnvelope): number {
  return e.samples.length * e.hopSeconds;
}

export function envelopeLogEnergy(sumSquares: number, count: number): number {
  return Math.log1p(Math.sqrt(sumSquares / count) * 100);
}

export interface EnvelopeAccumulator {
  /** Mono samples already at `envelopeSampleRate`. */
  push(samples: Float32Array): void;
  finish(): AudioEnvelope;
}

export function makeEnvelopeAccumulator(): EnvelopeAccumulator {
  const hopSize = Math.max(1, swiftRound(envelopeSampleRate * envelopeHopSeconds));
  const out: number[] = [];
  let sumSquares = 0;
  let carry = 0;
  return {
    push(samples) {
      const count = samples.length;
      let i = 0;
      while (i < count) {
        const take = Math.min(hopSize - carry, count - i);
        let partial = 0;
        for (let j = i; j < i + take; j++) partial += samples[j] * samples[j];
        sumSquares += partial;
        carry += take;
        i += take;
        if (carry === hopSize) {
          out.push(envelopeLogEnergy(sumSquares, hopSize));
          sumSquares = 0;
          carry = 0;
        }
      }
    },
    finish() {
      if (carry > 0) {
        out.push(envelopeLogEnergy(sumSquares, carry));
        carry = 0;
      }
      return { hopSeconds: envelopeHopSeconds, samples: Float32Array.from(out) };
    },
  };
}

export interface LinearResampler {
  push(input: Float32Array): Float32Array;
}

/** Streaming linear-interpolation resampler (stand-in for AVFoundation's sample-rate conversion in the envelope reader). */
export function makeLinearResampler(fromRate: number, toRate: number): LinearResampler {
  if (fromRate === toRate) return { push: (input) => input };
  const step = fromRate / toRate;
  let position = 0; // position of the next output sample, in input-sample units relative to `tail[0]`
  let tail = new Float32Array(0);
  return {
    push(input) {
      const buf = new Float32Array(tail.length + input.length);
      buf.set(tail, 0);
      buf.set(input, tail.length);
      const out: number[] = [];
      while (position + 1 < buf.length) {
        const i = Math.floor(position);
        const frac = position - i;
        out.push(buf[i] + (buf[i + 1] - buf[i]) * frac);
        position += step;
      }
      const consumed = Math.min(Math.floor(position), buf.length);
      tail = buf.slice(consumed);
      position -= consumed;
      return Float32Array.from(out);
    },
  };
}

export interface WaveformWindow {
  sampleStart: number;
  sampleEnd: number;
}

/** Visible portion of the source mapped to sample indices; `undefined` when nothing is visible. */
export function waveformSampleWindow(
  sampleCount: number,
  sourceDurationFrames: number,
  trimStartFrame: number,
  sourceFramesConsumed: number,
): WaveformWindow | undefined {
  if (!(sourceDurationFrames > 0)) return undefined;
  const startFrac = trimStartFrame / sourceDurationFrames;
  const endFrac = (trimStartFrame + sourceFramesConsumed) / sourceDurationFrames;
  const sampleStart = Math.max(0, Math.min(sampleCount, Math.trunc(startFrac * sampleCount)));
  const sampleEnd = Math.max(sampleStart, Math.min(sampleCount, Math.trunc(endFrac * sampleCount)));
  return sampleEnd > sampleStart ? { sampleStart, sampleEnd } : undefined;
}

/**
 * Peak-detect (min, since 0 = loud) over each bar's sample range so zero crossings don't flatten loud audio.
 * Returns values for bars `firstBar..<lastBar` (index 0 = `firstBar`).
 */
export function resamplePeaksToBars(
  samples: ArrayLike<number>,
  window: WaveformWindow,
  barCount: number,
  firstBar = 0,
  lastBar = barCount,
): Float32Array {
  const { sampleStart, sampleEnd } = window;
  const visCount = sampleEnd - sampleStart;
  const out = new Float32Array(Math.max(0, lastBar - firstBar));
  for (let i = firstBar; i < lastBar; i++) {
    const sStart = sampleStart + Math.trunc((i * visCount) / barCount);
    const sEnd = Math.max(sStart + 1, sampleStart + Math.trunc(((i + 1) * visCount) / barCount));
    let loudest = 1;
    const stop = Math.min(sEnd, sampleEnd);
    for (let j = sStart; j < stop; j++) {
      const s = samples[j];
      if (s < loudest) loudest = s;
    }
    out[i - firstBar] = loudest;
  }
  return out;
}

export const waveformDbRange = 50;

/** Bar height in pixels: samples are dB-normalised, so a volume shift moves the dB axis (not a multiplier). */
export function waveformBarHeight(loudest: number, dbShift: number, drawHeight: number): number {
  const amplitude = Math.min(1, Math.max(0, 1 - loudest + dbShift));
  return Math.max(1, amplitude * (drawHeight - 2));
}

/** Channel average, the mono downmix the Swift reader asks AVFoundation for (1 output channel). */
export function mixToMono(planes: readonly Float32Array[]): Float32Array {
  if (planes.length === 1) return planes[0];
  const length = planes[0]?.length ?? 0;
  const out = new Float32Array(length);
  const scale = 1 / planes.length;
  for (const plane of planes) for (let i = 0; i < length; i++) out[i] += plane[i] * scale;
  return out;
}
