import { deepEqual, setOptional } from "./equality";
import { newId } from "../util/id";
import { clamp } from "../util/math";
import {
  asObject, decodeBool, decodeDouble, getArray, tryBool, tryDouble, tryEnum, tryString, tryWith,
} from "../util/jsonDecode";
import {
  decodeKeyframeTrack, doubleInterpolator, keyframeTrackIsActive, keyframeTrackSample,
  type Interpolator, type KeyframeTrack,
} from "./keyframe";

// After Effects-style clip masks. Geometry lives in the clip's own normalized local space: (0,0) is the top-left and
// (1,1) the bottom-right of the clip's transform rect, so a mask follows the clip's transform and crop.

export const maskShapes = ["rectangle", "ellipse", "path"] as const;
export type MaskShape = (typeof maskShapes)[number];

export const maskModes = ["add", "subtract", "intersect", "difference"] as const;
export type MaskMode = (typeof maskModes)[number];

export const maskOpacityRange = { min: 0, max: 1 } as const;
export const maskFeatherMax = 1000;
export const maskExpansionRange = { min: -1000, max: 1000 } as const;

/** Bezier vertex. Tangents are offsets from the vertex (AE convention); zero offsets make a corner. */
export interface MaskVertex {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface MaskPath {
  closed: boolean;
  vertices: MaskVertex[];
}

export interface Mask {
  id: string;
  name: string;
  shape: MaskShape;
  mode: MaskMode;
  inverted: boolean;
  /** Blur radius in pixels at timeline resolution. */
  feather: number;
  /** Grow (positive) or shrink (negative) in pixels at timeline resolution. */
  expansion: number;
  opacity: number;
  path: MaskPath;
  pathTrack?: KeyframeTrack<MaskPath>;
  featherTrack?: KeyframeTrack<number>;
  opacityTrack?: KeyframeTrack<number>;
  expansionTrack?: KeyframeTrack<number>;
}

export type MaskProperty = "path" | "feather" | "opacity" | "expansion";
export const maskProperties: readonly MaskProperty[] = ["path", "feather", "opacity", "expansion"];

export function maskTrackKey(p: MaskProperty): "pathTrack" | "featherTrack" | "opacityTrack" | "expansionTrack" {
  return `${p}Track`;
}

// MARK: - Construction

export function makeMaskVertex(x: number, y: number, p: Partial<MaskVertex> = {}): MaskVertex {
  return { x, y, inX: p.inX ?? 0, inY: p.inY ?? 0, outX: p.outX ?? 0, outY: p.outY ?? 0 };
}

export function makeMaskPath(vertices: MaskVertex[] = [], closed = true): MaskPath {
  return { closed, vertices };
}

export function makeRectanglePath(x0: number, y0: number, x1: number, y1: number): MaskPath {
  return makeMaskPath([makeMaskVertex(x0, y0), makeMaskVertex(x1, y0), makeMaskVertex(x1, y1), makeMaskVertex(x0, y1)]);
}

/** Cubic-bezier circle constant. */
const kappa = 0.5522847498;

export function makeEllipsePath(cx: number, cy: number, rx: number, ry: number): MaskPath {
  const kx = rx * kappa, ky = ry * kappa;
  return makeMaskPath([
    makeMaskVertex(cx, cy - ry, { inX: -kx, outX: kx }),
    makeMaskVertex(cx + rx, cy, { inY: -ky, outY: ky }),
    makeMaskVertex(cx, cy + ry, { inX: kx, outX: -kx }),
    makeMaskVertex(cx - rx, cy, { inY: ky, outY: -ky }),
  ]);
}

/** Default path for each shape: inset so the handles are reachable on the clip edges. */
export function defaultMaskPath(shape: MaskShape): MaskPath {
  switch (shape) {
    case "rectangle": return makeRectanglePath(0.2, 0.2, 0.8, 0.8);
    case "ellipse": return makeEllipsePath(0.5, 0.5, 0.3, 0.3);
    case "path": return makeMaskPath([], false);
  }
}

export function maskShapeLabel(shape: MaskShape): string {
  switch (shape) {
    case "rectangle": return "Rectangle";
    case "ellipse": return "Ellipse";
    case "path": return "Path";
  }
}

export function makeMask(p: Partial<Mask> = {}): Mask {
  const shape = p.shape ?? "path";
  const mask: Mask = {
    id: p.id ?? newId(),
    name: p.name ?? "Mask",
    shape,
    mode: p.mode ?? "add",
    inverted: p.inverted ?? false,
    feather: p.feather ?? 0,
    expansion: p.expansion ?? 0,
    opacity: p.opacity ?? 1,
    path: p.path ?? defaultMaskPath(shape),
  };
  if (p.pathTrack) mask.pathTrack = p.pathTrack;
  if (p.featherTrack) mask.featherTrack = p.featherTrack;
  if (p.opacityTrack) mask.opacityTrack = p.opacityTrack;
  if (p.expansionTrack) mask.expansionTrack = p.expansionTrack;
  return mask;
}

// MARK: - Codec

export function decodeMaskVertex(json: unknown): MaskVertex {
  const c = asObject(json, "MaskVertex");
  const n = (key: string): number => tryDouble(c, key) ?? 0;
  return { x: decodeDouble(c["x"], "x"), y: decodeDouble(c["y"], "y"), inX: n("inX"), inY: n("inY"), outX: n("outX"), outY: n("outY") };
}

export function decodeMaskPath(json: unknown): MaskPath {
  const c = asObject(json, "MaskPath");
  return { closed: c["closed"] === undefined ? true : decodeBool(c["closed"], "closed"), vertices: getArray(c, "vertices", decodeMaskVertex) };
}

export function decodeMask(json: unknown): Mask {
  const c = asObject(json, "Mask");
  const shape = tryEnum(c, "shape", maskShapes) ?? "path";
  return makeMask({
    id: tryString(c, "id"),
    name: tryString(c, "name"),
    shape,
    mode: tryEnum(c, "mode", maskModes),
    inverted: tryBool(c, "inverted"),
    feather: Math.max(0, tryDouble(c, "feather") ?? 0),
    expansion: tryDouble(c, "expansion"),
    opacity: clamp(tryDouble(c, "opacity") ?? 1, 0, 1),
    path: tryWith(c, "path", decodeMaskPath),
    pathTrack: tryWith(c, "pathTrack", (v) => decodeKeyframeTrack(v, decodeMaskPath)),
    featherTrack: tryWith(c, "featherTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    opacityTrack: tryWith(c, "opacityTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    expansionTrack: tryWith(c, "expansionTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
  });
}

// MARK: - Interpolation and evaluation

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Per-vertex interpolation when the topology matches, otherwise hold the earlier path. */
export const maskPathInterpolator: Interpolator<MaskPath> = {
  interpolate(a, b, t) {
    if (a.closed !== b.closed || a.vertices.length !== b.vertices.length) return a;
    return {
      closed: a.closed,
      vertices: a.vertices.map((v, i) => {
        const w = b.vertices[i] as MaskVertex;
        return {
          x: lerp(v.x, w.x, t), y: lerp(v.y, w.y, t),
          inX: lerp(v.inX, w.inX, t), inY: lerp(v.inY, w.inY, t),
          outX: lerp(v.outX, w.outX, t), outY: lerp(v.outY, w.outY, t),
        };
      }),
    };
  },
};

/** `offset` is the frame relative to the clip start (the same convention as the clip's own keyframe tracks). */
export function maskPathAt(mask: Mask, offset: number): MaskPath {
  return mask.pathTrack ? keyframeTrackSample(mask.pathTrack, offset, mask.path, maskPathInterpolator) : mask.path;
}

export function maskFeatherAt(mask: Mask, offset: number): number {
  const v = mask.featherTrack ? keyframeTrackSample(mask.featherTrack, offset, mask.feather, doubleInterpolator) : mask.feather;
  return Math.max(0, v);
}

export function maskExpansionAt(mask: Mask, offset: number): number {
  return mask.expansionTrack ? keyframeTrackSample(mask.expansionTrack, offset, mask.expansion, doubleInterpolator) : mask.expansion;
}

export function maskOpacityAt(mask: Mask, offset: number): number {
  const v = mask.opacityTrack ? keyframeTrackSample(mask.opacityTrack, offset, mask.opacity, doubleInterpolator) : mask.opacity;
  return clamp(v, 0, 1);
}

export function maskIsAnimated(mask: Mask): boolean {
  return maskProperties.some((p) => {
    const t = maskTrack(mask, p);
    return t !== undefined && keyframeTrackIsActive(t);
  });
}

export function masksAreAnimated(masks: readonly Mask[]): boolean {
  return masks.some(maskIsAnimated);
}

export function maskTrack(mask: Mask, property: MaskProperty): KeyframeTrack<unknown> | undefined {
  return mask[maskTrackKey(property)] as KeyframeTrack<unknown> | undefined;
}

export function maskKeyframeFrames(mask: Mask, property: MaskProperty): number[] {
  return maskTrack(mask, property)?.keyframes.map((k) => k.frame) ?? [];
}

/** Applies `fn` to every keyframe track of every mask, dropping tracks it returns `undefined` for. */
export function masksMapTracks(
  masks: Mask[] | undefined,
  fn: <V>(track: KeyframeTrack<V> | undefined) => KeyframeTrack<V> | undefined,
): void {
  if (!masks) return;
  for (const m of masks) {
    setOptional(m, "pathTrack", fn(m.pathTrack));
    setOptional(m, "featherTrack", fn(m.featherTrack));
    setOptional(m, "opacityTrack", fn(m.opacityTrack));
    setOptional(m, "expansionTrack", fn(m.expansionTrack));
  }
}

export function maskPathsEqual(a: MaskPath, b: MaskPath): boolean {
  return deepEqual(a, b);
}

/** Axis-aligned bounds of the vertices (tangents ignored); undefined for an empty path. */
export function maskPathBounds(path: MaskPath): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const first = path.vertices[0];
  if (!first) return undefined;
  let x0 = first.x, y0 = first.y, x1 = first.x, y1 = first.y;
  for (const v of path.vertices) {
    x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y);
    x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y);
  }
  return { x0, y0, x1, y1 };
}

/** Active on-canvas mask drawing tool (transient UI state). */
export type MaskTool = "pen" | "rectangle" | "ellipse";
