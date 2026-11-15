/** CSS-style cubic-bezier easing: (0,0) → (x1,y1) → (x2,y2) → (1,1). Allocation-free; x1/x2 must be in [0,1]. */
export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  // Newton from the identity guess.
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = ((ax * s + bx) * s + cx) * s - x;
    if (Math.abs(err) < 1e-7) return ((ay * s + by) * s + cy) * s;
    const d = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  // Bisection fallback (x(s) is monotonic for x1,x2 in [0,1]).
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < 40; i++) {
    const v = ((ax * s + bx) * s + cx) * s;
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return ((ay * s + by) * s + cy) * s;
}
