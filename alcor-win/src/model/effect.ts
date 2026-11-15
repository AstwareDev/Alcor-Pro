import { newId } from "../util/id";
import {
  asObject, decodeDouble, decodeRecord, optDouble, optString, optWith, tryBool, tryString, tryWith, getString,
} from "../util/jsonDecode";
import { decodeKeyframeTrack, doubleInterpolator, keyframeTrackIsActive, keyframeTrackSample, type KeyframeTrack } from "./keyframe";

/** A single effect parameter */
export interface EffectParam {
  value?: number;
  string?: string;
  track?: KeyframeTrack<number>;
}

export function makeEffectParam(p: Partial<EffectParam> = {}): EffectParam {
  const out: EffectParam = {};
  if (p.value !== undefined) out.value = p.value;
  if (p.string !== undefined) out.string = p.string;
  if (p.track !== undefined) out.track = p.track;
  return out;
}

export function decodeEffectParam(json: unknown): EffectParam {
  const c = asObject(json, "EffectParam");
  return makeEffectParam({
    value: optDouble(c, "value"),
    string: optString(c, "string"),
    track: optWith(c, "track", (v) => decodeKeyframeTrack(v, decodeDouble)),
  });
}

/** Effective numeric value at a clip-relative frame offset. */
export function effectParamResolved(param: EffectParam, offset: number, defaultValue: number): number {
  const track = param.track;
  if (track && keyframeTrackIsActive(track)) {
    return keyframeTrackSample(track, offset, param.value ?? defaultValue, doubleInterpolator);
  }
  return param.value ?? defaultValue;
}

/** One entry in a clip's ordered effect stack */
export interface Effect {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, EffectParam>;
}

export function makeEffect(p: Partial<Effect> & { type: string }): Effect {
  return { id: p.id ?? newId(), type: p.type, enabled: p.enabled ?? true, params: p.params ?? {} };
}

/** Convenience for static numeric params (`Effect.make`). */
export function makeStaticEffect(type: string, values: Record<string, number> = {}): Effect {
  const params: Record<string, EffectParam> = {};
  for (const [k, v] of Object.entries(values)) params[k] = makeEffectParam({ value: v });
  return makeEffect({ type, params });
}

export function decodeEffect(json: unknown): Effect {
  const c = asObject(json, "Effect");
  const type = getString(c, "type");
  return {
    id: tryString(c, "id") ?? newId(),
    type,
    enabled: tryBool(c, "enabled") ?? true,
    params: tryWith(c, "params", (v) => decodeRecord(v, decodeEffectParam, "params")) ?? {},
  };
}

/** Canonical order the always-on adjustment sections insert their effects in (EffectRegistry.canonicalOrder). */
export const effectCanonicalOrder: readonly string[] = [
  "color.exposure", "color.contrast", "color.highlightsShadows", "color.blacksWhites",
  "color.temperature", "color.vibrance", "color.saturation", "color.wheels", "color.curves",
  "color.hueCurves", "color.lut", "detail.clarity", "key.chroma", "blur.gaussian", "blur.sharpen",
  "blur.noiseReduction", "blur.motion", "stylize.invert", "stylize.grain", "stylize.vignette",
  "stylize.glow",
];

function canonicalRank(type: string): number {
  const i = effectCanonicalOrder.indexOf(type);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** `EffectRegistry.insertIndex` */
export function effectInsertIndex(effects: readonly Effect[], id: string): number {
  const rank = canonicalRank(id);
  const i = effects.findIndex((e) => canonicalRank(e.type) > rank);
  return i < 0 ? effects.length : i;
}
