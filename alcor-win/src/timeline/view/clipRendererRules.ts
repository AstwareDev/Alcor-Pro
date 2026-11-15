import { Trim, type Rect } from "../../model";
import { formatTimecode } from "../../util/timeFormatting";

// Visibility rules and sizes of ClipRenderer / AppTheme.ComponentSize used by drawing and hit testing alike.

export const ClipSizes = {
  borderMinWidth: 8,
  detailMinWidth: 32,
  controlsMinWidth: 48,
  labelMinWidth: 56,
  badgePadH: 4,
  badgePadV: 1,
  badgeMinWidth: 16,
  dotSize: 5,
  volumeKeyframeSize: 7,
  keyframeDiamondSize: 8,
} as const;

export function usesCompactRendering(rect: Rect): boolean {
  return rect.width < ClipSizes.borderMinWidth;
}

export function supportsPrecisionControls(width: number): boolean {
  return width >= ClipSizes.controlsMinWidth;
}

export function showsLabel(isSelected: boolean, rect: Rect): boolean {
  return rect.width >= (isSelected ? ClipSizes.detailMinWidth : ClipSizes.labelMinWidth);
}

export function showsFadeControls(isSelected: boolean, isHovered: boolean, rect: Rect): boolean {
  if (!supportsPrecisionControls(rect.width)) return false;
  return isHovered || isSelected;
}

export function showsVolumeKeyframes(isSelected: boolean, isHovered: boolean, rect: Rect): boolean {
  return isSelected && showsFadeControls(isSelected, isHovered, rect);
}

export type TrimEdge = "left" | "right";

/** `TimelineInputController.trimEdge(localX:clipWidth:)`: narrow clips use their whole width for moving. */
export function trimEdgeAt(localX: number, clipWidth: number): TrimEdge | undefined {
  if (!supportsPrecisionControls(clipWidth)) return undefined;
  if (localX <= Trim.handleWidth) return "left";
  if (localX >= clipWidth - Trim.handleWidth) return "right";
  return undefined;
}

/** Duration label in the clip label bar: drops the hours field below one hour. */
export function formatClipDuration(frame: number, fps: number): string {
  const full = formatTimecode(frame, fps);
  if (!(fps > 0) || Math.abs(frame) < fps * 3600) {
    return full.startsWith("-") ? `-${full.slice(4)}` : full.slice(3);
  }
  return full;
}

export function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return text;
}
