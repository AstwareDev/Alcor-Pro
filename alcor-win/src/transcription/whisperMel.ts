// Whisper log-mel frontend (openai/whisper audio.py): 16 kHz mono, 30 s window, n_fft 400, hop 160, 80 slaney mel bands.
import { Fft } from "../denoise/dfnDsp";

export const whisperSampleRate = 16000;
export const whisperWindowSamples = 30 * whisperSampleRate;
export const whisperMelFrames = 3000;
export const whisperMelBands = 80;

const nFft = 400;
const hop = 160;
const nFreq = nFft / 2 + 1;

// Slaney mel scale (librosa htk=False): linear below 1 kHz, logarithmic above.
const fSp = 200 / 3;
const minLogHz = 1000;
const minLogMel = minLogHz / fSp;
const logStep = Math.log(6.4) / 27;

const hzToMel = (hz: number): number => (hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logStep : hz / fSp);
const melToHz = (mel: number): number => (mel >= minLogMel ? minLogHz * Math.exp(logStep * (mel - minLogMel)) : mel * fSp);

interface MelFilter {
  first: number;
  weights: Float32Array;
}

/** librosa.filters.mel(sr, n_fft, n_mels, norm="slaney"), stored as one short run of weights per band. */
export function melFilters(bands = whisperMelBands): MelFilter[] {
  const lo = hzToMel(0);
  const hi = hzToMel(whisperSampleRate / 2);
  const points = new Float64Array(bands + 2);
  for (let i = 0; i < points.length; i++) points[i] = melToHz(lo + ((hi - lo) * i) / (bands + 1));
  const filters: MelFilter[] = [];
  for (let m = 0; m < bands; m++) {
    const left = points[m] as number;
    const centre = points[m + 1] as number;
    const right = points[m + 2] as number;
    const norm = 2 / (right - left);
    const w: number[] = [];
    let first = -1;
    for (let k = 0; k < nFreq; k++) {
      const f = (k * whisperSampleRate) / nFft;
      const v = Math.max(0, Math.min((f - left) / (centre - left), (right - f) / (right - centre))) * norm;
      if (v > 0) {
        if (first < 0) first = k;
        w.push(v);
      } else if (first >= 0) break;
    }
    filters.push({ first: Math.max(first, 0), weights: Float32Array.from(w) });
  }
  return filters;
}

export class WhisperMel {
  private readonly fft = new Fft(nFft);
  private readonly filters = melFilters();
  private readonly window = new Float64Array(nFft);
  private readonly frame = new Float64Array(nFft);
  private readonly zero = new Float64Array(nFft);
  private readonly re = new Float64Array(nFft);
  private readonly im = new Float64Array(nFft);
  private readonly power = new Float64Array(nFreq);

  constructor() {
    for (let i = 0; i < nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft); // periodic Hann
  }

  /** `samples` (at most 30 s) are zero padded to 30 s. Returns [80 bands][3000 frames], row-major. */
  compute(samples: Float32Array): Float32Array {
    const n = whisperWindowSamples;
    const len = Math.min(samples.length, n);
    const at = (p: number): number => {
      // torch.stft(center=True) reflect padding
      let i = p < 0 ? -p : p >= n ? 2 * (n - 1) - p : p;
      if (i < 0) i = 0;
      return i < len ? (samples[i] as number) : 0;
    };
    const out = new Float32Array(whisperMelBands * whisperMelFrames);
    let max = -Infinity;
    for (let t = 0; t < whisperMelFrames; t++) {
      const start = t * hop - nFft / 2;
      for (let i = 0; i < nFft; i++) this.frame[i] = at(start + i) * (this.window[i] as number);
      this.fft.forward(this.frame, this.zero, this.re, this.im);
      for (let k = 0; k < nFreq; k++) this.power[k] = (this.re[k] as number) ** 2 + (this.im[k] as number) ** 2;
      for (let m = 0; m < whisperMelBands; m++) {
        const { first, weights } = this.filters[m] as MelFilter;
        let acc = 0;
        for (let j = 0; j < weights.length; j++) acc += (weights[j] as number) * (this.power[first + j] as number);
        const v = Math.log10(Math.max(acc, 1e-10));
        out[m * whisperMelFrames + t] = v;
        if (v > max) max = v;
      }
    }
    const floor = max - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i] as number, floor) + 4) / 4;
    return out;
  }
}
