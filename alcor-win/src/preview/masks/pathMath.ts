import { makeMaskVertex, type MaskPath, type MaskVertex } from "../../model/mask";

export interface Pt {
  x: number;
  y: number;
}

/** Cubic bezier of one path segment. */
export interface Segment {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
}

/** Segment i runs from vertex i to the next vertex; the last one wraps only when the path is closed. */
export function segmentCount(path: MaskPath): number {
  const n = path.vertices.length;
  return n < 2 ? 0 : path.closed ? n : n - 1;
}

export function segmentAt(path: MaskPath, i: number): Segment {
  const n = path.vertices.length;
  const a = path.vertices[i] as MaskVertex;
  const b = path.vertices[(i + 1) % n] as MaskVertex;
  return {
    p0: { x: a.x, y: a.y },
    c1: { x: a.x + a.outX, y: a.y + a.outY },
    c2: { x: b.x + b.inX, y: b.y + b.inY },
    p3: { x: b.x, y: b.y },
  };
}

export function bezierPoint(s: Segment, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p3.y,
  };
}

export interface PathHit {
  segment: number;
  t: number;
  distance: number;
}

const hitSteps = 24;

/** Nearest point on the path outline to `p` (same units as the path), or undefined for paths without segments. */
export function nearestOnPath(path: MaskPath, p: Pt): PathHit | undefined {
  let best: PathHit | undefined;
  for (let i = 0; i < segmentCount(path); i++) {
    const s = segmentAt(path, i);
    let prev = s.p0;
    for (let k = 1; k <= hitSteps; k++) {
      const next = bezierPoint(s, k / hitSteps);
      const dx = next.x - prev.x, dy = next.y - prev.y;
      const len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / len2)) : 0;
      const d = Math.hypot(prev.x + dx * u - p.x, prev.y + dy * u - p.y);
      if (!best || d < best.distance) best = { segment: i, t: (k - 1 + u) / hitSteps, distance: d };
      prev = next;
    }
  }
  return best;
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Splits segment `segment` at `t` (de Casteljau) keeping the curve shape. The new vertex gets index `segment + 1`. */
export function insertVertex(path: MaskPath, segment: number, t: number): MaskPath {
  const s = segmentAt(path, segment);
  const ab = lerpPt(s.p0, s.c1, t), bc = lerpPt(s.c1, s.c2, t), cd = lerpPt(s.c2, s.p3, t);
  const abc = lerpPt(ab, bc, t), bcd = lerpPt(bc, cd, t);
  const p = lerpPt(abc, bcd, t);
  const vertices = path.vertices.map((v) => ({ ...v }));
  const a = vertices[segment] as MaskVertex;
  const b = vertices[(segment + 1) % vertices.length] as MaskVertex;
  a.outX = ab.x - a.x;
  a.outY = ab.y - a.y;
  b.inX = cd.x - b.x;
  b.inY = cd.y - b.y;
  vertices.splice(segment + 1, 0, makeMaskVertex(p.x, p.y, { inX: abc.x - p.x, inY: abc.y - p.y, outX: bcd.x - p.x, outY: bcd.y - p.y }));
  return { closed: path.closed, vertices };
}

/** Removes vertex `index`; a closed path keeps at least 3 vertices and an open one at least 1. */
export function removeVertex(path: MaskPath, index: number): MaskPath {
  const min = path.closed ? 3 : 1;
  if (path.vertices.length <= min || index < 0 || index >= path.vertices.length) return path;
  return { closed: path.closed, vertices: path.vertices.filter((_, i) => i !== index).map((v) => ({ ...v })) };
}

export function moveVertex(path: MaskPath, index: number, dx: number, dy: number): MaskPath {
  return {
    closed: path.closed,
    vertices: path.vertices.map((v, i) => (i === index ? { ...v, x: v.x + dx, y: v.y + dy } : { ...v })),
  };
}

/** Translates the whole path (tangents are offsets, so they stay). */
export function movePath(path: MaskPath, dx: number, dy: number): MaskPath {
  return { closed: path.closed, vertices: path.vertices.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })) };
}

/** Sets one tangent from an absolute handle position. Unless `broken`, the opposite handle mirrors it (smooth point). */
export function setTangent(path: MaskPath, index: number, side: "in" | "out", handle: Pt, broken: boolean): MaskPath {
  return {
    closed: path.closed,
    vertices: path.vertices.map((v, i) => {
      if (i !== index) return { ...v };
      const ox = handle.x - v.x, oy = handle.y - v.y;
      if (side === "out") return broken ? { ...v, outX: ox, outY: oy } : { ...v, outX: ox, outY: oy, inX: -ox, inY: -oy };
      return broken ? { ...v, inX: ox, inY: oy } : { ...v, inX: ox, inY: oy, outX: -ox, outY: -oy };
    }),
  };
}

export function setClosed(path: MaskPath, closed: boolean): MaskPath {
  return { closed, vertices: path.vertices.map((v) => ({ ...v })) };
}

/** Axis-aligned rectangle from two drag corners (any order). */
export function rectBetween(a: Pt, b: Pt): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** Polyline approximation of the closed outline, for hit testing. */
function flatten(path: MaskPath): Pt[] {
  const out: Pt[] = [];
  const count = path.closed ? path.vertices.length : Math.max(0, path.vertices.length - 1);
  for (let i = 0; i < count; i++) {
    const seg = segmentAt(path, i);
    for (let k = 0; k < 12; k++) out.push(bezierPoint(seg, k / 12));
  }
  return out;
}

/** Even-odd containment of `p` in the (implicitly closed) outline. */
export function pathContains(path: MaskPath, p: Pt): boolean {
  const pts = flatten(path);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i] as Pt, b = pts[j] as Pt;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
