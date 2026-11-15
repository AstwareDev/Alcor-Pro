// DeepFilterNet3 signal processing (port of the libDF pieces the ONNX graphs do not contain): vorbis-window STFT at
// 48 kHz / 960 / hop 480, ERB band features with exponential mean normalisation, unit-normalised complex features,
// ERB-gain masking and deep filtering. Reference: Rikorose/DeepFilterNet libDF/src/lib.rs and tract.rs.

export const dfnSampleRate = 48000;
export const dfnFftSize = 960;
export const dfnHop = 480;
export const dfnFreqs = dfnFftSize / 2 + 1;
export const dfnNbErb = 32;
export const dfnNbDf = 96;
export const dfnDfOrder = 5;
export const dfnDfLookahead = 2;
const minNbErbFreqs = 2;
const meanNormInit: [number, number] = [-60, -90];
const unitNormInit: [number, number] = [0.001, 0.0001];
/** `calc_norm_alpha(48000, 480, tau = 1)`. */
export const dfnNormAlpha = 0.99;

const freq2erb = (hz: number): number => 9.265 * Math.log1p(hz / (24.7 * 9.265));
const erb2freq = (erb: number): number => 24.7 * 9.265 * (Math.exp(erb / 9.265) - 1);

/** `erb_fb`: number of FFT bins in each ERB band. */
export function erbBandSizes(sr = dfnSampleRate, fftSize = dfnFftSize, nbBands = dfnNbErb, minFreqs = minNbErbFreqs): number[] {
  const nyq = sr / 2;
  const freqWidth = sr / fftSize;
  const erbLow = freq2erb(0);
  const erbHigh = freq2erb(nyq);
  const erb = new Array<number>(nbBands).fill(0);
  const step = (erbHigh - erbLow) / nbBands;
  let prevFreq = 0;
  let freqOver = 0;
  for (let i = 1; i <= nbBands; i++) {
    const f = erb2freq(erbLow + i * step);
    const fb = Math.round(f / freqWidth);
    let nbFreqs = fb - prevFreq - freqOver;
    if (nbFreqs < minFreqs) {
      freqOver = minFreqs - nbFreqs;
      nbFreqs = minFreqs;
    } else freqOver = 0;
    erb[i - 1] = nbFreqs;
    prevFreq = fb;
  }
  erb[nbBands - 1] = (erb[nbBands - 1] as number) + 1;
  const tooLarge = erb.reduce((a, b) => a + b, 0) - (fftSize / 2 + 1);
  if (tooLarge > 0) erb[nbBands - 1] = (erb[nbBands - 1] as number) - tooLarge;
  return erb;
}

export const erbSizes = erbBandSizes();

/** Vorbis power-complementary window: sin(pi/2 * sin^2(pi (n + 0.5) / N)). */
export function vorbisWindow(n = dfnFftSize): Float32Array {
  const w = new Float32Array(n);
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    const s = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
    w[i] = Math.sin(0.5 * Math.PI * s * s);
  }
  return w;
}

// MARK: - Mixed-radix complex FFT (n = 960 = 2^6 * 3 * 5)

function factorize(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (const p of [4, 2, 3, 5]) {
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  }
  for (let p = 7; m > 1; p += 2) {
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  }
  return out;
}

export class Fft {
  private readonly factors: number[];
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly tRe: Float64Array;
  private readonly tIm: Float64Array;
  private readonly xRe: Float64Array;
  private readonly xIm: Float64Array;

  constructor(readonly n: number) {
    this.factors = factorize(n);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.tRe = new Float64Array(n);
    this.tIm = new Float64Array(n);
    this.xRe = new Float64Array(8);
    this.xIm = new Float64Array(8);
  }

  /** Forward transform of (inRe, inIm); the result is written to (outRe, outIm). Inputs are not modified. */
  forward(inRe: ArrayLike<number>, inIm: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    this.rec(inRe, inIm, 0, 1, this.n, outRe, outIm, 0, 0);
  }

  private rec(
    inRe: ArrayLike<number>,
    inIm: ArrayLike<number>,
    inOff: number,
    stride: number,
    n: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outOff: number,
    level: number,
  ): void {
    if (n === 1) {
      outRe[outOff] = inRe[inOff] as number;
      outIm[outOff] = inIm[inOff] as number;
      return;
    }
    const p = this.factors[level] as number;
    const m = n / p;
    for (let k = 0; k < p; k++) this.rec(inRe, inIm, inOff + k * stride, stride * p, m, outRe, outIm, outOff + k * m, level + 1);
    const tw = this.n / n;
    const yRe = this.xRe.length >= p ? this.xRe : new Float64Array(p);
    const yIm = this.xIm.length >= p ? this.xIm : new Float64Array(p);
    for (let q = 0; q < m; q++) {
      for (let k = 0; k < p; k++) {
        const idx = outOff + k * m + q;
        // twiddle W_n^(k*q)
        const t = ((k * q * tw) % this.n);
        const c = this.cos[t] as number;
        const s = this.sin[t] as number;
        const re = outRe[idx] as number;
        const im = outIm[idx] as number;
        yRe[k] = re * c - im * s;
        yIm[k] = re * s + im * c;
      }
      for (let r = 0; r < p; r++) {
        let sr = 0;
        let si = 0;
        for (let k = 0; k < p; k++) {
          const t = ((k * r * m * tw) % this.n); // W_p^(k r) = W_n^(k r m)
          const c = this.cos[t] as number;
          const s = this.sin[t] as number;
          sr += (yRe[k] as number) * c - (yIm[k] as number) * s;
          si += (yRe[k] as number) * s + (yIm[k] as number) * c;
        }
        this.tRe[q + r * m] = sr;
        this.tIm[q + r * m] = si;
      }
      // tRe/tIm hold column q for all r; write back after the column is complete.
      for (let r = 0; r < p; r++) {
        outRe[outOff + q + r * m] = this.tRe[q + r * m] as number;
        outIm[outOff + q + r * m] = this.tIm[q + r * m] as number;
      }
    }
  }
}

/** Real <-> half-spectrum transforms of one 960-sample frame, with the libDF scaling (analysis only is normalised). */
export class RealFft {
  private readonly fft = new Fft(dfnFftSize);
  private readonly zero = new Float64Array(dfnFftSize);
  private readonly re = new Float64Array(dfnFftSize);
  private readonly im = new Float64Array(dfnFftSize);
  private readonly bufRe = new Float64Array(dfnFftSize);
  private readonly bufIm = new Float64Array(dfnFftSize);

  /** Unnormalised forward FFT of real `frame`; writes bins 0..480 to (outRe, outIm). */
  forward(frame: ArrayLike<number>, outRe: Float32Array, outIm: Float32Array, scale: number): void {
    this.fft.forward(frame, this.zero, this.re, this.im);
    for (let k = 0; k < dfnFreqs; k++) {
      outRe[k] = (this.re[k] as number) * scale;
      outIm[k] = (this.im[k] as number) * scale;
    }
  }

  /** Unnormalised inverse FFT of the half spectrum (like realfft's inverse: no 1/N). */
  inverse(re: ArrayLike<number>, im: ArrayLike<number>, out: Float32Array): void {
    const n = dfnFftSize;
    // Hermitian extension, conjugated so the forward transform computes the inverse.
    for (let k = 0; k < dfnFreqs; k++) {
      this.bufRe[k] = re[k] as number;
      this.bufIm[k] = -(k === 0 || k === n / 2 ? 0 : (im[k] as number));
    }
    for (let k = dfnFreqs; k < n; k++) {
      this.bufRe[k] = re[n - k] as number;
      this.bufIm[k] = im[n - k] as number;
    }
    this.fft.forward(this.bufRe, this.bufIm, this.re, this.im);
    for (let i = 0; i < n; i++) out[i] = this.re[i] as number;
  }
}

// MARK: - STFT

export const dfnWnorm = 1 / ((dfnFftSize * dfnFftSize) / (2 * dfnHop));

export class Stft {
  private readonly window = vorbisWindow();
  private readonly rfft = new RealFft();
  private readonly frame = new Float64Array(dfnFftSize);
  private readonly time = new Float32Array(dfnFftSize);
  private synthMem = new Float32Array(dfnFftSize - dfnHop);

  /** Frame `k` of `signal`: window over samples [(k - 1) * hop, (k + 1) * hop), silence outside the signal. */
  analysis(signal: Float32Array, k: number, outRe: Float32Array, outIm: Float32Array): void {
    const start = (k - 1) * dfnHop;
    for (let i = 0; i < dfnFftSize; i++) {
      const j = start + i;
      this.frame[i] = j >= 0 && j < signal.length ? (signal[j] as number) * (this.window[i] as number) : 0;
    }
    this.rfft.forward(this.frame, outRe, outIm, dfnWnorm);
  }

  /** Inverse + window + overlap-add: returns the next `hop` output samples. Frames must be fed in order. */
  synthesis(re: ArrayLike<number>, im: ArrayLike<number>, out: Float32Array): void {
    this.rfft.inverse(re, im, this.time);
    for (let i = 0; i < dfnFftSize; i++) this.time[i] = (this.time[i] as number) * (this.window[i] as number);
    for (let i = 0; i < dfnHop; i++) out[i] = (this.time[i] as number) + (this.synthMem[i] as number);
    const mem = this.synthMem;
    const split = mem.length - dfnHop; // 0 for hop = fft/2
    if (split > 0) mem.copyWithin(0, dfnHop);
    for (let i = 0; i < split; i++) mem[i] = (mem[i] as number) + (this.time[dfnHop + i] as number);
    for (let i = split; i < mem.length; i++) mem[i] = this.time[dfnHop + i] as number;
  }
}

// MARK: - Features

export interface FrameFeatures {
  /** [32] */
  erb: Float32Array;
  /** [96] each, unit-normalised complex features of the first nb_df bins */
  specRe: Float32Array;
  specIm: Float32Array;
}

/** Stateful `feat_erb` + `feat_cplx` (exponential normalisation along time). */
export class FeatureExtractor {
  private readonly meanState = new Float32Array(dfnNbErb);
  private readonly unitState = new Float32Array(dfnNbDf);

  constructor() {
    for (let i = 0; i < dfnNbErb; i++) this.meanState[i] = meanNormInit[0] + (i * (meanNormInit[1] - meanNormInit[0])) / (dfnNbErb - 1);
    for (let i = 0; i < dfnNbDf; i++) this.unitState[i] = unitNormInit[0] + (i * (unitNormInit[1] - unitNormInit[0])) / (dfnNbDf - 1);
  }

  step(re: Float32Array, im: Float32Array, out: FrameFeatures): void {
    let at = 0;
    for (let b = 0; b < dfnNbErb; b++) {
      const size = erbSizes[b] as number;
      const k = 1 / size;
      let e = 0;
      for (let j = 0; j < size; j++) e += ((re[at + j] as number) ** 2 + (im[at + j] as number) ** 2) * k;
      at += size;
      const db = Math.log10(e + 1e-10) * 10;
      const s = db * (1 - dfnNormAlpha) + (this.meanState[b] as number) * dfnNormAlpha;
      this.meanState[b] = s;
      out.erb[b] = (db - s) / 40;
    }
    for (let f = 0; f < dfnNbDf; f++) {
      const norm = Math.hypot(re[f] as number, im[f] as number);
      const s = norm * (1 - dfnNormAlpha) + (this.unitState[f] as number) * dfnNormAlpha;
      this.unitState[f] = s;
      const d = Math.sqrt(s);
      out.specRe[f] = (re[f] as number) / d;
      out.specIm[f] = (im[f] as number) / d;
    }
  }
}

// MARK: - Enhancement of one frame

/** `apply_mask`: scales each ERB band by its gain. */
export function applyErbMask(re: Float32Array, im: Float32Array, gains: ArrayLike<number>, gainOffset: number): void {
  let at = 0;
  for (let b = 0; b < dfnNbErb; b++) {
    const g = gains[gainOffset + b] as number;
    const size = erbSizes[b] as number;
    for (let j = 0; j < size; j++) {
      re[at + j] = (re[at + j] as number) * g;
      im[at + j] = (im[at + j] as number) * g;
    }
    at += size;
  }
}

/**
 * Deep filtering: out[f] = sum_o spec[frame - (order - 1 - lookahead) + o][f] * coef[f][o] (complex) for the first
 * nb_df bins. `frames` holds the `order` noisy spectra from oldest to newest; `coefs` is [nb_df, order, 2].
 */
export function applyDeepFilter(
  framesRe: readonly Float32Array[],
  framesIm: readonly Float32Array[],
  coefs: ArrayLike<number>,
  coefOffset: number,
  outRe: Float32Array,
  outIm: Float32Array,
): void {
  for (let f = 0; f < dfnNbDf; f++) {
    let sr = 0;
    let si = 0;
    for (let o = 0; o < dfnDfOrder; o++) {
      const xr = (framesRe[o] as Float32Array)[f] as number;
      const xi = (framesIm[o] as Float32Array)[f] as number;
      const cr = coefs[coefOffset + f * dfnDfOrder * 2 + o * 2] as number;
      const ci = coefs[coefOffset + f * dfnDfOrder * 2 + o * 2 + 1] as number;
      sr += xr * cr - xi * ci;
      si += xr * ci + xi * cr;
    }
    outRe[f] = sr;
    outIm[f] = si;
  }
}
