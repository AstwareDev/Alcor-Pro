/** Port of VideoEngine.histogram / hueHistogram: normalized luma + RGB bins and a saturation-weighted hue histogram. */
export interface HistogramYRGB {
  y: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export function makeHistogram(count: number): HistogramYRGB {
  return { y: new Float32Array(count), r: new Float32Array(count), g: new Float32Array(count), b: new Float32Array(count) };
}

/** Fills `out` from RGBA8 `pixels`; every bin is divided by the global maximum (0…1). Returns false for an empty frame. */
export function histogramYRGB(pixels: Uint8Array | Uint8ClampedArray, pixelCount: number, out: HistogramYRGB): boolean {
  const count = out.y.length;
  out.y.fill(0);
  out.r.fill(0);
  out.g.fill(0);
  out.b.fill(0);
  if (pixelCount <= 0 || count < 2) return false;
  const last = count - 1;
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = pixels[i] as number;
    const g = pixels[i + 1] as number;
    const b = pixels[i + 2] as number;
    out.r[Math.min(last, Math.floor((r / 255) * count))] += 1;
    out.g[Math.min(last, Math.floor((g / 255) * count))] += 1;
    out.b[Math.min(last, Math.floor((b / 255) * count))] += 1;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    out.y[Math.min(last, Math.floor(luma * count))] += 1;
  }
  let max = 0;
  for (let i = 0; i < count; i++) max = Math.max(max, out.y[i] as number, out.r[i] as number, out.g[i] as number, out.b[i] as number);
  if (max > 0) {
    for (let i = 0; i < count; i++) {
      out.y[i] = (out.y[i] as number) / max;
      out.r[i] = (out.r[i] as number) / max;
      out.g[i] = (out.g[i] as number) / max;
      out.b[i] = (out.b[i] as number) / max;
    }
  }
  return true;
}

/** Saturation-weighted hue histogram, sqrt-compressed so small humps stay visible. */
export function hueHistogram(pixels: Uint8Array | Uint8ClampedArray, pixelCount: number, out: Float32Array): boolean {
  out.fill(0);
  const count = out.length;
  if (pixelCount <= 0 || count < 2) return false;
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = (pixels[i] as number) / 255;
    const g = (pixels[i + 1] as number) / 255;
    const b = (pixels[i + 2] as number) / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (!(d > 1e-4 && mx > 1e-4)) continue;
    let hue = mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue / 6) % 1;
    if (hue < 0) hue += 1;
    out[Math.min(count - 1, Math.floor(hue * count))] += d / mx;
  }
  let max = 0;
  for (let i = 0; i < count; i++) max = Math.max(max, out[i] as number);
  if (max > 0) for (let i = 0; i < count; i++) out[i] = Math.sqrt((out[i] as number) / max);
  return true;
}
