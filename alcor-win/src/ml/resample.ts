// Streaming band-limited resampler (Kaiser-windowed sinc, phase table with linear interpolation). Output sample n sits at
// input time n * inRate / outRate with no delay; the input before the first sample is treated as silence.

const phases = 512;
const halfTaps = 16;
const kaiserBeta = 8.6;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

interface Kernel {
  /** Taps per side; the kernel spans input offsets -(half - 1) ... half around floor(position). */
  half: number;
  /** (phases + 1) rows of 2 * half taps, each row normalised to unit DC gain. */
  table: Float32Array;
}

function buildKernel(inRate: number, outRate: number): Kernel {
  const cutoff = Math.min(1, outRate / inRate);
  const half = Math.ceil(halfTaps / cutoff);
  const width = half; // kernel support in input samples
  const rows = phases + 1;
  const table = new Float32Array(rows * 2 * half);
  const i0Beta = besselI0(kaiserBeta);
  for (let p = 0; p < rows; p++) {
    const frac = p / phases;
    let sum = 0;
    const base = p * 2 * half;
    for (let j = 0; j < 2 * half; j++) {
      const t = j - (half - 1) - frac; // input offset relative to the output position
      const w = t / width;
      let v = 0;
      if (Math.abs(w) < 1) {
        const x = Math.PI * cutoff * t;
        const sinc = t === 0 ? 1 : Math.sin(x) / x;
        v = cutoff * sinc * (besselI0(kaiserBeta * Math.sqrt(1 - w * w)) / i0Beta);
      }
      table[base + j] = v;
      sum += v;
    }
    if (sum !== 0) for (let j = 0; j < 2 * half; j++) table[base + j] = (table[base + j] as number) / sum;
  }
  return { half, table };
}

export class StreamResampler {
  private readonly step: number;
  private readonly kernel: Kernel;
  private buffer = new Float32Array(0);
  /** Absolute input index of buffer[0]. */
  private origin = 0;
  /** Absolute input position of the next output sample. */
  private position = 0;
  private totalIn = 0;
  private emitted = 0;

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.step = inRate / outRate;
    this.kernel = buildKernel(inRate, outRate);
  }

  private process(limit: number): Float32Array {
    const { half, table } = this.kernel;
    const out: number[] = [];
    const taps = 2 * half;
    const bufEnd = this.origin + this.buffer.length;
    while (this.emitted < limit) {
      const i0 = Math.floor(this.position);
      if (i0 + half >= bufEnd) break;
      const frac = this.position - i0;
      const pf = frac * phases;
      const p = Math.min(phases - 1, Math.floor(pf));
      const mix = pf - p;
      const rowA = p * taps;
      const rowB = rowA + taps;
      let acc = 0;
      const first = i0 - (half - 1);
      for (let j = 0; j < taps; j++) {
        const idx = first + j - this.origin;
        if (idx < 0 || idx >= this.buffer.length) continue;
        const a = table[rowA + j] as number;
        const b = table[rowB + j] as number;
        acc += (this.buffer[idx] as number) * (a + (b - a) * mix);
      }
      out.push(acc);
      this.emitted += 1;
      this.position = this.emitted * this.step;
    }
    const keepFrom = Math.max(this.origin, Math.floor(this.position) - (half - 1));
    if (keepFrom > this.origin) {
      this.buffer = this.buffer.slice(keepFrom - this.origin);
      this.origin = keepFrom;
    }
    return Float32Array.from(out);
  }

  push(samples: Float32Array): Float32Array {
    const joined = new Float32Array(this.buffer.length + samples.length);
    joined.set(this.buffer);
    joined.set(samples, this.buffer.length);
    this.buffer = joined;
    this.totalIn += samples.length;
    return this.process(Number.POSITIVE_INFINITY);
  }

  /** Emits the remaining outputs (those whose time lies inside the input), padding the tail with silence. */
  flush(): Float32Array {
    const target = Math.round(this.totalIn / this.step);
    const pad = new Float32Array(this.kernel.half + 1);
    const joined = new Float32Array(this.buffer.length + pad.length);
    joined.set(this.buffer);
    this.buffer = joined;
    return this.process(target);
  }
}

/** One-shot convenience: whole signal in, whole signal out. */
export function resample(samples: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return samples;
  const r = new StreamResampler(inRate, outRate);
  const a = r.push(samples);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
