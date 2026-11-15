import { describe, expect, it } from "vitest";
import {
  audioEnvelopeDuration, envelopeLogEnergy, makeEnvelopeAccumulator, makeLinearResampler, makePeakAccumulator,
  mixToMono, normalizedPeak, peakEnvelopeRate, peakHopSize, resamplePeaksToBars, waveformBarHeight,
  waveformSampleWindow,
} from "./peaks";
import { decodePeaks, encodePeaks } from "./waveform";

describe("WaveformExtractor maths", () => {
  it("rate is 200/s, capped to 240000 samples for long spans", () => {
    expect(peakEnvelopeRate(10)).toBe(200);
    expect(peakEnvelopeRate(1200)).toBe(200);
    expect(peakEnvelopeRate(2400)).toBe(100);
    expect(peakEnvelopeRate(0)).toBe(200);
    expect(peakEnvelopeRate(Number.NaN)).toBe(200);
    expect(peakEnvelopeRate(Number.POSITIVE_INFINITY)).toBe(200);
  });

  it("hop size rounds half away from zero and is at least 1", () => {
    expect(peakHopSize(48000, 200)).toBe(240);
    expect(peakHopSize(44100, 200)).toBe(221); // 220.5
    expect(peakHopSize(100, 200)).toBe(1);
  });

  it("normalises peaks: silence 1, full scale 0, floor -50 dB", () => {
    expect(normalizedPeak(0)).toBe(1);
    expect(normalizedPeak(1)).toBeCloseTo(0, 10);
    expect(normalizedPeak(0.5)).toBeCloseTo(-20 * Math.log10(2) / -50, 10);
    expect(normalizedPeak(10 ** (-60 / 20))).toBe(1);
    expect(normalizedPeak(2)).toBeCloseTo(0, 10); // clamped above 0 dB
  });

  it("carries a partial hop across chunk boundaries", () => {
    const whole = new Float32Array(20).map((_, i) => (i === 7 ? 0.5 : i === 13 ? 0.25 : 0));
    const a = makePeakAccumulator(4); // 4 Hz at 16 Hz -> hop 4
    a.push(whole, 16);
    const b = makePeakAccumulator(4);
    b.push(whole.subarray(0, 3), 16);
    b.push(whole.subarray(3, 9), 16);
    b.push(whole.subarray(9), 16);
    const expected = a.finish();
    expect(Array.from(b.finish())).toEqual(Array.from(expected));
    expect(expected.length).toBe(5);
    expect(expected[1]).toBeCloseTo(normalizedPeak(0.5), 6);
    expect(expected[3]).toBeCloseTo(normalizedPeak(0.25), 6);
    expect(expected[0]).toBe(1);
  });

  it("emits a final partial hop and uses |x|", () => {
    const acc = makePeakAccumulator(4);
    acc.push(Float32Array.of(0, 0, 0, 0, -0.5, 0), 16);
    const out = acc.finish();
    expect(out.length).toBe(2);
    expect(out[1]).toBeCloseTo(normalizedPeak(0.5), 6);
  });

  it("mixes channels to mono by averaging", () => {
    const mono = mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
    const single = Float32Array.of(1, 2);
    expect(mixToMono([single])).toBe(single);
  });
});

describe("AudioEnvelope maths", () => {
  it("log energy of a constant signal", () => {
    expect(envelopeLogEnergy(40 * 0.25 * 0.25, 40)).toBeCloseTo(Math.log1p(25), 10);
  });

  it("40-sample hops at 16 kHz, with a final partial hop", () => {
    const acc = makeEnvelopeAccumulator();
    acc.push(new Float32Array(100).fill(0.1));
    const env = acc.finish();
    expect(env.hopSeconds).toBe(0.0025);
    expect(env.samples.length).toBe(3);
    expect(env.samples[0]).toBeCloseTo(Math.log1p(10), 5);
    expect(env.samples[2]).toBeCloseTo(Math.log1p(10), 5);
    expect(audioEnvelopeDuration(env)).toBeCloseTo(0.0075, 10);
  });

  it("linear resampler preserves a ramp across chunk boundaries", () => {
    const r = makeLinearResampler(8, 16);
    const input = Float32Array.from({ length: 8 }, (_, i) => i);
    const out = [...r.push(input.subarray(0, 3)), ...r.push(input.subarray(3))];
    expect(out.length).toBeGreaterThanOrEqual(13);
    out.forEach((v, i) => expect(v).toBeCloseTo(i / 2, 5));
  });

  it("is the identity at equal rates", () => {
    const x = Float32Array.of(1, 2, 3);
    expect(makeLinearResampler(16000, 16000).push(x)).toBe(x);
  });
});

describe("waveform drawing maths", () => {
  it("maps the visible source range to sample indices", () => {
    expect(waveformSampleWindow(1000, 300, 0, 300)).toEqual({ sampleStart: 0, sampleEnd: 1000 });
    expect(waveformSampleWindow(1000, 300, 75, 150)).toEqual({ sampleStart: 250, sampleEnd: 750 });
    expect(waveformSampleWindow(1000, 0, 0, 10)).toBeUndefined();
    expect(waveformSampleWindow(1000, 300, 400, 10)).toBeUndefined();
    expect(waveformSampleWindow(1000, 300, 200, 500)).toEqual({ sampleStart: 666, sampleEnd: 1000 });
  });

  it("takes the loudest (minimum) sample per bar, with integer division bounds", () => {
    const samples = Float32Array.of(1, 0.9, 0.2, 1, 1, 0.5, 1, 1, 0.7, 1);
    const bars = resamplePeaksToBars(samples, { sampleStart: 0, sampleEnd: 10 }, 5);
    expect(Array.from(bars)).toEqual([0.8999999761581421, 0.20000000298023224, 0.5, 1, 0.699999988079071]);
  });

  it("handles more bars than samples (each bar reads at least one sample)", () => {
    const bars = resamplePeaksToBars(Float32Array.of(0.25, 0.75), { sampleStart: 0, sampleEnd: 2 }, 4);
    expect(Array.from(bars)).toEqual([0.25, 0.25, 0.75, 0.75]);
  });

  it("returns only the requested bar range", () => {
    const samples = Float32Array.from({ length: 8 }, (_, i) => i / 10);
    const bars = resamplePeaksToBars(samples, { sampleStart: 0, sampleEnd: 8 }, 4, 1, 3);
    expect(bars.length).toBe(2);
    expect(bars[0]).toBeCloseTo(0.2, 6);
    expect(bars[1]).toBeCloseTo(0.4, 6);
  });

  it("bar height is dB-shifted, clamped, at least 1px", () => {
    expect(waveformBarHeight(0, 0, 42)).toBe(40);
    expect(waveformBarHeight(1, 0, 42)).toBe(1);
    expect(waveformBarHeight(0.5, 0.2, 42)).toBeCloseTo(0.7 * 40, 10);
    expect(waveformBarHeight(0.9, 5, 42)).toBe(40);
    expect(waveformBarHeight(0.5, -2, 42)).toBe(1);
  });
});

describe("peak cache encoding", () => {
  it("round-trips float32 and rejects empty or truncated data", () => {
    const peaks = Float32Array.of(0, 0.5, 1);
    const decoded = decodePeaks(encodePeaks(peaks));
    expect(Array.from(decoded ?? [])).toEqual([0, 0.5, 1]);
    expect(decodePeaks(new Uint8Array(0))).toBeUndefined();
    expect(decodePeaks(new Uint8Array(7))).toBeUndefined();
  });
});
