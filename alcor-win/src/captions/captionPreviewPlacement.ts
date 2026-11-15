import { captionCenterSnapThreshold, captionCenterSnapValue } from "./constants";

// Port of CaptionPreviewPlacement (CaptionPreviewOverlay.swift): normalized caption centre math.

export interface Point2 {
  x: number;
  y: number;
}

export interface Size2 {
  width: number;
  height: number;
}

/** Snaps to the canvas centre within the threshold; non-finite values snap to the centre. */
export function snappedCoordinate(value: number): number {
  if (!Number.isFinite(value)) return captionCenterSnapValue;
  return Math.abs(value - captionCenterSnapValue) < captionCenterSnapThreshold ? captionCenterSnapValue : value;
}

export function movedCenter(start: Point2, translation: Size2, size: Size2): Point2 {
  if (
    !Number.isFinite(size.width) || !Number.isFinite(size.height) || !(size.width > 0) || !(size.height > 0) ||
    !Number.isFinite(translation.width) || !Number.isFinite(translation.height)
  ) {
    return start;
  }
  return {
    x: snappedCoordinate(start.x + translation.width / size.width),
    y: snappedCoordinate(start.y + translation.height / size.height),
  };
}

/** Offset of a centred raster to the caption's position, in view points. */
export function viewOffset(center: Point2, size: Size2): Size2 {
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return { width: 0, height: 0 };
  }
  return { width: (center.x - captionCenterSnapValue) * size.width, height: (center.y - captionCenterSnapValue) * size.height };
}
