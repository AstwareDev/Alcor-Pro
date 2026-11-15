import { swiftRound } from "../util/math";
import {
  asObject, decodeEnum, getBool, getDouble, getWith, tryBool, tryDouble, tryEnum, tryString, tryWith,
} from "../util/jsonDecode";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function makeRGBA(p: Partial<RGBA> = {}): RGBA {
  return { r: p.r ?? 1, g: p.g ?? 1, b: p.b ?? 1, a: p.a ?? 1 };
}

/** Synthesized Codable: every key is required. */
export function decodeRGBA(json: unknown): RGBA {
  const c = asObject(json, "RGBA");
  return { r: getDouble(c, "r"), g: getDouble(c, "g"), b: getDouble(c, "b"), a: getDouble(c, "a") };
}

export function rgbaSetRGB(target: RGBA, from: RGBA): void {
  target.r = from.r;
  target.g = from.g;
  target.b = from.b;
}

export function rgbaHexString(c: RGBA): string {
  const bytes = [c.r, c.g, c.b, c.a].map((v) => swiftRound(Math.min(Math.max(v, 0), 1) * 255));
  return "#" + bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

/** `UInt8(_:radix: 16)` */
function parseHexByte(s: string): number | undefined {
  if (!/^[+-]?[0-9a-fA-F]+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 16);
  return n >= 0 && n <= 255 ? n : undefined;
}

/** Accepts `#RGB`, `#RRGGBB`, or `#RRGGBBAA`. Leading `#` optional. */
export function rgbaFromHex(hex: string): RGBA | undefined {
  let s = hex.trim();
  if (s.startsWith("#")) s = s.slice(1);
  const chars = Array.from(s);
  const component = (start: number, len: number): number | undefined => {
    const slice = chars.slice(start, start + len).join("");
    const n = parseHexByte(len === 1 ? slice + slice : slice);
    return n === undefined ? undefined : n / 255.0;
  };
  switch (chars.length) {
    case 3: {
      const r = component(0, 1), g = component(1, 1), b = component(2, 1);
      return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b, a: 1 };
    }
    case 6: {
      const r = component(0, 2), g = component(2, 2), b = component(4, 2);
      return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b, a: 1 };
    }
    case 8: {
      const r = component(0, 2), g = component(2, 2), b = component(4, 2), a = component(6, 2);
      return r === undefined || g === undefined || b === undefined || a === undefined ? undefined : { r, g, b, a };
    }
    default:
      return undefined;
  }
}

export const textAlignments = ["left", "center", "right"] as const;
export type TextAlignment = (typeof textAlignments)[number];

export const fontCases = ["mixed", "uppercase", "lowercase"] as const;
export type FontCase = (typeof fontCases)[number];

const fontCaseLabels: Record<FontCase, string> = { mixed: "Mixed", uppercase: "UPPERCASE", lowercase: "lowercase" };

export function fontCaseLabel(c: FontCase): string {
  return fontCaseLabels[c];
}

export function fontCaseApply(c: FontCase, text: string): string {
  switch (c) {
    case "mixed": return text;
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
  }
}

export interface TextShadow {
  enabled: boolean;
  /** Alpha doubles as opacity. */
  color: RGBA;
  /** Canvas points; scaled at render time. */
  offsetX: number;
  offsetY: number;
  blur: number;
}

export function makeTextShadow(p: Partial<TextShadow> = {}): TextShadow {
  return {
    enabled: p.enabled ?? false,
    color: p.color ?? makeRGBA({ r: 0, g: 0, b: 0, a: 0.6 }),
    offsetX: p.offsetX ?? 0,
    offsetY: p.offsetY ?? -2,
    blur: p.blur ?? 6,
  };
}

/** Synthesized Codable: every key is required. */
export function decodeTextShadow(json: unknown): TextShadow {
  const c = asObject(json, "Shadow");
  return {
    enabled: getBool(c, "enabled"),
    color: getWith(c, "color", decodeRGBA),
    offsetX: getDouble(c, "offsetX"),
    offsetY: getDouble(c, "offsetY"),
    blur: getDouble(c, "blur"),
  };
}

export interface TextOutline {
  enabled: boolean;
  color: RGBA;
  /** Width in reference-canvas points. */
  width: number;
}

export function makeTextOutline(p: Partial<TextOutline> = {}): TextOutline {
  return {
    enabled: p.enabled ?? false,
    color: p.color ?? makeRGBA({ r: 0, g: 0, b: 0, a: 1 }),
    width: p.width ?? 4,
  };
}

export function decodeTextOutline(json: unknown): TextOutline {
  const c = asObject(json, "Outline");
  return makeTextOutline({
    enabled: tryBool(c, "enabled"),
    color: tryWith(c, "color", decodeRGBA),
    width: tryDouble(c, "width"),
  });
}

export interface TextBackground {
  enabled: boolean;
  color: RGBA;
  paddingX: number;
  paddingY: number;
  cornerRadius: number;
  offsetX: number;
  offsetY: number;
  outlineColor: RGBA;
  outlineWidth: number;
}

export function makeTextBackground(p: Partial<TextBackground> = {}): TextBackground {
  return {
    enabled: p.enabled ?? false,
    color: p.color ?? makeRGBA({ r: 0, g: 0, b: 0, a: 0.6 }),
    paddingX: p.paddingX ?? 0,
    paddingY: p.paddingY ?? 0,
    cornerRadius: p.cornerRadius ?? 0,
    offsetX: p.offsetX ?? 0,
    offsetY: p.offsetY ?? 0,
    outlineColor: p.outlineColor ?? makeRGBA({ r: 0, g: 0, b: 0, a: 1 }),
    outlineWidth: p.outlineWidth ?? 0,
  };
}

export function decodeTextBackground(json: unknown): TextBackground {
  const c = asObject(json, "Background");
  return makeTextBackground({
    enabled: tryBool(c, "enabled"),
    color: tryWith(c, "color", decodeRGBA),
    paddingX: tryDouble(c, "paddingX"),
    paddingY: tryDouble(c, "paddingY"),
    cornerRadius: tryDouble(c, "cornerRadius"),
    offsetX: tryDouble(c, "offsetX"),
    offsetY: tryDouble(c, "offsetY"),
    outlineColor: tryWith(c, "outlineColor", decodeRGBA),
    outlineWidth: tryDouble(c, "outlineWidth"),
  });
}

export interface TextStyle {
  fontName: string;
  fontSize: number;
  fontScale: number;
  widthScale: number;
  heightScale: number;
  tracking: number;
  lineSpacing: number;
  fontCase: FontCase;
  isBold: boolean;
  isItalic: boolean;
  isUnderlined: boolean;
  isStruckThrough: boolean;
  isOverlined: boolean;
  color: RGBA;
  alignment: TextAlignment;
  blur: number;
  shadow: TextShadow;
  background: TextBackground;
  border: TextOutline;
}

export const textStyleAxisScaleRange = { min: 0.1, max: 10.0 } as const;

export function makeTextStyle(p: Partial<TextStyle> = {}): TextStyle {
  return {
    fontName: p.fontName ?? "Helvetica",
    fontSize: p.fontSize ?? 96,
    fontScale: p.fontScale ?? 1.0,
    widthScale: p.widthScale ?? 1.0,
    heightScale: p.heightScale ?? 1.0,
    tracking: p.tracking ?? 0,
    lineSpacing: p.lineSpacing ?? 0,
    fontCase: p.fontCase ?? "mixed",
    isBold: p.isBold ?? false,
    isItalic: p.isItalic ?? false,
    isUnderlined: p.isUnderlined ?? false,
    isStruckThrough: p.isStruckThrough ?? false,
    isOverlined: p.isOverlined ?? false,
    color: p.color ?? makeRGBA(),
    alignment: p.alignment ?? "center",
    blur: p.blur ?? 0,
    shadow: p.shadow ?? makeTextShadow(),
    background: p.background ?? makeTextBackground(),
    border: p.border ?? makeTextOutline(),
  };
}

export function textStyleCaption(): TextStyle {
  return makeTextStyle({ fontSize: 48 /* AppTheme.Caption.defaultFontSize */ });
}

/**
 * Swift infers bold/italic from the installed font's CoreText symbolic traits (NSFont(name:)).
 * No font database here, so approximate from the PostScript/family name.
 */
function inferredTraits(fontName: string): { bold: boolean; italic: boolean } {
  const n = fontName.toLowerCase();
  return { bold: n.includes("bold"), italic: n.includes("italic") || n.includes("oblique") };
}

/** Missing-key-tolerant decode — older files pick up defaults for fields added later. */
export function decodeTextStyle(json: unknown): TextStyle {
  const c = asObject(json, "TextStyle");
  const d = makeTextStyle();
  const fontName = tryString(c, "fontName") ?? d.fontName;
  const fontSize = tryDouble(c, "fontSize") ?? d.fontSize;
  const traits = inferredTraits(fontName);
  return {
    fontName,
    fontSize,
    fontScale: tryDouble(c, "fontScale") ?? d.fontScale,
    widthScale: tryDouble(c, "widthScale") ?? d.widthScale,
    heightScale: tryDouble(c, "heightScale") ?? d.heightScale,
    tracking: tryDouble(c, "tracking") ?? d.tracking,
    lineSpacing: tryDouble(c, "lineSpacing") ?? d.lineSpacing,
    fontCase: tryEnum(c, "fontCase", fontCases) ?? d.fontCase,
    isBold: tryBool(c, "isBold") ?? traits.bold,
    isItalic: tryBool(c, "isItalic") ?? traits.italic,
    isUnderlined: tryBool(c, "isUnderlined") ?? d.isUnderlined,
    isStruckThrough: tryBool(c, "isStruckThrough") ?? d.isStruckThrough,
    isOverlined: tryBool(c, "isOverlined") ?? d.isOverlined,
    color: tryWith(c, "color", decodeRGBA) ?? d.color,
    alignment: tryEnum(c, "alignment", textAlignments) ?? d.alignment,
    blur: tryDouble(c, "blur") ?? d.blur,
    shadow: tryWith(c, "shadow", decodeTextShadow) ?? d.shadow,
    background: tryWith(c, "background", decodeTextBackground) ?? d.background,
    border: tryWith(c, "border", decodeTextOutline) ?? d.border,
  };
}

export function decodeTextAlignment(json: unknown): TextAlignment {
  return decodeEnum(json, textAlignments, "TextStyle.Alignment");
}

export function decodeFontCase(json: unknown): FontCase {
  return decodeEnum(json, fontCases, "TextStyle.FontCase");
}

export function cloneTextStyle(s: TextStyle): TextStyle {
  return {
    ...s,
    color: { ...s.color },
    shadow: { ...s.shadow, color: { ...s.shadow.color } },
    background: { ...s.background, color: { ...s.background.color }, outlineColor: { ...s.background.outlineColor } },
    border: { ...s.border, color: { ...s.border.color } },
  };
}

export function textStyleScaledVisualStyle(s: TextStyle): TextStyle {
  if (s.fontScale === 1) return s;
  const k = s.fontScale;
  const style = cloneTextStyle(s);
  style.fontSize *= k;
  style.tracking *= k;
  style.lineSpacing *= k;
  style.shadow.offsetX *= k;
  style.shadow.offsetY *= k;
  style.shadow.blur *= k;
  style.border.width *= k;
  style.background.paddingX *= k;
  style.background.paddingY *= k;
  style.background.cornerRadius *= k;
  style.background.offsetX *= k;
  style.background.offsetY *= k;
  style.background.outlineWidth *= k;
  style.fontScale = 1;
  return style;
}

export function textStyleDisplayText(s: TextStyle, text: string): string {
  return fontCaseApply(s.fontCase, text);
}

/** Two-pass outlines need an opaque fill; translucent fills would show the undercoat through them. */
export function textStyleDrawsGlyphOutline(s: TextStyle): boolean {
  return s.border.enabled && s.border.width > 0 && s.color.a >= 1;
}

export function textStyleGlyphBorderPadding(s: TextStyle, fontSize: number): number {
  return Math.ceil((fontSize * Math.max(0, s.border.width)) / Math.max(1, s.fontSize * s.fontScale));
}
