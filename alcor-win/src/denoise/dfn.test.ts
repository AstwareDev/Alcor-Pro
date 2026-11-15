import { describe, expect, it } from "vitest";
import {
  Fft, FeatureExtractor, Stft, applyDeepFilter, applyErbMask, dfnDfOrder, dfnFftSize, dfnFreqs, dfnHop, dfnNbDf, dfnNbErb, dfnNormAlpha, erbBandSizes,
  erbSizes, vorbisWindow, type FrameFeatures,
} from "./dfnDsp";
import { dfnFrameCount, enhanceChannel, type DfnFrameModels } from "./dfnPipeline";

function tone(n: number, freq: number, amp = 0.5): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / 48000) + 0.1 * Math.sin((2 * Math.PI * 3 * freq * i) / 48000);
  return x;
}

/** gains = 1 and deep-filter coefficients that pass the centre tap: the graph-free identity. */
const identityModels: DfnFrameModels = {
  async run(_erb, _spec, frames) {
    const gains = new Float32Array(frames * dfnNbErb).fill(1);
    const coefs = new Float32Array(frames * dfnNbDf * dfnDfOrder * 2);
    for (let t = 0; t < frames; t++) for (let f = 0; f < dfnNbDf; f++) coefs[((t * dfnNbDf + f) * dfnDfOrder + 2) * 2] = 1;
    return { gains, coefs };
  },
};

describe("DeepFilterNet DSP", () => {
  it("fftMatchesNaiveDft", () => {
    const n = dfnFftSize;
    const fft = new Fft(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9) + (i % 7) * 0.01);
    fft.forward(x, new Float64Array(n), re, im);
    for (const k of [0, 1, 17, 480, 481, 959]) {
      let sr = 0;
      let si = 0;
      for (let j = 0; j < n; j++) {
        sr += (x[j] as number) * Math.cos((2 * Math.PI * k * j) / n);
        si -= (x[j] as number) * Math.sin((2 * Math.PI * k * j) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 6);
      expect(im[k]).toBeCloseTo(si, 6);
    }
  });

  it("erbBandsPartitionAllBins", () => {
    expect(erbSizes).toHaveLength(32);
    expect(erbSizes.reduce((a, b) => a + b, 0)).toBe(dfnFreqs);
    expect(Math.min(...erbSizes)).toBeGreaterThanOrEqual(2);
    expect(erbBandSizes()).toEqual(erbSizes);
  });

  it("vorbisWindowIsPowerComplementary", () => {
    const w = vorbisWindow();
    for (let i = 0; i < dfnHop; i++) expect((w[i] as number) ** 2 + (w[i + dfnHop] as number) ** 2).toBeCloseTo(1, 6);
  });

  it("stftAnalysisSynthesisReconstructsWithOneHopDelay", () => {
    const x = tone(dfnHop * 20, 440);
    const analysis = new Stft();
    const synthesis = new Stft();
    const re = new Float32Array(dfnFreqs);
    const im = new Float32Array(dfnFreqs);
    const out = new Float32Array(dfnHop);
    let worst = 0;
    for (let k = 0; k < 22; k++) {
      analysis.analysis(x, k, re, im);
      synthesis.synthesis(re, im, out);
      if (k < 1 || k > 20) continue;
      for (let i = 0; i < dfnHop; i++) worst = Math.max(worst, Math.abs((out[i] as number) - (x[(k - 1) * dfnHop + i] as number)));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it("analysisScalingMatchesLibDf", () => {
    // A full-scale-ish bin-aligned sine: |X[k]| = amp * sum(window) / 2 / 960.
    const n = dfnHop * 4;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * 10 * i) / dfnFftSize);
    const re = new Float32Array(dfnFreqs);
    const im = new Float32Array(dfnFreqs);
    new Stft().analysis(x, 2, re, im);
    const w = vorbisWindow();
    const expected = w.reduce((a, b) => a + b, 0) / 2 / 960;
    expect(Math.hypot(re[10] as number, im[10] as number)).toBeCloseTo(expected, 4);
  });

  it("featureExtractorFirstFrameMatchesTheRecurrence", () => {
    const fx = new FeatureExtractor();
    const re = new Float32Array(dfnFreqs).fill(0.01);
    const im = new Float32Array(dfnFreqs);
    const out: FrameFeatures = { erb: new Float32Array(32), specRe: new Float32Array(96), specIm: new Float32Array(96) };
    fx.step(re, im, out);
    const db = 10 * Math.log10(1e-4 + 1e-10);
    const state0 = db * (1 - dfnNormAlpha) + -60 * dfnNormAlpha;
    expect(out.erb[0]).toBeCloseTo((db - state0) / 40, 5);
    const unit0 = 0.01 * (1 - dfnNormAlpha) + 0.001 * dfnNormAlpha;
    expect(out.specRe[0]).toBeCloseTo(0.01 / Math.sqrt(unit0), 5);
    expect(out.specIm[0]).toBe(0);
  });

  it("erbMaskScalesEachBandByItsGain", () => {
    const re = new Float32Array(dfnFreqs).fill(1);
    const im = new Float32Array(dfnFreqs).fill(2);
    const gains = Float32Array.from({ length: 32 }, (_, i) => i + 1);
    applyErbMask(re, im, gains, 0);
    expect(re[0]).toBe(1);
    expect(im[0]).toBe(2);
    expect(re[dfnFreqs - 1]).toBe(32);
    expect(im[dfnFreqs - 1]).toBe(64);
  });

  it("deepFilterIsAComplexTapSumOverFiveFrames", () => {
    const fr = Array.from({ length: 5 }, (_, o) => new Float32Array(dfnFreqs).fill(o + 1));
    const fi = Array.from({ length: 5 }, () => new Float32Array(dfnFreqs));
    const coefs = new Float32Array(dfnNbDf * 5 * 2);
    for (let f = 0; f < dfnNbDf; f++) {
      coefs[f * 10 + 0] = 1; // tap 0: 1 + 0i
      coefs[f * 10 + 2 * 2 + 1] = 1; // tap 2: 0 + 1i
    }
    const oRe = new Float32Array(dfnNbDf);
    const oIm = new Float32Array(dfnNbDf);
    applyDeepFilter(fr, fi, coefs, 0, oRe, oIm);
    expect(oRe[0]).toBe(1);
    expect(oIm[0]).toBe(3);
  });
});

describe("enhanceChannel", () => {
  it("identityModelsReproduceTheInputAcrossBlocks", async () => {
    const x = tone(48000 * 1.3 + 123, 523);
    const y = await enhanceChannel(x, identityModels, { blockFrames: 37, warmupFrames: 5, lookaheadFrames: 3 });
    expect(y.length).toBe(x.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs((y[i] as number) - (x[i] as number)));
    expect(worst).toBeLessThan(1e-3);
  });

  it("zeroGainsAndCoefficientsSilenceTheOutput", async () => {
    const models: DfnFrameModels = {
      async run(_e, _s, frames) {
        return { gains: new Float32Array(frames * dfnNbErb), coefs: new Float32Array(frames * dfnNbDf * dfnDfOrder * 2) };
      },
    };
    const y = await enhanceChannel(tone(20000, 300), models);
    expect(Math.max(...Array.from(y, Math.abs))).toBeLessThan(1e-6);
  });

  it("modelsReceiveConsistentShapesAndWarmupContext", async () => {
    const calls: { frames: number; erb: number; spec: number }[] = [];
    const models: DfnFrameModels = {
      async run(erb, spec, frames) {
        calls.push({ frames, erb: erb.length, spec: spec.length });
        return identityModels.run(erb, spec, frames);
      },
    };
    const n = dfnHop * 50;
    await enhanceChannel(tone(n, 200), models, { blockFrames: 20, warmupFrames: 4, lookaheadFrames: 2 });
    const total = dfnFrameCount(n);
    expect(calls.length).toBe(Math.ceil(total / 20));
    for (const c of calls) {
      expect(c.erb).toBe(c.frames * 32);
      expect(c.spec).toBe(2 * c.frames * 96);
    }
    expect(calls[0]?.frames).toBe(22);
    expect(calls[1]?.frames).toBe(26);
  });

  it("emptyInputGivesEmptyOutput", async () => {
    expect((await enhanceChannel(new Float32Array(0), identityModels)).length).toBe(0);
  });
});
