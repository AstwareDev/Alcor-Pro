import { makeRGBA, rgbaFromHex, rgbaHexString, type RGBA } from "../model";

export interface HSV {
  /** 0...1 */
  h: number;
  s: number;
  v: number;
}

export function rgbToHsv(c: RGBA): HSV {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv: HSV, a = 1): RGBA {
  const h = (hsv.h - Math.floor(hsv.h)) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = hsv.v * (1 - hsv.s);
  const q = hsv.v * (1 - f * hsv.s);
  const t = hsv.v * (1 - (1 - f) * hsv.s);
  const table: [number, number, number][] = [
    [hsv.v, t, p], [q, hsv.v, p], [p, hsv.v, t], [p, q, hsv.v], [t, p, hsv.v], [hsv.v, p, q],
  ];
  const [r, g, b] = table[i % 6] as [number, number, number];
  return makeRGBA({ r, g, b, a });
}

/** CSS color string for an RGBA value. */
export function rgbaCss(c: RGBA): string {
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${byte(c.r)} ${byte(c.g)} ${byte(c.b)} / ${Math.min(1, Math.max(0, c.a))})`;
}

/** `#RRGGBB` (or `#RRGGBBAA` when `withAlpha`). */
export function hexText(c: RGBA, withAlpha: boolean): string {
  const full = rgbaHexString(c);
  return withAlpha ? full : full.slice(0, 7);
}

/** Parses typed hex; alpha is kept from `base` unless the text carries one and `withAlpha` is set. */
export function parseHexInput(text: string, base: RGBA, withAlpha: boolean): RGBA | undefined {
  const parsed = rgbaFromHex(text);
  if (!parsed) return undefined;
  const hasAlphaDigits = text.trim().replace(/^#/, "").length === 8;
  return makeRGBA({ r: parsed.r, g: parsed.g, b: parsed.b, a: withAlpha && hasAlphaDigits ? parsed.a : base.a });
}
