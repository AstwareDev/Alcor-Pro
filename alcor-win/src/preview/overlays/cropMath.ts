import type { Point, Rect, Size } from "../../model/geometry";
import { cropMinimumVisibleFraction, cropVisibleHeightFraction, cropVisibleWidthFraction, makeCrop, type Crop } from "../../model/timeline";
import { handleHitSize } from "./overlayMetrics";
import { rotateVector, type Corner } from "./transformMath";

/** `cropFrame`: the visible crop rect inside the clip rect (clip-local pixels, origin at the clip's top-left). */
export function cropRectLocal(crop: Crop, clipSize: Size): Rect {
  return {
    x: crop.left * clipSize.width,
    y: crop.top * clipSize.height,
    width: cropVisibleWidthFraction(crop) * clipSize.width,
    height: cropVisibleHeightFraction(crop) * clipSize.height,
  };
}

/** Port of `pannedCrop`: slides the visible window without resizing it. */
export function pannedCrop(start: Crop, translation: Size, clipSize: Size): Crop {
  if (!(clipSize.width > 0 && clipSize.height > 0)) return { ...start };
  const dx = translation.width / clipSize.width;
  const dy = translation.height / clipSize.height;
  const visW = 1 - start.left - start.right;
  const visH = 1 - start.top - start.bottom;
  const L = Math.max(0, Math.min(start.left + dx, 1 - visW));
  const T = Math.max(0, Math.min(start.top + dy, 1 - visH));
  return makeCrop({ left: L, top: T, right: 1 - visW - L, bottom: 1 - visH - T });
}

/**
 * Port of `resizedCrop` / `resizedCropLocked`. `translation` is in the clip's unrotated axes;
 * `aspectN` is the locked crop aspect normalized by the source aspect (`lockedAspectNormalized`).
 */
export function resizedCrop(start: Crop, corner: Corner, translation: Size, clipSize: Size, aspectN: number | undefined): Crop {
  if (!(clipSize.width > 0 && clipSize.height > 0)) return { ...start };
  const minVis = cropMinimumVisibleFraction;
  const dx = translation.width / clipSize.width;
  const dy = translation.height / clipSize.height;
  if (aspectN !== undefined) return resizedCropLocked(start, corner, dx, dy, aspectN, minVis);

  let L = start.left, T = start.top, R = start.right, B = start.bottom;
  switch (corner) {
    case "topLeft": L += dx; T += dy; break;
    case "topRight": R -= dx; T += dy; break;
    case "bottomLeft": L += dx; B -= dy; break;
    case "bottomRight": R -= dx; B -= dy; break;
  }
  L = Math.max(0, Math.min(L, 1 - minVis - R));
  R = Math.max(0, Math.min(R, 1 - minVis - L));
  T = Math.max(0, Math.min(T, 1 - minVis - B));
  B = Math.max(0, Math.min(B, 1 - minVis - T));
  return makeCrop({ left: L, top: T, right: R, bottom: B });
}

function resizedCropLocked(start: Crop, corner: Corner, dx: number, dy: number, aspectN: number, minVis: number): Crop {
  const L = start.left, T = start.top, R = start.right, B = start.bottom;
  const startVisW = 1 - L - R;
  const startVisH = 1 - T - B;

  // Sign follows the handle's moving edges.
  let widthDelta: number;
  let heightDelta: number;
  switch (corner) {
    case "topLeft": widthDelta = -dx; heightDelta = -dy; break;
    case "topRight": widthDelta = dx; heightDelta = -dy; break;
    case "bottomLeft": widthDelta = -dx; heightDelta = dy; break;
    case "bottomRight": widthDelta = dx; heightDelta = dy; break;
  }

  // Drive from whichever axis the user moved further (in width-equivalent units).
  const sFromW = startVisW + widthDelta;
  const sFromH = aspectN * (startVisH + heightDelta);
  let s = Math.abs(widthDelta) > Math.abs(heightDelta * aspectN) ? sFromW : sFromH;

  // Visible width must fit both source axes after applying aspect.
  const sMaxFromX = corner === "topRight" || corner === "bottomRight" ? 1 - L : 1 - R;
  const sMaxFromY = corner === "bottomLeft" || corner === "bottomRight" ? aspectN * (1 - T) : aspectN * (1 - B);
  const sMax = Math.min(sMaxFromX, sMaxFromY);
  const sMin = Math.max(minVis, minVis * aspectN);
  if (!(sMax >= sMin)) return { ...start };
  s = Math.min(Math.max(s, sMin), sMax);

  const newVisW = s;
  const newVisH = s / aspectN;
  let newL = L, newT = T, newR = R, newB = B;
  switch (corner) {
    case "topLeft": newL = 1 - R - newVisW; newT = 1 - B - newVisH; break;
    case "topRight": newR = 1 - L - newVisW; newT = 1 - B - newVisH; break;
    case "bottomLeft": newL = 1 - R - newVisW; newB = 1 - T - newVisH; break;
    case "bottomRight": newR = 1 - L - newVisW; newB = 1 - T - newVisH; break;
  }
  return makeCrop({ left: newL, top: newT, right: newR, bottom: newB });
}

export type CropHit = { kind: "pan" } | { kind: "resize"; corner: Corner };

/** Maps an overlay-pixel point into clip-local pixels (origin at the clip's unrotated top-left, rotation undone). */
export function toClipLocal(point: Point, clipRect: Rect, rotationDegrees: number): Point {
  const cx = clipRect.x + clipRect.width / 2;
  const cy = clipRect.y + clipRect.height / 2;
  const v = rotateVector({ x: point.x - cx, y: point.y - cy }, -rotationDegrees);
  return { x: v.x + clipRect.width / 2, y: v.y + clipRect.height / 2 };
}

/** Crop handle under a clip-local point: corners win over the pan area. */
export function cropHitAt(local: Point, cropRect: Rect): CropHit | null {
  const half = handleHitSize / 2;
  const entries: [Corner, number, number][] = [
    ["topLeft", cropRect.x, cropRect.y],
    ["topRight", cropRect.x + cropRect.width, cropRect.y],
    ["bottomLeft", cropRect.x, cropRect.y + cropRect.height],
    ["bottomRight", cropRect.x + cropRect.width, cropRect.y + cropRect.height],
  ];
  let best: Corner | null = null;
  let bestDistance = Infinity;
  for (const [corner, x, y] of entries) {
    const dx = Math.abs(local.x - x), dy = Math.abs(local.y - y);
    if (dx > half || dy > half) continue;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = corner;
    }
  }
  if (best) return { kind: "resize", corner: best };
  const inside = local.x >= cropRect.x && local.x <= cropRect.x + cropRect.width && local.y >= cropRect.y && local.y <= cropRect.y + cropRect.height;
  return inside ? { kind: "pan" } : null;
}
