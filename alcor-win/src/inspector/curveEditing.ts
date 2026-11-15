import { gradeCurveIdentityPoints, type CurvePoint } from "../model";

export interface Size {
  width: number;
  height: number;
}

export const curvePointHitDiameter = 30;

export function toScreen(p: CurvePoint, size: Size): { x: number; y: number } {
  return { x: p.x * size.width, y: (1 - p.y) * size.height };
}

export function toValue(x: number, y: number, size: Size): CurvePoint {
  return { x: Math.min(1, Math.max(0, x / size.width)), y: Math.min(1, Math.max(0, 1 - y / size.height)) };
}

export function nearestIndex(x: number, y: number, pts: readonly CurvePoint[], size: Size, hit = curvePointHitDiameter): number | undefined {
  let best: { i: number; d: number } | undefined;
  pts.forEach((p, i) => {
    const s = toScreen(p, size);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= hit / 2 && (best === undefined || d < best.d)) best = { i, d };
  });
  return best?.i;
}

/** Grab the nearest point at press, or drop a new one; returns the sorted points and the grabbed index. */
export function grabPoint(sorted: readonly CurvePoint[], x: number, y: number, size: Size): { points: CurvePoint[]; index: number } {
  const pts = sorted.map((p) => ({ ...p }));
  const near = nearestIndex(x, y, pts, size);
  if (near !== undefined) return { points: pts, index: near };
  const np = toValue(x, y, size);
  pts.push(np);
  pts.sort((a, b) => a.x - b.x);
  return { points: pts, index: Math.max(0, pts.findIndex((p) => p.x === np.x && p.y === np.y)) };
}

/** Endpoints only move vertically; interior points stay between their neighbours. */
export function movePoint(points: readonly CurvePoint[], index: number, x: number, y: number, size: Size): CurvePoint[] {
  const pts = points.map((p) => ({ ...p }));
  const v = toValue(x, y, size);
  const target = pts[index];
  if (!target) return pts;
  target.y = v.y;
  if (index !== 0 && index !== pts.length - 1) {
    const prev = pts[index - 1] as CurvePoint;
    const next = pts[index + 1] as CurvePoint;
    target.x = Math.min(next.x - 0.001, Math.max(prev.x + 0.001, v.x));
  }
  return pts;
}

export function removeNearestPoint(sorted: readonly CurvePoint[], x: number, y: number, size: Size): CurvePoint[] | undefined {
  const i = nearestIndex(x, y, sorted, size);
  if (i === undefined || sorted.length <= 2 || i === 0 || i === sorted.length - 1) return undefined;
  return sorted.filter((_, k) => k !== i).map((p) => ({ ...p }));
}

/** Identity (default) points are stored as an empty list. */
export function pointsToStore(pts: readonly CurvePoint[], identity: readonly CurvePoint[] = gradeCurveIdentityPoints): CurvePoint[] {
  const same = pts.length === identity.length && pts.every((p, i) => p.x === identity[i]?.x && p.y === identity[i]?.y);
  return same ? [] : pts.map((p) => ({ ...p }));
}
