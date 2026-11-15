// Small constructors for hand-authoring built-in presets.
import {
  makeTextAnimation, makeTextOutline, makeTextBackground, makeTextShadow, makeTextStyle, type TextAnimation, type TextFillMode,
  type TextStyle,
} from "../../model";
import { hexColor, type EffectPreset, type LookPreset, type PresetEffect, type TextAnimationPreset, type TextStylePreset, type TitleItem, type TitlePreset } from "../presetFormat";

export const effect = (type: string, params: Record<string, number> = {}): PresetEffect => ({ type, params });

export const exposure = (ev: number): PresetEffect => effect("color.exposure", { ev });
export const contrast = (amount: number): PresetEffect => effect("color.contrast", { amount });
export const saturation = (amount: number): PresetEffect => effect("color.saturation", { amount });
export const vibrance = (amount: number): PresetEffect => effect("color.vibrance", { amount });
export const temperature = (kelvin: number, tint = 0): PresetEffect => effect("color.temperature", { temperature: kelvin, tint });
export const hiSh = (highlights: number, shadows: number): PresetEffect => effect("color.highlightsShadows", { highlights, shadows });
export const levels = (blacks: number, whites: number): PresetEffect => effect("color.blacksWhites", { blacks, whites });
export const clarity = (c: number, dehaze = 0): PresetEffect => effect("detail.clarity", { clarity: c, dehaze });
export const sharpen = (amount: number): PresetEffect => effect("blur.sharpen", { amount });
export const grain = (amount: number, size = 1.5): PresetEffect => effect("stylize.grain", { amount, size });
export const vignette = (amount: number, midpoint = 0.5, feather = 0.5, roundness = 0): PresetEffect =>
  effect("stylize.vignette", { amount, midpoint, roundness, feather });
export const glow = (intensity: number, radius = 20, threshold = 0.6, warmth = 0): PresetEffect =>
  effect("stylize.glow", { intensity, radius, threshold, warmth });
export const blur = (radius: number): PresetEffect => effect("blur.gaussian", { radius });
export const motionBlur = (radius: number, angle = 0): PresetEffect => effect("blur.motion", { radius, angle });
export const noiseReduction = (amount: number): PresetEffect => effect("blur.noiseReduction", { amount });
export const lut = (resource: string, intensity = 1): PresetEffect => ({ type: "color.lut", params: { intensity }, resource });

/** Wheel pad coordinate for a hue angle (degrees, 0 = red, 120 = green, 240 = blue) and strength 0...1. */
export function pad(hueDeg: number, strength: number): [number, number] {
  const a = (hueDeg * Math.PI) / 180;
  return [Number((Math.cos(a) * strength).toFixed(3)), Number((Math.sin(a) * strength).toFixed(3))];
}

export interface WheelSpec {
  lift?: [hue: number, strength: number];
  gamma?: [hue: number, strength: number];
  gain?: [hue: number, strength: number];
  liftM?: number;
  gammaM?: number;
  gainM?: number;
}

export function wheels(w: WheelSpec): PresetEffect {
  const params: Record<string, number> = {};
  const set = (name: "lift" | "gamma" | "gain", v: [number, number] | undefined): void => {
    if (!v) return;
    const [x, y] = pad(v[0], v[1]);
    params[`${name}_x`] = x;
    params[`${name}_y`] = y;
  };
  set("lift", w.lift);
  set("gamma", w.gamma);
  set("gain", w.gain);
  if (w.liftM !== undefined) params["lift_m"] = w.liftM;
  if (w.gammaM !== undefined) params["gamma_m"] = w.gammaM;
  if (w.gainM !== undefined) params["gain_m"] = w.gainM;
  return effect("color.wheels", params);
}

const base = (id: string, name: string, category: string, tags: string[]) => ({ id, name, category, tags });

export const look = (id: string, name: string, category: string, effects: PresetEffect[], tags: string[] = []): LookPreset =>
  ({ ...base(id, name, category, tags), kind: "look", effects });

export const effectPreset = (id: string, name: string, category: string, effects: PresetEffect[], tags: string[] = []): EffectPreset =>
  ({ ...base(id, name, category, tags), kind: "effect", effects });

export function textStyle(
  id: string, name: string, category: string, style: TextStyle, fillMode?: TextFillMode, tags: string[] = [],
): TextStylePreset {
  return { ...base(id, name, category, tags), kind: "textStyle", style, ...(fillMode ? { fillMode } : {}) };
}

export function animation(id: string, name: string, category: string, a: Partial<TextAnimation>, tags: string[] = []): TextAnimationPreset {
  return { ...base(id, name, category, tags), kind: "textAnimation", animation: makeTextAnimation(a) };
}

export function title(
  id: string, name: string, category: string, durationSeconds: number, items: Array<Partial<TitleItem> & { text: string; style: TextStyle }>,
  tags: string[] = [],
): TitlePreset {
  return {
    ...base(id, name, category, tags),
    kind: "title",
    durationSeconds,
    items: items.map((i) => ({ layer: 0, startOffsetSeconds: 0, ...i })),
  };
}

export const rgba = hexColor;
export const withAlpha = (hex: string, a: number) => ({ ...hexColor(hex), a });

/** Text style shorthand: colour as `#RRGGBB`. */
export function ts(p: {
  font?: string; size?: number; color?: string; bold?: boolean; italic?: boolean; caps?: boolean; tracking?: number;
  shadow?: { color?: string; alpha?: number; x?: number; y?: number; blur?: number };
  outline?: { color?: string; width?: number };
  box?: { color?: string; alpha?: number; px?: number; py?: number; radius?: number };
  align?: TextStyle["alignment"]; lineSpacing?: number; blur?: number;
}): TextStyle {
  return makeTextStyle({
    fontName: p.font ?? "Helvetica",
    fontSize: p.size ?? 96,
    color: hexColor(p.color ?? "#FFFFFF"),
    isBold: p.bold ?? false,
    isItalic: p.italic ?? false,
    fontCase: p.caps ? "uppercase" : "mixed",
    tracking: p.tracking ?? 0,
    alignment: p.align ?? "center",
    lineSpacing: p.lineSpacing ?? 0,
    blur: p.blur ?? 0,
    shadow: p.shadow
      ? makeTextShadow({
          enabled: true,
          color: withAlpha(p.shadow.color ?? "#000000", p.shadow.alpha ?? 0.6),
          offsetX: p.shadow.x ?? 0, offsetY: p.shadow.y ?? -3, blur: p.shadow.blur ?? 8,
        })
      : makeTextShadow(),
    border: p.outline ? makeTextOutline({ enabled: true, color: hexColor(p.outline.color ?? "#000000"), width: p.outline.width ?? 6 }) : makeTextOutline(),
    background: p.box
      ? makeTextBackground({
          enabled: true, color: withAlpha(p.box.color ?? "#000000", p.box.alpha ?? 0.7),
          paddingX: p.box.px ?? 24, paddingY: p.box.py ?? 12, cornerRadius: p.box.radius ?? 12,
        })
      : makeTextBackground(),
  });
}
