// Versioned preset document format shared by built-in content and downloadable packs.
// { "format": "alcor-preset", "version": 1, "presets": [ ... ] }; each preset has a `kind` discriminator.
import {
  decodeTextAnimation, decodeTextFillMode, decodeTextStyle, makeTextStyle, rgbaFromHex, textAnimationPresets,
  textFillModes, type RGBA, type TextAnimation, type TextFillMode, type TextStyle,
} from "../model";
import { asObject, DecodingError, tryString, type JsonObject } from "../util/jsonDecode";
import { effectDescriptor } from "../preview/effects/effectRegistry";

export const presetFormatName = "alcor-preset";
export const presetFormatVersion = 1;

export const presetKinds = ["look", "textStyle", "textAnimation", "title", "effect"] as const;
export type PresetKind = (typeof presetKinds)[number];

/** One effect of a look/effect preset. `resource` is a LUT file: pack-relative (`luts/a.cube`) or absolute. */
export interface PresetEffect {
  type: string;
  params: Record<string, number>;
  resource?: string;
}

export interface PresetBase {
  id: string;
  name: string;
  category: string;
  tags: string[];
}

export interface LookPreset extends PresetBase { kind: "look"; effects: PresetEffect[] }
export interface EffectPreset extends PresetBase { kind: "effect"; effects: PresetEffect[] }
export interface TextStylePreset extends PresetBase { kind: "textStyle"; style: TextStyle; fillMode?: TextFillMode }
export interface TextAnimationPreset extends PresetBase { kind: "textAnimation"; animation: TextAnimation }

/** Normalised (0...1) canvas position of a title item's centre; the box itself is auto-fitted to the text. */
export interface TitleBox { centerX: number; centerY: number }

export interface TitleItem {
  text: string;
  style: TextStyle;
  fillMode?: TextFillMode;
  animation?: TextAnimation;
  /** Absent = auto-fit to the content and centred. */
  box?: TitleBox;
  /** Lane (0 = first new track, which ends up on top). */
  layer: number;
  startOffsetSeconds: number;
  /** Absent = until the end of the title. */
  durationSeconds?: number;
}

export interface TitlePreset extends PresetBase { kind: "title"; durationSeconds: number; items: TitleItem[] }

export type Preset = LookPreset | EffectPreset | TextStylePreset | TextAnimationPreset | TitlePreset;

export interface PresetDocument {
  format: typeof presetFormatName;
  version: number;
  presets: Preset[];
}

export interface DecodeResult {
  presets: Preset[];
  warnings: string[];
}

function str(o: JsonObject, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw new DecodingError(`${ctx}: "${key}" must be a non-empty string`);
  return v;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function decodeEffects(raw: unknown, ctx: string, warnings: string[]): PresetEffect[] {
  if (!Array.isArray(raw)) throw new DecodingError(`${ctx}: "effects" must be an array`);
  const out: PresetEffect[] = [];
  for (const item of raw) {
    const o = asObject(item, `${ctx} effect`);
    const type = str(o, "type", ctx);
    const descriptor = effectDescriptor(type);
    if (!descriptor) {
      warnings.push(`${ctx}: unknown effect "${type}" skipped`);
      continue;
    }
    const params: Record<string, number> = {};
    const rawParams = o["params"] === undefined ? {} : asObject(o["params"], `${ctx} params`);
    for (const [key, value] of Object.entries(rawParams)) {
      const spec = descriptor.params.find((s) => s.key === key);
      if (!spec || typeof value !== "number" || !Number.isFinite(value)) {
        warnings.push(`${ctx}: ignored parameter "${type}.${key}"`);
        continue;
      }
      params[key] = Math.min(spec.max, Math.max(spec.min, value));
    }
    const effect: PresetEffect = { type, params };
    const resource = tryString(o, "resource");
    if (resource !== undefined && descriptor.resourceKey !== undefined) effect.resource = resource;
    out.push(effect);
  }
  return out;
}

function decodeFill(o: JsonObject): TextFillMode | undefined {
  const raw = o["fillMode"];
  if (typeof raw !== "string") return undefined;
  return (textFillModes as readonly string[]).includes(raw) ? decodeTextFillMode(raw) : undefined;
}

function decodeAnimation(raw: unknown, ctx: string, warnings: string[]): TextAnimation | undefined {
  if (raw === undefined) return undefined;
  const o = asObject(raw, `${ctx} animation`);
  const preset = o["preset"];
  if (typeof preset !== "string" || !(textAnimationPresets as readonly string[]).includes(preset)) {
    warnings.push(`${ctx}: unknown text animation "${String(preset)}" skipped`);
    return undefined;
  }
  return decodeTextAnimation(o);
}

function decodeBox(raw: unknown): TitleBox | undefined {
  if (raw === undefined) return undefined;
  const o = asObject(raw, "box");
  return { centerX: Math.min(1, Math.max(0, num(o["centerX"], 0.5))), centerY: Math.min(1, Math.max(0, num(o["centerY"], 0.5))) };
}

function decodeTitleItem(raw: unknown, ctx: string, warnings: string[]): TitleItem {
  const o = asObject(raw, `${ctx} item`);
  const item: TitleItem = {
    text: typeof o["text"] === "string" ? o["text"] : "Title",
    style: o["style"] === undefined ? makeTextStyle() : decodeTextStyle(o["style"]),
    layer: Math.max(0, Math.trunc(num(o["layer"], 0))),
    startOffsetSeconds: Math.max(0, num(o["startOffsetSeconds"], 0)),
  };
  const fill = decodeFill(o);
  if (fill !== undefined) item.fillMode = fill;
  const animation = decodeAnimation(o["animation"], ctx, warnings);
  if (animation) item.animation = animation;
  const box = decodeBox(o["box"]);
  if (box) item.box = box;
  const d = o["durationSeconds"];
  if (typeof d === "number" && d > 0) item.durationSeconds = d;
  return item;
}

/** Decodes one preset. Throws `DecodingError` when it is unusable; recoverable issues become warnings. */
export function decodePreset(json: unknown, warnings: string[] = []): Preset {
  const o = asObject(json, "preset");
  const id = str(o, "id", "preset");
  const name = str(o, "name", id);
  const kind = o["kind"];
  if (typeof kind !== "string" || !(presetKinds as readonly string[]).includes(kind)) {
    throw new DecodingError(`${id}: unknown preset kind "${String(kind)}"`);
  }
  const base: PresetBase = {
    id,
    name,
    category: typeof o["category"] === "string" ? o["category"] : "General",
    tags: Array.isArray(o["tags"]) ? o["tags"].filter((t): t is string => typeof t === "string") : [],
  };
  switch (kind as PresetKind) {
    case "look":
    case "effect": {
      const effects = decodeEffects(o["effects"], id, warnings);
      if (effects.length === 0) throw new DecodingError(`${id}: has no usable effects`);
      return { ...base, kind: kind as "look" | "effect", effects };
    }
    case "textStyle": {
      const preset: TextStylePreset = { ...base, kind: "textStyle", style: decodeTextStyle(o["style"] ?? {}) };
      const fill = decodeFill(o);
      if (fill !== undefined) preset.fillMode = fill;
      return preset;
    }
    case "textAnimation": {
      const animation = decodeAnimation(o["animation"], id, warnings);
      if (!animation) throw new DecodingError(`${id}: has no valid animation`);
      return { ...base, kind: "textAnimation", animation };
    }
    case "title": {
      const items = Array.isArray(o["items"]) ? o["items"].map((i) => decodeTitleItem(i, id, warnings)) : [];
      if (items.length === 0) throw new DecodingError(`${id}: has no items`);
      return { ...base, kind: "title", durationSeconds: Math.max(0.5, num(o["durationSeconds"], 4)), items };
    }
  }
}

/** Decodes a preset document; bad presets are skipped with a warning, a bad envelope throws. */
export function decodePresetDocument(json: unknown): DecodeResult {
  const o = asObject(json, "preset document");
  if (o["format"] !== presetFormatName) throw new DecodingError(`not an ${presetFormatName} document`);
  const version = o["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new DecodingError("invalid preset format version");
  if (version > presetFormatVersion) {
    throw new DecodingError(`preset format version ${version} is newer than this app supports (${presetFormatVersion})`);
  }
  if (!Array.isArray(o["presets"])) throw new DecodingError('"presets" must be an array');
  const warnings: string[] = [];
  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const raw of o["presets"]) {
    try {
      const preset = decodePreset(raw, warnings);
      if (seen.has(preset.id)) {
        warnings.push(`duplicate preset id "${preset.id}" skipped`);
        continue;
      }
      seen.add(preset.id);
      presets.push(preset);
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { presets, warnings };
}

export function encodePresetDocument(presets: readonly Preset[]): PresetDocument {
  return { format: presetFormatName, version: presetFormatVersion, presets: [...presets] };
}

export function hexColor(hex: string): RGBA {
  const c = rgbaFromHex(hex);
  if (!c) throw new Error(`bad colour ${hex}`);
  return c;
}
