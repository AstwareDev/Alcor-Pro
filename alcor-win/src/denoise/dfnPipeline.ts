// Offline DeepFilterNet3 enhancement of one 48 kHz channel. The three ONNX graphs sit behind `DfnFrameModels` so the
// framing, normalisation, masking, deep filtering and overlap-add are testable without a model. Long signals run in
// blocks: warm-up frames before each block rebuild the GRU state, look-ahead frames cover the convolution/DF context.
import {
  Stft, FeatureExtractor, applyDeepFilter, applyErbMask, dfnDfLookahead, dfnDfOrder, dfnFreqs, dfnHop, dfnNbDf, dfnNbErb,
  type FrameFeatures,
} from "./dfnDsp";

export interface DfnFrameOutputs {
  /** [frames, 32] ERB gains */
  gains: Float32Array;
  /** [frames, 96, 5, 2] deep-filter coefficients */
  coefs: Float32Array;
}

export interface DfnFrameModels {
  /** featErb: [frames, 32]; featSpec: [2, frames, 96] (re plane then im plane). */
  run(featErb: Float32Array, featSpec: Float32Array, frames: number): Promise<DfnFrameOutputs>;
}

export interface EnhanceOptions {
  blockFrames?: number;
  warmupFrames?: number;
  lookaheadFrames?: number;
  onProgress?: (fraction: number) => void;
}

export const dfnBlockFrames = 1000;
export const dfnWarmupFrames = 100;
export const dfnLookaheadFrames = 8;

/** Number of STFT frames for `length` samples: the signal plus one window of tail so the last hop is fully synthesised. */
export function dfnFrameCount(length: number): number {
  return Math.ceil((length + 2 * dfnHop) / dfnHop);
}

export async function enhanceChannel(signal: Float32Array, models: DfnFrameModels, options: EnhanceOptions = {}): Promise<Float32Array> {
  const block = options.blockFrames ?? dfnBlockFrames;
  const warmup = options.warmupFrames ?? dfnWarmupFrames;
  const lookahead = options.lookaheadFrames ?? dfnLookaheadFrames;
  const n = signal.length;
  if (n === 0) return new Float32Array(0);
  const frames = dfnFrameCount(n);

  // Pass 1: normalised features for every frame (stateful along time).
  const featErb = new Float32Array(frames * dfnNbErb);
  const featRe = new Float32Array(frames * dfnNbDf);
  const featIm = new Float32Array(frames * dfnNbDf);
  {
    const stft = new Stft();
    const extractor = new FeatureExtractor();
    const re = new Float32Array(dfnFreqs);
    const im = new Float32Array(dfnFreqs);
    const out: FrameFeatures = { erb: new Float32Array(dfnNbErb), specRe: new Float32Array(dfnNbDf), specIm: new Float32Array(dfnNbDf) };
    for (let k = 0; k < frames; k++) {
      stft.analysis(signal, k, re, im);
      extractor.step(re, im, out);
      featErb.set(out.erb, k * dfnNbErb);
      featRe.set(out.specRe, k * dfnNbDf);
      featIm.set(out.specIm, k * dfnNbDf);
    }
  }

  // Pass 2: model gains/coefficients per block, then mask + deep filter + synthesis in frame order.
  const analysis = new Stft();
  const synthesis = new Stft();
  const ctx = dfnDfOrder - 1 - dfnDfLookahead; // frames of past context needed by deep filtering
  const outSignal = new Float32Array(frames * dfnHop);
  const hopOut = new Float32Array(dfnHop);
  const zeroSpec = new Float32Array(dfnFreqs);
  const encRe = new Float32Array(dfnFreqs);
  const encIm = new Float32Array(dfnFreqs);

  for (let b0 = 0; b0 < frames; b0 += block) {
    const b1 = Math.min(frames, b0 + block);
    const s0 = Math.max(0, b0 - warmup);
    const s1 = Math.min(frames, b1 + lookahead);
    const len = s1 - s0;
    const erbSlice = featErb.slice(s0 * dfnNbErb, s1 * dfnNbErb);
    const specSlice = new Float32Array(2 * len * dfnNbDf);
    specSlice.set(featRe.subarray(s0 * dfnNbDf, s1 * dfnNbDf), 0);
    specSlice.set(featIm.subarray(s0 * dfnNbDf, s1 * dfnNbDf), len * dfnNbDf);
    const { gains, coefs } = await models.run(erbSlice, specSlice, len);

    // Noisy spectra for frames [b0 - ctx, b1 + lookahead'), computed on demand.
    const lo = b0 - dfnDfOrder;
    const hi = b1 + dfnDfOrder;
    const spectraRe: Float32Array[] = [];
    const spectraIm: Float32Array[] = [];
    for (let k = lo; k < hi; k++) {
      if (k < 0 || k >= frames) {
        spectraRe.push(zeroSpec);
        spectraIm.push(zeroSpec);
        continue;
      }
      const re = new Float32Array(dfnFreqs);
      const im = new Float32Array(dfnFreqs);
      analysis.analysis(signal, k, re, im);
      spectraRe.push(re);
      spectraIm.push(im);
    }
    const noisy = (k: number): [Float32Array, Float32Array] => [spectraRe[k - lo] as Float32Array, spectraIm[k - lo] as Float32Array];

    for (let t = b0; t < b1; t++) {
      const [nre, nim] = noisy(t);
      encRe.set(nre);
      encIm.set(nim);
      applyErbMask(encRe, encIm, gains, (t - s0) * dfnNbErb);
      const fr: Float32Array[] = [];
      const fi: Float32Array[] = [];
      for (let o = 0; o < dfnDfOrder; o++) {
        const [r, i] = noisy(t - ctx + o);
        fr.push(r);
        fi.push(i);
      }
      const dfRe = new Float32Array(dfnNbDf);
      const dfIm = new Float32Array(dfnNbDf);
      applyDeepFilter(fr, fi, coefs, (t - s0) * dfnNbDf * dfnDfOrder * 2, dfRe, dfIm);
      encRe.set(dfRe);
      encIm.set(dfIm);
      synthesis.synthesis(encRe, encIm, hopOut);
      outSignal.set(hopOut, t * dfnHop);
    }
    options.onProgress?.(b1 / frames);
  }
  // Synthesis frame k holds the samples of hop k - 1 (one hop of STFT delay).
  return outSignal.slice(dfnHop, dfnHop + n);
}
