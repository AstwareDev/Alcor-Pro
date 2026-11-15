import type { Point, Rect, Size } from "../../model/geometry";
import type { Transform } from "../../model/timeline";
import { clipRectPx, rotateVector } from "../overlays/transformMath";

/**
 * Mapping between a clip's normalized local space ((0,0) top-left, (1,1) bottom-right of its transform rect) and
 * overlay pixels. Drawing happens in the unrotated rect with the clip's rotation applied by the caller (`localToRect`);
 * pointer input goes the other way through `overlayToLocal`.
 */
export interface MaskSpace {
  rect: Rect;
  cx: number;
  cy: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export function maskSpace(t: Transform, size: Size): MaskSpace {
  const rect = clipRectPx(t, size);
  return {
    rect, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, rotation: t.rotation,
    flipH: t.flipHorizontal, flipV: t.flipVertical,
  };
}

/** Local point to pixels inside the unrotated clip rect. */
export function localToRect(s: MaskSpace, u: number, v: number): Point {
  return { x: s.rect.x + (s.flipH ? 1 - u : u) * s.rect.width, y: s.rect.y + (s.flipV ? 1 - v : v) * s.rect.height };
}

/** Overlay pixel (rotation included) to local space. */
export function overlayToLocal(s: MaskSpace, p: Point): Point {
  const d = s.rotation === 0 ? { x: p.x - s.cx, y: p.y - s.cy } : rotateVector({ x: p.x - s.cx, y: p.y - s.cy }, -s.rotation);
  const u = (s.cx + d.x - s.rect.x) / s.rect.width;
  const v = (s.cy + d.y - s.rect.y) / s.rect.height;
  return { x: s.flipH ? 1 - u : u, y: s.flipV ? 1 - v : v };
}

/** Local point to overlay pixels (rotation included). */
export function localToOverlay(s: MaskSpace, u: number, v: number): Point {
  const p = localToRect(s, u, v);
  if (s.rotation === 0) return p;
  const d = rotateVector({ x: p.x - s.cx, y: p.y - s.cy }, s.rotation);
  return { x: s.cx + d.x, y: s.cy + d.y };
}
