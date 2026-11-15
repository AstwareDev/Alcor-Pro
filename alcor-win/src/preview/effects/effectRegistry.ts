import { effectParamResolved, makeEffect, makeEffectParam, type Effect } from "../../model/effect";

export interface EffectParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  unit: string;
}

/** Numeric/string param values resolved for one frame */
export interface ResolvedEffectParams {
  values: Record<string, number>;
  strings: Record<string, string>;
  /** Clip-relative frame offset, for effects that animate (grain). */
  frame: number;
  spatialScale: number;
}

export function makeResolvedEffectParams(p: Partial<ResolvedEffectParams> = {}): ResolvedEffectParams {
  return { values: p.values ?? {}, strings: p.strings ?? {}, frame: p.frame ?? 0, spatialScale: p.spatialScale ?? 1 };
}

export function resolvedValue(p: ResolvedEffectParams, key: string): number {
  return p.values[key] ?? 0;
}

export interface EffectDescriptor {
  id: string;
  displayName: string;
  category: string;
  params: readonly EffectParamSpec[];
  /** Swift wraps the effect in sRGB->linear / linear->sRGB (only exposure). */
  linearizes: boolean;
  /** Param key of the file resource (LUT path); drives the inspector row. */
  resourceKey?: string;
}

function spec(key: string, label: string, min: number, max: number, defaultValue: number, unit = ""): EffectParamSpec {
  return { key, label, min, max, defaultValue, unit };
}

function descriptor(
  id: string, displayName: string, category: string, params: EffectParamSpec[],
  extra: { linearizes?: boolean; resourceKey?: string } = {},
): EffectDescriptor {
  const d: EffectDescriptor = { id, displayName, category, params, linearizes: extra.linearizes ?? false };
  if (extra.resourceKey !== undefined) d.resourceKey = extra.resourceKey;
  return d;
}

const color: EffectDescriptor[] = [
  descriptor("color.exposure", "Exposure", "Color", [spec("ev", "Exposure", -3, 3, 0)], { linearizes: true }),
  descriptor("color.contrast", "Contrast", "Color", [spec("amount", "Contrast", 0.5, 1.5, 1)]),
  descriptor("color.saturation", "Saturation", "Color", [spec("amount", "Saturation", 0, 2, 1)]),
  descriptor("color.temperature", "Temperature & Tint", "Color", [
    spec("temperature", "Temperature", 2000, 11000, 6500, "K"),
    spec("tint", "Tint", -100, 100, 0),
  ]),
  descriptor("color.highlightsShadows", "Highlights & Shadows", "Color", [
    spec("highlights", "Highlights", -1, 1, 0),
    spec("shadows", "Shadows", -1, 1, 0),
  ]),
  descriptor("color.blacksWhites", "Levels", "Color", [
    spec("blacks", "Blacks", -1, 1, 0),
    spec("whites", "Whites", -1, 1, 0),
  ]),
  descriptor("color.vibrance", "Vibrance", "Color", [spec("amount", "Vibrance", -1, 1, 0)]),
];

const wheels: EffectDescriptor[] = [
  descriptor("color.wheels", "Color Wheels", "Color", [
    spec("lift_x", "Lift", -1, 1, 0),
    spec("lift_y", "Lift", -1, 1, 0),
    spec("lift_m", "Lift", -0.5, 0.5, 0),
    spec("gamma_x", "Gamma", -1, 1, 0),
    spec("gamma_y", "Gamma", -1, 1, 0),
    spec("gamma_m", "Gamma", 0.5, 2, 1),
    spec("gain_x", "Gain", -1, 1, 0),
    spec("gain_y", "Gain", -1, 1, 0),
    spec("gain_m", "Gain", 0.5, 1.5, 1),
  ]),
];

const hueCurves: EffectDescriptor[] = [descriptor("color.hueCurves", "Hue Curves", "Color", [])];

const lut: EffectDescriptor[] = [
  descriptor("color.lut", "LUT", "Color", [spec("intensity", "Intensity", 0, 1, 1)], { resourceKey: "path" }),
];

const curves: EffectDescriptor[] = [descriptor("color.curves", "Curves", "Color", [])];

const blur: EffectDescriptor[] = [
  descriptor("blur.gaussian", "Gaussian Blur", "Blur & Sharpen", [spec("radius", "Radius", 0, 100, 8, "px")]),
  descriptor("blur.sharpen", "Sharpen", "Blur & Sharpen", [spec("amount", "Sharpness", 0, 2, 0.4)]),
  descriptor("blur.noiseReduction", "Noise Reduction", "Blur & Sharpen", [spec("amount", "Noise Reduction", 0, 1, 0)]),
  descriptor("blur.motion", "Motion Blur", "Blur & Sharpen", [
    spec("radius", "Motion Blur", 0, 100, 0, "px"),
    spec("angle", "Angle", -180, 180, 0, "°"),
  ]),
];

const stylize: EffectDescriptor[] = [
  descriptor("stylize.invert", "Invert", "Stylize", []),
  descriptor("stylize.grain", "Film Grain", "Stylize", [
    spec("amount", "Amount", 0, 1, 0),
    spec("size", "Size", 0.5, 4, 1.5),
  ]),
  descriptor("stylize.vignette", "Vignette", "Stylize", [
    spec("amount", "Amount", -1, 1, 0),
    spec("midpoint", "Midpoint", 0, 1, 0.5),
    spec("roundness", "Roundness", -1, 1, 0),
    spec("feather", "Feather", 0, 1, 0.5),
  ]),
  descriptor("stylize.glow", "Glow", "Stylize", [
    spec("intensity", "Glow", 0, 1, 0),
    spec("radius", "Radius", 0, 100, 20, "px"),
    spec("threshold", "Threshold", 0, 1, 0.6),
    spec("warmth", "Warmth", 0, 1, 0),
  ]),
];

const detail: EffectDescriptor[] = [
  descriptor("detail.clarity", "Clarity & Haze", "Detail", [
    spec("clarity", "Clarity", -1, 1, 0),
    spec("dehaze", "Dehaze", -1, 1, 0),
  ]),
];

const key: EffectDescriptor[] = [
  descriptor("key.chroma", "Chroma Key", "Key", [
    spec("keyHue", "Key Hue", 0, 1, 0.333),
    spec("tolerance", "Tolerance", 0, 1, 0),
    spec("softness", "Softness", 0, 1, 0.1),
    spec("spill", "Spill", 0, 1, 0.5),
  ]),
];

export const effectRegistryAll: readonly EffectDescriptor[] = [
  ...color, ...wheels, ...hueCurves, ...lut, ...curves, ...detail, ...blur, ...stylize, ...key,
];

const byId = new Map(effectRegistryAll.map((d) => [d.id, d]));

export function effectDescriptor(id: string): EffectDescriptor | undefined {
  return byId.get(id);
}

/** `EffectDescriptor.makeEffect`: default Effect instance for "Add Effect". */
export function effectDescriptorMakeEffect(d: EffectDescriptor): Effect {
  const params: Effect["params"] = {};
  for (const s of d.params) params[s.key] = makeEffectParam({ value: s.defaultValue });
  return makeEffect({ type: d.id, params });
}

/** `EffectDescriptor.resolve`: keyframe-aware values clamped to each spec's range. */
export function effectDescriptorResolve(
  d: EffectDescriptor, effect: Effect, offset: number, spatialScale = 1,
): ResolvedEffectParams {
  const values: Record<string, number> = {};
  for (const s of d.params) {
    const p = effect.params[s.key];
    const raw = p ? effectParamResolved(p, offset, s.defaultValue) : s.defaultValue;
    values[s.key] = Math.min(s.max, Math.max(s.min, raw));
  }
  const strings: Record<string, string> = {};
  for (const [k, p] of Object.entries(effect.params)) if (p.string !== undefined) strings[k] = p.string;
  return { values, strings, frame: offset, spatialScale };
}
