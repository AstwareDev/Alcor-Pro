import { setOptional } from "./equality";
import { asObject, getArray } from "../util/jsonDecode";
import { effectInsertIndex, makeEffect, makeEffectParam, type Effect } from "./effect";
import { decodeCurvePoint, type CurvePoint } from "./gradeCurve";

/** Resolve-style hue curves: each maps source hue (0…1, cyclic) to one adjustment */
export interface HueCurves {
  hueVsHue: CurvePoint[]; // → hue rotation
  hueVsSat: CurvePoint[]; // → saturation scale
  hueVsLum: CurvePoint[]; // → luminance shift
}

export function makeHueCurves(p: Partial<HueCurves> = {}): HueCurves {
  return { hueVsHue: p.hueVsHue ?? [], hueVsSat: p.hueVsSat ?? [], hueVsLum: p.hueVsLum ?? [] };
}

/** Raw values are the Swift `Channel` raw strings. */
export const hueCurveChannels = ["Hue", "Sat", "Luma"] as const;
export type HueCurveChannel = (typeof hueCurveChannels)[number];

export const hueCurvesNeutralY = 0.5;
export const hueCurvesEffectType = "color.hueCurves";
export const hueCurvesDefaultPoints: readonly CurvePoint[] = Array.from({ length: 6 }, (_, i) => ({
  x: i / 6,
  y: hueCurvesNeutralY,
}));

export function hueCurvesPoints(h: HueCurves, c: HueCurveChannel): CurvePoint[] {
  switch (c) {
    case "Hue": return h.hueVsHue;
    case "Sat": return h.hueVsSat;
    case "Luma": return h.hueVsLum;
  }
}

export function hueCurvesSet(h: HueCurves, c: HueCurveChannel, pts: CurvePoint[]): void {
  switch (c) {
    case "Hue": setOptional(h, "hueVsHue", pts); break;
    case "Sat": setOptional(h, "hueVsSat", pts); break;
    case "Luma": setOptional(h, "hueVsLum", pts); break;
  }
}

export function hueCurvesIsNeutral(pts: readonly CurvePoint[]): boolean {
  return pts.length === 0 || pts.every((p) => Math.abs(p.y - hueCurvesNeutralY) < 1e-4);
}

/** All curves flat → no effect to render or persist. */
export function hueCurvesIsIdentity(h: HueCurves): boolean {
  return [h.hueVsHue, h.hueVsSat, h.hueVsLum].every(hueCurvesIsNeutral);
}

function lerp(a: CurvePoint, b: CurvePoint, x: number): number {
  const t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

/** Cyclic piecewise-linear eval — wraps across the hue seam so the curve is seamless at 0/1. */
export function hueCurvesEval(pts: readonly CurvePoint[], x: number): number {
  const p = [...(pts.length === 0 ? hueCurvesDefaultPoints : pts)].sort((a, b) => a.x - b.x);
  const first = p[0];
  const last = p[p.length - 1];
  if (first === undefined || last === undefined) return hueCurvesNeutralY;
  if (x < first.x) return lerp({ x: last.x - 1, y: last.y }, first, x);
  for (let i = 1; i < p.length; i++) {
    const b = p[i] as CurvePoint;
    if (x <= b.x) return lerp(p[i - 1] as CurvePoint, b, x);
  }
  return lerp(last, { x: first.x + 1, y: first.y }, x);
}

/** Synthesized Codable: every key is required. */
export function decodeHueCurves(json: unknown): HueCurves {
  const c = asObject(json, "HueCurves");
  return {
    hueVsHue: getArray(c, "hueVsHue", decodeCurvePoint),
    hueVsSat: getArray(c, "hueVsSat", decodeCurvePoint),
    hueVsLum: getArray(c, "hueVsLum", decodeCurvePoint),
  };
}

export function hueCurvesEncoded(h: HueCurves): string {
  return JSON.stringify({ hueVsHue: h.hueVsHue, hueVsSat: h.hueVsSat, hueVsLum: h.hueVsLum });
}

/** `HueCurves(json:)` */
export function hueCurvesFromJson(json: string): HueCurves | undefined {
  try {
    return decodeHueCurves(JSON.parse(json));
  } catch {
    return undefined; // malformed JSON or shape mismatch, like `try?`
  }
}

export function hueCurvesRead(effects: readonly Effect[]): HueCurves {
  const json = effects.find((e) => e.type === hueCurvesEffectType)?.params["curves"]?.string;
  if (json === undefined) return makeHueCurves();
  return hueCurvesFromJson(json) ?? makeHueCurves();
}

/** Write `h` into `effects` (canonical order), or remove it when there's nothing to keep. */
export function hueCurvesUpsert(h: HueCurves, effects: Effect[]): void {
  const existing = effects.findIndex((e) => e.type === hueCurvesEffectType);
  if (hueCurvesIsIdentity(h)) {
    if (existing >= 0) effects.splice(existing, 1);
    return;
  }
  const json = hueCurvesEncoded(h);
  if (existing >= 0) {
    setOptional((effects[existing] as Effect).params, "curves", makeEffectParam({ string: json }));
  } else {
    const effect = makeEffect({ type: hueCurvesEffectType });
    effect.params["curves"] = makeEffectParam({ string: json });
    effects.splice(effectInsertIndex(effects, hueCurvesEffectType), 0, effect);
  }
}
