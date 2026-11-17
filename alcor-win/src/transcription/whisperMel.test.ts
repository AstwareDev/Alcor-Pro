import { describe, expect, it } from "vitest";
import { WhisperMel, melFilters, whisperMelBands, whisperMelFrames, whisperSampleRate, whisperWindowSamples } from "./whisperMel";

function sine(freq: number, seconds: number): Float32Array {
  const x = new Float32Array(seconds * whisperSampleRate);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / whisperSampleRate);
  return x;
}

describe("melFilters", () => {
  it("hasEightyBandsOfRisingCentreFrequency", () => {
    const f = melFilters();
    expect(f).toHaveLength(whisperMelBands);
    const centre = f.map((b) => b.first + b.weights.indexOf(Math.max(...b.weights)));
    for (let i = 1; i < centre.length; i++) expect(centre[i] as number).toBeGreaterThanOrEqual(centre[i - 1] as number);
    expect(f.every((b) => b.weights.length > 0)).toBe(true);
  });

  it("scalesEachBandBySlaneyAreaNormalisation", () => {
    // Band 0 is a triangle from 0 Hz, 2 / (right - left) high; the peak weight is about 0.025 at 80 bands / 16 kHz.
    const first = melFilters()[0] as { first: number; weights: Float32Array };
    expect(first.first).toBeLessThanOrEqual(1); // the triangle rises from 0 Hz
    expect(Math.max(...first.weights)).toBeCloseTo(0.025, 2);
  });
});

describe("WhisperMel", () => {
  const mel = new WhisperMel();

  it("returnsEightyByThreeThousandValuesWithinTwoUnits", () => {
    const out = mel.compute(sine(440, 2));
    expect(out).toHaveLength(whisperMelBands * whisperMelFrames);
    let max = -Infinity;
    let min = Infinity;
    for (const v of out) {
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    expect(max - min).toBeLessThanOrEqual(2 + 1e-5); // clamped to 8 decades below the peak, then divided by 4
  });

  it("puts1kHzEnergyInTheBandThatContainsIt", () => {
    const out = mel.compute(sine(1000, 3));
    const frame = 100;
    let best = 0;
    for (let m = 1; m < whisperMelBands; m++) if ((out[m * whisperMelFrames + frame] as number) > (out[best * whisperMelFrames + frame] as number)) best = m;
    const f = melFilters()[best] as { first: number; weights: Float32Array };
    const centreHz = ((f.first + f.weights.indexOf(Math.max(...f.weights))) * whisperSampleRate) / 400;
    expect(Math.abs(centreHz - 1000)).toBeLessThan(80);
  });

  it("isFlatForDigitalSilence", () => {
    const out = mel.compute(new Float32Array(whisperSampleRate));
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBeCloseTo(-1.5, 5); // (log10(1e-10) + 4) / 4
  });

  it("ignoresSamplesBeyondThirtySeconds", () => {
    const a = mel.compute(sine(300, 30));
    const longer = new Float32Array(whisperWindowSamples + 1000);
    longer.set(sine(300, 30));
    longer.fill(0.9, whisperWindowSamples);
    expect(mel.compute(longer)).toEqual(a);
  });
});
