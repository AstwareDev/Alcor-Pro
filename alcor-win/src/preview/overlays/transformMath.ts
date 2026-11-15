import { Snap } from "../../model/constants";
import type { Point, Rect, Size } from "../../model/geometry";
import {
  makeTransformFromTopLeft,
  transformHasTiltRotation,
  transformSnapCenterToCanvasCenter,
  transformSnapToBoundary,
  transformSnapToCanvasEdges,
  transformTopLeft,
  type Transform,
} from "../../model/timeline";
import { swiftRound } from "../../util/math";
import { RotationSnap } from "../../ui/numberField";
import { textTiltCorners, textTiltCornersContains, type TextTiltCorners } from "../textTiltGeometry";
import { handleHitSize, minTransformSize, rotateHandleHitRadius, rotateHandleOffset, rotationStepDegrees } from "./overlayMetrics";

export type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
export const cornerList: readonly Corner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

export interface CenterGuides {
  x: boolean;
  y: boolean;
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** `clipFrame`: the clip's unrotated rect in overlay pixels. */
export function clipRectPx(t: Transform, size: Size): Rect {
  const tl = transformTopLeft(t);
  return { x: tl.x * size.width, y: tl.y * size.height, width: t.width * size.width, height: t.height * size.height };
}

/** Rotates a vector by `degrees` clockwise on screen (y down). */
export function rotateVector(v: Point, degrees: number): Point {
  const r = rad(degrees);
  const c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Screen delta expressed in the clip's unrotated axes (`clipLocal`). */
export function toLocalDelta(delta: Size, rotationDegrees: number): Size {
  if (rotationDegrees === 0) return delta;
  const v = rotateVector({ x: delta.width, y: delta.height }, -rotationDegrees);
  return { width: v.x, height: v.y };
}

// MARK: - Move

/** Port of `TransformOverlayMath.movedTransform`. */
export function movedTransform(start: Transform, translation: Size, size: Size): { transform: Transform; guides: CenterGuides } {
  if (!(size.width > 0 && size.height > 0)) return { transform: { ...start }, guides: { x: false, y: false } };
  const moved: Transform = { ...start };
  moved.centerX += translation.width / size.width;
  moved.centerY += translation.height / size.height;
  if (start.rotation === 0 && !transformHasTiltRotation(start)) {
    transformSnapToCanvasEdges(moved, Snap.thresholdPixels / size.width);
  }
  const guides = transformSnapCenterToCanvasCenter(moved, Snap.thresholdPixels / size.width, Snap.thresholdPixels / size.height);
  return { transform: moved, guides };
}

// MARK: - Resize

const cornerSigns: Record<Corner, { sx: number; sy: number }> = {
  topLeft: { sx: -1, sy: -1 },
  topRight: { sx: 1, sy: -1 },
  bottomLeft: { sx: -1, sy: 1 },
  bottomRight: { sx: 1, sy: 1 },
};

/**
 * Port of `resizedTransform`. `translation` is in the clip's unrotated axes. When `rotated`, canvas-edge snapping is
 * skipped (as in Swift) and the centre is moved so the opposite corner stays fixed on screen.
 */
export function resizedTransform(
  start: Transform,
  corner: Corner,
  translation: Size,
  size: Size,
  mediaCanvasAspect: number | undefined,
  rotated: boolean,
): Transform {
  if (!(size.width > 0 && size.height > 0)) return { ...start };
  const dx = translation.width / size.width;
  const dy = translation.height / size.height;
  const tl = transformTopLeft(start);
  let left = tl.x, top = tl.y;
  let right = left + start.width, bottom = top + start.height;
  const movesLeft = corner === "topLeft" || corner === "bottomLeft";
  const movesTop = corner === "topLeft" || corner === "topRight";

  if (movesLeft) left += dx; else right += dx;
  if (movesTop) top += dy; else bottom += dy;

  // Stop the dragged edge at the opposite edge so the rect can never invert.
  if (movesLeft) left = Math.min(left, right - minTransformSize); else right = Math.max(right, left + minTransformSize);
  if (movesTop) top = Math.min(top, bottom - minTransformSize); else bottom = Math.max(bottom, top + minTransformSize);

  if (mediaCanvasAspect !== undefined) {
    const aspect = mediaCanvasAspect;
    const w = right - left;
    const h = bottom - top;
    if (w >= h * aspect) {
      const adjustedH = w / aspect;
      if (movesTop) top = bottom - adjustedH; else bottom = top + adjustedH;
    } else {
      const adjustedW = h * aspect;
      if (movesLeft) left = right - adjustedW; else right = left + adjustedW;
    }
  }

  if (!rotated) {
    const snapH = Snap.thresholdPixels / size.width;
    const snapV = Snap.thresholdPixels / size.height;
    const edgeH = movesLeft ? left : right;
    const edgeV = movesTop ? top : bottom;
    const snappedH = transformSnapToBoundary(edgeH, snapH);
    const snappedV = transformSnapToBoundary(edgeV, snapV);
    if (snappedH !== edgeH) {
      if (movesLeft) left = snappedH; else right = snappedH;
      if (mediaCanvasAspect !== undefined) {
        if (movesTop) top = bottom - (right - left) / mediaCanvasAspect; else bottom = top + (right - left) / mediaCanvasAspect;
      }
    } else if (snappedV !== edgeV) {
      if (movesTop) top = snappedV; else bottom = snappedV;
      if (mediaCanvasAspect !== undefined) {
        if (movesLeft) left = right - (bottom - top) * mediaCanvasAspect; else right = left + (bottom - top) * mediaCanvasAspect;
      }
    }
  }

  const width = Math.max(minTransformSize, right - left);
  const height = Math.max(minTransformSize, bottom - top);
  const out = makeTransformFromTopLeft({ x: left, y: top }, width, height);
  out.rotation = start.rotation;
  if (rotated) {
    const { sx, sy } = cornerSigns[corner];
    const shift = rotateVector(
      { x: (sx * (width - start.width) * size.width) / 2, y: (sy * (height - start.height) * size.height) / 2 },
      start.rotation,
    );
    out.centerX = start.centerX + shift.x / size.width;
    out.centerY = start.centerY + shift.y / size.height;
  }
  return out;
}

/** Port of `textScale(from:corner:start:startScale:videoRect:)`. */
export function textScaleFromDrag(translation: Size, corner: Corner, start: Transform, startScale: number, size: Size): number {
  if (!(size.width > 0 && size.height > 0 && start.width > 0 && start.height > 0)) return startScale;
  const dx = translation.width / size.width;
  const dy = translation.height / size.height;
  const wSign = corner === "topLeft" || corner === "bottomLeft" ? -1 : 1;
  const hSign = corner === "topLeft" || corner === "topRight" ? -1 : 1;
  const wRatio = Math.max(0.01, (start.width + wSign * dx) / start.width);
  const hRatio = Math.max(0.01, (start.height + hSign * dy) / start.height);
  return Math.max(0.05, startScale * Math.sqrt(wRatio * hRatio));
}

// MARK: - Rotate

/** Clockwise degrees of `p` around `center`, 0 = straight up. */
export function pointerAngle(center: Point, p: Point): number {
  return (Math.atan2(p.x - center.x, -(p.y - center.y)) * 180) / Math.PI;
}

/** Signed difference `next - prev` folded into (-180, 180], so a drag past straight-down keeps turning. */
export function angleStep(prev: number, next: number): number {
  let d = (next - prev) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/** Rotation after a drag: axis snap within `RotationSnap` tolerance, or 15 degree steps with Shift. */
export function rotationFromDrag(rawDegrees: number, shift: boolean): { rotation: number; guides: boolean } {
  const rotation = shift ? swiftRound(rawDegrees / rotationStepDegrees) * rotationStepDegrees : RotationSnap.adjusted(rawDegrees);
  const normalized = rotation === 0 ? 0 : rotation;
  return { rotation: normalized, guides: RotationSnap.isAxisAligned(normalized) };
}

// MARK: - Geometry + hit zones

export interface BoxGeometry {
  /** Corner positions in overlay pixels (rotated / tilted as drawn). */
  corners: TextTiltCorners;
  center: Point;
  rotateHandle: Point;
  rotation: number;
}

function rotatedCorners(rect: Rect, center: Point, degrees: number): TextTiltCorners {
  const at = (x: number, y: number): Point => {
    const v = rotateVector({ x: x - center.x, y: y - center.y }, degrees);
    return { x: center.x + v.x, y: center.y + v.y };
  };
  return {
    topLeft: at(rect.x, rect.y),
    topRight: at(rect.x + rect.width, rect.y),
    bottomRight: at(rect.x + rect.width, rect.y + rect.height),
    bottomLeft: at(rect.x, rect.y + rect.height),
  };
}

/** Selection box of a clip: rotated rect, or the projected quad for tilted text (`tiltOverlay`). */
export function boxGeometry(t: Transform, size: Size, isText: boolean): BoxGeometry {
  const rect = clipRectPx(t, size);
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const corners = isText && transformHasTiltRotation(t)
    ? textTiltCorners(rect, center, t, size)
    : rotatedCorners(rect, center, t.rotation);
  const midTop = { x: (corners.topLeft.x + corners.topRight.x) / 2, y: (corners.topLeft.y + corners.topRight.y) / 2 };
  const midBottom = { x: (corners.bottomLeft.x + corners.bottomRight.x) / 2, y: (corners.bottomLeft.y + corners.bottomRight.y) / 2 };
  const ux = midTop.x - midBottom.x, uy = midTop.y - midBottom.y;
  const len = Math.hypot(ux, uy);
  const rotateHandle = len > 0
    ? { x: midTop.x + (ux / len) * rotateHandleOffset, y: midTop.y + (uy / len) * rotateHandleOffset }
    : { x: midTop.x, y: midTop.y - rotateHandleOffset };
  return { corners, center, rotateHandle, rotation: t.rotation };
}

export type TransformHit = { kind: "rotate" } | { kind: "resize"; corner: Corner } | { kind: "move" };

/** What the pointer is over: rotation handle, corner handle (nearest wins), the box body, or nothing. */
export function transformHitAt(point: Point, g: BoxGeometry): TransformHit | null {
  if (Math.hypot(point.x - g.rotateHandle.x, point.y - g.rotateHandle.y) <= rotateHandleHitRadius) return { kind: "rotate" };
  const half = handleHitSize / 2;
  let best: Corner | null = null;
  let bestDistance = Infinity;
  for (const corner of cornerList) {
    const c = g.corners[corner];
    const dx = Math.abs(point.x - c.x), dy = Math.abs(point.y - c.y);
    if (dx > half || dy > half) continue;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = corner;
    }
  }
  if (best) return { kind: "resize", corner: best };
  return textTiltCornersContains(g.corners, point) ? { kind: "move" } : null;
}

export type ResizeCursor = "ew-resize" | "ns-resize" | "nwse-resize" | "nesw-resize";

/** CSS cursor for a corner handle, following the clip's rotation. */
export function resizeCursor(corner: Corner, rotationDegrees: number): ResizeCursor {
  const { sx, sy } = cornerSigns[corner];
  const angle = (((Math.atan2(sy, sx) * 180) / Math.PI + rotationDegrees) % 180 + 180) % 180;
  const axis = (swiftRound(angle / 45) % 4) as 0 | 1 | 2 | 3;
  return (["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const)[axis];
}
