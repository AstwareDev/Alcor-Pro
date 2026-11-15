import { resolvedValue, type ResolvedEffectParams } from "./effectRegistry";

type Vec3 = [number, number, number];

const chromaLift = 0.2;
const chromaGain = 0.35;
const chromaGamma = 0.35;

/** Fully-saturated hue at `h ∈ [0,1)`. */
export function colorWheelsHueRGB(h: number): Vec3 {
  const x = (h - Math.floor(h)) * 6;
  const f = x - Math.floor(x);
  switch (Math.trunc(x) % 6) {
    case 0: return [1, f, 0];
    case 1: return [1 - f, 1, 0];
    case 2: return [0, 1, f];
    case 3: return [0, 1 - f, 1];
    case 4: return [f, 0, 1];
    default: return [1, 0, 1 - f];
  }
}

/** Luma-neutral per-channel offset for a pad position (angle = hue, radius = strength). */
export function colorWheelsChromaOffset(x: number, y: number): Vec3 {
  const r = Math.min(1, Math.sqrt(x * x + y * y));
  if (!(r > 1e-6)) return [0, 0, 0];
  const [cr, cg, cb] = colorWheelsHueRGB(Math.atan2(y, x) / (2 * Math.PI));
  const mean = (cr + cg + cb) / 3;
  return [(cr - mean) * r, (cg - mean) * r, (cb - mean) * r];
}

function rimRamp(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Wheel-face color — a dark, lightly tinted body fading to a vivid saturated rim. */
export function colorWheelsDisplayColor(x: number, y: number): Vec3 {
  const r = Math.min(1, Math.sqrt(x * x + y * y));
  const [hr, hg, hb] = colorWheelsHueRGB(Math.atan2(y, x) / (2 * Math.PI));
  const v = 0.08 + 0.5 * Math.pow(r, 1.7);
  const s = Math.pow(r, 1.4);
  const rim = rimRamp((r - 0.86) / 0.14);
  const face = (h: number): number => {
    const body = v * ((1 - s) + h * s);
    return body + (h - body) * rim;
  };
  return [face(hr), face(hg), face(hb)];
}

export function colorWheelsIsNeutral(p: ResolvedEffectParams): boolean {
  const v = (k: string): number => resolvedValue(p, k);
  return v("lift_x") === 0 && v("lift_y") === 0 && v("lift_m") === 0 &&
    v("gamma_x") === 0 && v("gamma_y") === 0 && v("gamma_m") === 1 &&
    v("gain_x") === 0 && v("gain_y") === 0 && v("gain_m") === 1;
}

/** Per-channel lift / gain / inverse-gamma (Float32-rounded like the Swift SIMD3<Float>) for the resolved wheel params. */
export function colorWheelsCoefficients(p: ResolvedEffectParams): { lift: Vec3; gain: Vec3; invGamma: Vec3 } {
  const v = (k: string): number => resolvedValue(p, k);
  const lift = colorWheelsChromaOffset(v("lift_x"), v("lift_y"));
  const gamma = colorWheelsChromaOffset(v("gamma_x"), v("gamma_y"));
  const gain = colorWheelsChromaOffset(v("gain_x"), v("gain_y"));
  const liftM = v("lift_m"), gammaM = v("gamma_m"), gainM = v("gain_m");
  const l = (c: number): number => Math.fround(liftM + c * chromaLift);
  const g = (c: number): number => Math.fround(gainM * (1 + c * chromaGain));
  const ig = (c: number): number => Math.fround(1 / Math.max(0.01, gammaM * (1 + c * chromaGamma)));
  return {
    lift: [l(lift[0]), l(lift[1]), l(lift[2])],
    gain: [g(gain[0]), g(gain[1]), g(gain[2])],
    invGamma: [ig(gamma[0]), ig(gamma[1]), ig(gamma[2])],
  };
}
