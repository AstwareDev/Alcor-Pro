import { asObject, decodeArray, getArray, getDouble } from "../util/jsonDecode";

export interface CurvePoint {
  x: number;
  y: number;
}

export function makeCurvePoint(x: number, y: number): CurvePoint {
  return { x, y };
}

export function decodeCurvePoint(json: unknown): CurvePoint {
  const c = asObject(json, "CurvePoint");
  return { x: getDouble(c, "x"), y: getDouble(c, "y") };
}

export function decodeCurvePoints(json: unknown): CurvePoint[] {
  return decodeArray(json, decodeCurvePoint, "points");
}

/** Master (Rec.709 luma) + per-channel R/G/B tone curves. */
export interface GradeCurve {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export function makeGradeCurve(p: Partial<GradeCurve> = {}): GradeCurve {
  return { master: p.master ?? [], red: p.red ?? [], green: p.green ?? [], blue: p.blue ?? [] };
}

export const gradeCurveIdentityPoints: readonly CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

function pointsEqual(a: readonly CurvePoint[], b: readonly CurvePoint[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === (b[i] as CurvePoint).x && p.y === (b[i] as CurvePoint).y);
}

export function gradeCurveIsIdentity(g: GradeCurve): boolean {
  return [g.master, g.red, g.green, g.blue].every((c) => c.length === 0 || pointsEqual(c, gradeCurveIdentityPoints));
}

/** Piecewise-linear interpolation, clamped flat outside the point range. */
export function gradeCurveEval(pts: readonly CurvePoint[], x: number): number {
  const p = [...(pts.length === 0 ? gradeCurveIdentityPoints : pts)].sort((a, b) => a.x - b.x);
  const first = p[0] as CurvePoint;
  const last = p[p.length - 1] as CurvePoint;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < p.length; i++) {
    const b = p[i] as CurvePoint;
    if (x <= b.x) {
      const a = p[i - 1] as CurvePoint;
      const t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return x;
}

/** Synthesized Codable: every key is required. */
export function decodeGradeCurve(json: unknown): GradeCurve {
  const c = asObject(json, "GradeCurve");
  return {
    master: getArray(c, "master", decodeCurvePoint),
    red: getArray(c, "red", decodeCurvePoint),
    green: getArray(c, "green", decodeCurvePoint),
    blue: getArray(c, "blue", decodeCurvePoint),
  };
}

/** `GradeCurve.encoded()`. Key order follows declaration order; Swift's JSONEncoder does not guarantee one. */
export function gradeCurveEncoded(g: GradeCurve): string {
  return JSON.stringify({ master: g.master, red: g.red, green: g.green, blue: g.blue });
}

/** `GradeCurve(json:)` */
export function gradeCurveFromJson(json: string): GradeCurve | undefined {
  try {
    return decodeGradeCurve(JSON.parse(json));
  } catch {
    return undefined; // malformed JSON or shape mismatch, like `try?`
  }
}
