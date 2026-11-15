import { createSignal } from "solid-js";

// Port of CanvasOverlaySelection / CanvasGridOverlay / CanvasGuideOverlay / CanvasFormatOverlay /
// CanvasOverlayGeometry (Preview/CanvasViewingOverlay.swift).

export const canvasGrids = [2, 3, 4, 5] as const;
export type CanvasGrid = (typeof canvasGrids)[number];

export const canvasGuides = ["actionSafe", "titleSafe", "center"] as const;
export type CanvasGuide = (typeof canvasGuides)[number];

export const canvasFormats = ["scope", "wide", "square", "portrait"] as const;
export type CanvasFormat = (typeof canvasFormats)[number];

export interface CanvasOverlaySelection {
  grid: CanvasGrid | null;
  guides: readonly CanvasGuide[];
  format: CanvasFormat | null;
}

export const emptyCanvasOverlays: CanvasOverlaySelection = { grid: null, guides: [], format: null };

export const canvasOverlaysEmpty = (s: CanvasOverlaySelection): boolean =>
  s.grid === null && s.guides.length === 0 && s.format === null;

export const gridLabel = (grid: CanvasGrid): string => `${grid} × ${grid}`;

export const guideLabels: Record<CanvasGuide, string> = { actionSafe: "Action Safe", titleSafe: "Title Safe", center: "Center" };

export const formatLabels: Record<CanvasFormat, string> = {
  scope: "Scope (2.39:1)",
  wide: "Wide (1.85:1)",
  square: "Square (1:1)",
  portrait: "Portrait (9:16)",
};

export const formatAspectRatios: Record<CanvasFormat, number> = { scope: 2.39, wide: 1.85, square: 1, portrait: 9 / 16 };

/** Normalized positions of the interior grid lines (`linePositions`). */
export function gridLinePositions(grid: CanvasGrid): number[] {
  return Array.from({ length: grid - 1 }, (_, i) => (i + 1) / grid);
}

/** Inset fraction of a safe-zone guide; null for the center cross. */
export const safeZoneInset = (guide: CanvasGuide): number | null =>
  guide === "actionSafe" ? 0.035 : guide === "titleSafe" ? 0.05 : null;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Aspect-fit rect of `aspectRatio` centered in a width x height canvas. */
export function formatContentRect(aspectRatio: number, width: number, height: number): Rect {
  if (!(aspectRatio > 0) || !(width > 0) || !(height > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  if (width / height > aspectRatio) {
    const w = height * aspectRatio;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = width / aspectRatio;
  return { x: 0, y: (height - h) / 2, width, height: h };
}

/** The four bars outside `content`, empty ones dropped (`outsideRects`). */
export function outsideRects(content: Rect, width: number, height: number): Rect[] {
  const maxX = content.x + content.width;
  const maxY = content.y + content.height;
  return [
    { x: 0, y: 0, width, height: content.y },
    { x: 0, y: maxY, width, height: height - maxY },
    { x: 0, y: content.y, width: content.x, height: content.height },
    { x: maxX, y: content.y, width: width - maxX, height: content.height },
  ].filter((r) => r.width > 0 && r.height > 0);
}

/** Toggle a guide, keeping the canonical order. */
export function toggleGuide(guides: readonly CanvasGuide[], guide: CanvasGuide): CanvasGuide[] {
  return canvasGuides.filter((g) => (g === guide ? !guides.includes(g) : guides.includes(g)));
}

// The selection is view state (a `@State` of PreviewContainerView in Swift); one preview exists at a time.
const [overlays, setOverlays] = createSignal<CanvasOverlaySelection>(emptyCanvasOverlays);
export const canvasOverlays = overlays;
export const setCanvasOverlays = setOverlays;
