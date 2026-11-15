import { swiftRound } from "../util/math";

// Pure logic behind ScrubbableNumberField (port of its static helpers and drag maths).

export interface NumberRange {
  min: number;
  max: number;
}

export function clampToRange(value: number, range: NumberRange): number {
  return Math.min(Math.max(value, range.min), range.max);
}

/** C `printf("%.Nf")` for the formats the inspector uses (`%.0f`, `%.1f`, `%.2f`); ties round to even like libc. */
export function formatFixed(format: string, value: number): string {
  const match = /^%\.(\d+)f$/.exec(format);
  const digits = match ? Number(match[1]) : 0;
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  const scaled = Math.abs(value) * 10 ** digits;
  const floor = Math.floor(scaled);
  const exactTie = scaled - floor === 0.5;
  let text = exactTie && floor % 2 === 0 ? floorToFixed(floor, digits) : Math.abs(value).toFixed(digits);
  if (value < 0 || Object.is(value, -0)) text = "-" + text;
  return text;
}

function floorToFixed(scaledInteger: number, digits: number): string {
  return (scaledInteger / 10 ** digits).toFixed(digits);
}

/** Port of `committedValue(from:suffix:displayMultiplier:range:)`; undefined when the text is not a finite number. */
export function committedValue(
  text: string,
  suffix: string,
  displayMultiplier: number,
  range: NumberRange,
): number | undefined {
  const trimmed = text.trim();
  const withoutSuffix = suffix !== "" && trimmed.endsWith(suffix) ? trimmed.slice(0, trimmed.length - suffix.length) : trimmed;
  const cleaned = withoutSuffix.trim().replace(/,/g, ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  const mult = displayMultiplier === 0 ? 1 : displayMultiplier;
  if (!Number.isFinite(mult)) return undefined;
  const raw = parsed / mult;
  if (!Number.isFinite(raw)) return undefined;
  return clampToRange(raw, range);
}

export interface ScrubModifiers {
  shift: boolean;
  /** Command on macOS; Ctrl / Meta here. */
  fine: boolean;
}

/** Drag threshold in pixels before a press becomes a scrub. */
export const scrubThreshold = 3;

/** Value for a horizontal drag of `totalDx` pixels from `startValue` (shift x10, fine x0.1). */
export function scrubbedValue(
  startValue: number,
  totalDx: number,
  sensitivity: number,
  displayMultiplier: number,
  range: NumberRange,
  modifiers: ScrubModifiers,
  adjust: (candidate: number) => number = (v) => v,
): number {
  let sens = sensitivity;
  if (modifiers.shift) sens *= 10;
  if (modifiers.fine) sens *= 0.1;
  const mult = displayMultiplier === 0 ? 1 : displayMultiplier;
  const candidate = clampToRange(startValue + (totalDx * sens) / mult, range);
  return clampToRange(adjust(candidate), range);
}

/** Arrow-key step in model units: one display unit (x10 with shift, x0.1 with fine), scaled by drag sensitivity. */
export function arrowStep(sensitivity: number, displayMultiplier: number, modifiers: ScrubModifiers): number {
  let step = sensitivity;
  if (modifiers.shift) step *= 10;
  if (modifiers.fine) step *= 0.1;
  return step / (displayMultiplier === 0 ? 1 : displayMultiplier);
}

/** Port of `RotationSnap`. */
export const RotationSnap = {
  intervalDegrees: 90,
  toleranceDegrees: 4,
  adjusted(rotation: number): number {
    if (!Number.isFinite(rotation)) return rotation;
    const nearestAxis = swiftRound(rotation / 90) * 90;
    if (Math.abs(rotation - nearestAxis) > 4) return rotation;
    return nearestAxis === 0 ? 0 : nearestAxis;
  },
  isAxisAligned(rotation: number): boolean {
    return Number.isFinite(rotation) && rotation % 90 === 0;
  },
};

/** `sharedClipValue`: the common value, or undefined when the items disagree (mixed). */
export function sharedValue<T, V>(items: readonly T[], extract: (item: T) => V): V | undefined {
  const first = items[0];
  if (first === undefined) return undefined;
  const value = extract(first);
  for (let i = 1; i < items.length; i++) if (extract(items[i] as T) !== value) return undefined;
  return value;
}
