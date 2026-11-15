
// Port of Compositing/ColorScopes.swift (measurement) plus the readout/gap helpers of ToolExecutor+Color.swift.
// Pure: takes an RGBA8 grid; decoding a frame into that grid happens at the edge (colorFrames.ts).

export type Vec3 = [number, number, number];

export interface Scopes {
  lumaMean: number;
  lumaBlack: number; // 2nd percentile
  lumaWhite: number; // 98th percentile
  clipLow: number; // fraction of pixels with luma < 0.02
  clipHigh: number; // fraction with luma > 0.98
  lumaHistogram: number[]; // 16 bins, normalized
  meanRGB: Vec3;
  blackRGB: Vec3; // per-channel 2nd percentile
  whiteRGB: Vec3; // per-channel 98th percentile
  shadowRGB: Vec3; // mean RGB of pixels with luma < 1/3
  midRGB: Vec3;
  highRGB: Vec3; // mean RGB of pixels with luma > 2/3
  saturationMean: number;
  warmCoolBias: number; // meanR − meanB (+ = warm)
  greenMagentaBias: number; // meanG − (meanR+meanB)/2 (+ = green)
  hueHistogram: number[]; // 12 bins of 30° from 0°/red, saturation-weighted, normalized
  colorfulPct: number; // fraction of pixels with saturation > 0.15
}

const f = Math.fround;

/** Swift `Float` percentile lookup on a sorted array. */
function pct(sorted: Float32Array, p: number): number {
  const idx = Math.trunc(f(p * f(sorted.length - 1)));
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))] as number;
}

/** Measures an `n`×`n` RGBA8 grid (row-major); undefined when the grid is empty or too short. */
export function measureScopes(rgba: ArrayLike<number>, n: number): Scopes | undefined {
  const count = n * n;
  if (!(n > 0) || rgba.length < count * 4) return undefined;
  const rs = new Float32Array(count);
  const gs = new Float32Array(count);
  const bs = new Float32Array(count);
  const ys = new Float32Array(count);
  let sumR = 0, sumG = 0, sumB = 0, sumY = 0, sumSat = 0;
  const shadow: Vec3 = [0, 0, 0];
  const mid: Vec3 = [0, 0, 0];
  const high: Vec3 = [0, 0, 0];
  let nShadow = 0, nMid = 0, nHigh = 0, clipLow = 0, clipHigh = 0;
  const hist = new Array<number>(16).fill(0);
  const hueHist = new Array<number>(12).fill(0);
  let hueWeight = 0;
  let nColorful = 0;

  for (let i = 0; i < count; i++) {
    const r = f((rgba[i * 4] as number) / 255);
    const g = f((rgba[i * 4 + 1] as number) / 255);
    const b = f((rgba[i * 4 + 2] as number) / 255);
    const y = f(f(f(0.2126 * r) + f(0.7152 * g)) + f(0.0722 * b));
    rs[i] = r; gs[i] = g; bs[i] = b; ys[i] = y;
    sumR = f(sumR + r); sumG = f(sumG + g); sumB = f(sumB + b); sumY = f(sumY + y);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? f(f(mx - mn) / mx) : 0;
    sumSat = f(sumSat + sat);
    if (sat > 0.15) {
      nColorful += 1;
      const d = f(mx - mn);
      let h = 0;
      if (d > 1e-6) {
        if (mx === r) h = f(f(g - b) / d);
        else if (mx === g) h = f(2 + f(f(b - r) / d));
        else h = f(4 + f(f(r - g) / d));
        h = f(h / 6);
        if (h < 0) h = f(h + 1);
      }
      const bin = Math.min(11, Math.trunc(f(h * 12)));
      hueHist[bin] = f((hueHist[bin] as number) + sat);
      hueWeight = f(hueWeight + sat);
    }
    const zone = y < f(1 / 3) ? shadow : y > f(2 / 3) ? high : mid;
    zone[0] = f(zone[0] + r); zone[1] = f(zone[1] + g); zone[2] = f(zone[2] + b);
    if (y < f(1 / 3)) nShadow += 1;
    else if (y > f(2 / 3)) nHigh += 1;
    else nMid += 1;
    if (y < 0.02) clipLow += 1;
    if (y > 0.98) clipHigh += 1;
    const bin = Math.min(15, Math.trunc(f(y * 16)));
    hist[bin] = (hist[bin] as number) + 1;
  }

  rs.sort(); gs.sort(); bs.sort(); ys.sort();
  const fc = f(count);
  const zoneMean = (s: Vec3, c: number): Vec3 => (c > 0 ? [f(s[0] / c), f(s[1] / c), f(s[2] / c)] : [0, 0, 0]);
  const meanR = f(sumR / fc);
  const meanG = f(sumG / fc);
  const meanB = f(sumB / fc);
  return {
    lumaMean: f(sumY / fc),
    lumaBlack: pct(ys, 0.02),
    lumaWhite: pct(ys, 0.98),
    clipLow: f(clipLow / fc),
    clipHigh: f(clipHigh / fc),
    lumaHistogram: hist.map((v) => f(v / fc)),
    meanRGB: [meanR, meanG, meanB],
    blackRGB: [pct(rs, 0.02), pct(gs, 0.02), pct(bs, 0.02)],
    whiteRGB: [pct(rs, 0.98), pct(gs, 0.98), pct(bs, 0.98)],
    shadowRGB: zoneMean(shadow, nShadow),
    midRGB: zoneMean(mid, nMid),
    highRGB: zoneMean(high, nHigh),
    saturationMean: f(sumSat / fc),
    warmCoolBias: f(meanR - meanB),
    greenMagentaBias: f(meanG - f(f(meanR + meanB) / 2)),
    hueHistogram: hueHist.map((v) => (hueWeight > 0 ? f(v / hueWeight) : 0)),
    colorfulPct: f(nColorful / fc),
  };
}

// Swift `r3`: "%.3f" of the Float, emitted as a clean 3-decimal number.
function r3(v: number): number {
  return Number(v.toFixed(3)) + 0;
}
const rgb = (v: Vec3): number[] => [r3(v[0]), r3(v[1]), r3(v[2])];
const sub = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];

export function scopesReadout(s: Scopes): Record<string, unknown> {
  return {
    luma: {
      black: r3(s.lumaBlack),
      white: r3(s.lumaWhite),
      mean: r3(s.lumaMean),
      clipLowPct: r3(f(s.clipLow * 100)),
      clipHighPct: r3(f(s.clipHigh * 100)),
      histogram16: s.lumaHistogram.map(r3),
    },
    meanRGB: rgb(s.meanRGB),
    blackRGB: rgb(s.blackRGB),
    whiteRGB: rgb(s.whiteRGB),
    zones: { shadows: rgb(s.shadowRGB), mids: rgb(s.midRGB), highs: rgb(s.highRGB) },
    saturation: r3(s.saturationMean),
    balance: { warmCool: r3(s.warmCoolBias), greenMagenta: r3(s.greenMagentaBias) },
    hueHistogram12: s.hueHistogram.map(r3),
    colorfulPct: r3(f(s.colorfulPct * 100)),
  };
}

/** current − reference for the key metrics, plus knob-mapped hints. */
export function scopesGap(c: Scopes, r: Scopes): Record<string, unknown> {
  const hints: string[] = [];
  const db = f(c.lumaBlack - r.lumaBlack);
  if (Math.abs(db) > 0.03) hints.push(db > 0 ? "blacks higher than ref → lower 'blacks' / deepen shadows" : "blacks lower than ref → raise 'blacks'");
  const dw = f(c.warmCoolBias - r.warmCoolBias);
  if (Math.abs(dw) > 0.03) hints.push(dw > 0 ? "warmer than ref → cooler 'temperature'" : "cooler than ref → warmer 'temperature'");
  const dg = f(c.greenMagentaBias - r.greenMagentaBias);
  if (Math.abs(dg) > 0.02) hints.push(dg > 0 ? "greener than ref → 'tint' toward magenta" : "more magenta than ref → 'tint' toward green");
  const dsat = f(c.saturationMean - r.saturationMean);
  if (Math.abs(dsat) > 0.03) hints.push(dsat > 0 ? "more saturated than ref → lower 'saturation'" : "less saturated than ref → raise 'saturation'");
  return {
    lumaBlack: r3(db),
    lumaWhite: r3(f(c.lumaWhite - r.lumaWhite)),
    lumaMean: r3(f(c.lumaMean - r.lumaMean)),
    warmCool: r3(dw),
    greenMagenta: r3(dg),
    saturation: r3(dsat),
    shadowsRGB: rgb(sub(c.shadowRGB, r.shadowRGB)),
    midsRGB: rgb(sub(c.midRGB, r.midRGB)),
    highsRGB: rgb(sub(c.highRGB, r.highRGB)),
    hints,
  };
}

