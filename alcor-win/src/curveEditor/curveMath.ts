import { cubicBezierEase } from "../util/cubicBezier";
import { easePresets, type BezierHandles, type Interpolation } from "../model/keyframe";

/** Value range shown vertically: handles may overshoot 0..1. */
export const plotYMin = -0.5;
export const plotYMax = 1.5;
export const handleYLimit = { min: -2, max: 3 } as const;

export interface CurvePreset {
  id: string;
  name: string;
  handles: BezierHandles;
}

export const curvePresets: readonly CurvePreset[] = [
  { id: "linear", name: "Linear", handles: [0, 0, 1, 1] },
  { id: "easeIn", name: "Ease in", handles: [...easePresets.easeIn] },
  { id: "easeOut", name: "Ease out", handles: [...easePresets.easeOut] },
  { id: "easeInOut", name: "Ease in and out", handles: [...easePresets.easeInOut] },
  { id: "snappy", name: "Snappy", handles: [0.7, 0, 0.3, 1] },
  { id: "overshoot", name: "Overshoot", handles: [0.34, 1.56, 0.64, 1] },
  { id: "anticipate", name: "Anticipate", handles: [0.36, -0.56, 0.64, 1] },
];

export function clampHandles(h: BezierHandles): BezierHandles {
  const cx = (v: number): number => Math.min(1, Math.max(0, v));
  const cy = (v: number): number => Math.min(handleYLimit.max, Math.max(handleYLimit.min, v));
  return [cx(h[0]), cy(h[1]), cx(h[2]), cy(h[3])];
}

export const handlesEqual = (a: BezierHandles, b: BezierHandles): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

/** The stored form of a curve: a named easing when it matches one exactly, else a custom bezier. */
export function interpolationForHandles(h: BezierHandles): { interpolation: Interpolation; bezier?: BezierHandles } {
  if (handlesEqual(h, [0, 0, 1, 1])) return { interpolation: "linear" };
  for (const name of ["easeIn", "easeOut", "easeInOut"] as const) {
    if (handlesEqual(h, easePresets[name])) return { interpolation: name };
  }
  return { interpolation: "bezier", bezier: h };
}

export interface PlotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalized (x in 0..1, y in value units) to pixel position inside the plot box. */
export function toPixel(box: PlotBox, x: number, y: number): { x: number; y: number } {
  return { x: box.x + x * box.width, y: box.y + ((plotYMax - y) / (plotYMax - plotYMin)) * box.height };
}

export function fromPixel(box: PlotBox, px: number, py: number): { x: number; y: number } {
  return { x: (px - box.x) / box.width, y: plotYMax - ((py - box.y) / box.height) * (plotYMax - plotYMin) };
}

/** Value curve as polyline points (pixels). */
export function valueCurvePoints(box: PlotBox, h: BezierHandles, steps = 48): string {
  let out = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = toPixel(box, t, cubicBezierEase(h[0], h[1], h[2], h[3], t));
    out += `${i === 0 ? "" : " "}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  return out;
}

/** Speed (slope of the value curve) as polyline points, scaled so the peak speed fills the plot height. */
export function speedCurvePoints(box: PlotBox, h: BezierHandles, steps = 48): string {
  const speeds: number[] = [];
  const dt = 1 / steps;
  let peak = 1e-6;
  for (let i = 0; i <= steps; i++) {
    const a = cubicBezierEase(h[0], h[1], h[2], h[3], Math.max(0, i * dt - dt / 2));
    const b = cubicBezierEase(h[0], h[1], h[2], h[3], Math.min(1, i * dt + dt / 2));
    const s = Math.abs((b - a) / (Math.min(1, i * dt + dt / 2) - Math.max(0, i * dt - dt / 2)));
    speeds.push(s);
    if (s > peak) peak = s;
  }
  let out = "";
  speeds.forEach((s, i) => {
    const x = box.x + (i / steps) * box.width;
    const y = box.y + box.height - (s / peak) * box.height * 0.9;
    out += `${i === 0 ? "" : " "}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return out;
}

export const cssCubicBezier = (h: BezierHandles): string => `cubic-bezier(${h[0]}, ${h[1]}, ${h[2]}, ${h[3]})`;
