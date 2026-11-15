import {
  clipDenoiseEffectType,
  clipDefaultDenoiseAmount,
  effectInsertIndex,
  gradeCurveEncoded,
  gradeCurveFromJson,
  gradeCurveIsIdentity,
  makeEffect,
  makeEffectParam,
  makeGradeCurve,
  type Effect,
  type GradeCurve,
} from "../model";
import { effectDescriptor, effectDescriptorMakeEffect } from "../preview/effects/effectRegistry";
import type { Editor } from "../editor/editor";
import { mutateClips } from "../editor/mutations/clipMutations";
import { clearDenoiseFailure } from "../denoise/denoiseState";

/** Upsert one param into the singleton effect of its type; prune the effect when every param is back at default. */
export function upsertControl(effects: Effect[], effectId: string, paramKey: string, value: number): void {
  const descriptor = effectDescriptor(effectId);
  if (!descriptor) return;
  const i = effects.findIndex((e) => e.type === effectId);
  const existing = effects[i];
  if (existing) {
    existing.params[paramKey] = makeEffectParam({ value });
    const allDefault = descriptor.params.every((spec) => (existing.params[spec.key]?.value ?? spec.defaultValue) === spec.defaultValue);
    if (allDefault) effects.splice(i, 1);
  } else {
    const paramDefault = descriptor.params.find((s) => s.key === paramKey)?.defaultValue;
    if (value === paramDefault) return;
    const effect = effectDescriptorMakeEffect(descriptor);
    effect.params[paramKey] = makeEffectParam({ value });
    effects.splice(effectInsertIndex(effects, effectId), 0, effect);
  }
}

export function readGradeCurve(effects: readonly Effect[]): GradeCurve {
  const json = effects.find((e) => e.type === "color.curves")?.params["curve"]?.string;
  return (json === undefined ? undefined : gradeCurveFromJson(json)) ?? makeGradeCurve();
}

export function upsertCurve(effects: Effect[], curve: GradeCurve): void {
  const i = effects.findIndex((e) => e.type === "color.curves");
  if (gradeCurveIsIdentity(curve)) {
    if (i >= 0) effects.splice(i, 1);
    return;
  }
  const json = gradeCurveEncoded(curve);
  const existing = effects[i];
  if (existing) existing.params["curve"] = makeEffectParam({ string: json });
  else {
    const effect = makeEffect({ type: "color.curves" });
    effect.params["curve"] = makeEffectParam({ string: json });
    effects.splice(effectInsertIndex(effects, "color.curves"), 0, effect);
  }
}

export function setSectionEnabled(effects: Effect[], ids: ReadonlySet<string>, enabled: boolean): void {
  for (const e of effects) if (ids.has(e.type)) e.enabled = enabled;
}

export function removeEffects(effects: Effect[], ids: ReadonlySet<string>): void {
  for (let i = effects.length - 1; i >= 0; i--) if (ids.has((effects[i] as Effect).type)) effects.splice(i, 1);
}

export function setInvert(effects: Effect[], applied: boolean): void {
  const i = effects.findIndex((e) => e.type === "stylize.invert");
  if (applied) {
    const existing = effects[i];
    if (existing) existing.enabled = true;
    else {
      const d = effectDescriptor("stylize.invert");
      if (d) effects.splice(effectInsertIndex(effects, "stylize.invert"), 0, effectDescriptorMakeEffect(d));
    }
  } else if (i >= 0) effects.splice(i, 1);
}

export function setLutPath(effects: Effect[], path: string): void {
  const existing = effects.find((e) => e.type === "color.lut");
  if (existing) existing.params["path"] = makeEffectParam({ string: path });
  else {
    const effect = makeEffect({ type: "color.lut" });
    effect.params["path"] = makeEffectParam({ string: path });
    effects.splice(effectInsertIndex(effects, "color.lut"), 0, effect);
  }
}

/** `EditorViewModel.setDenoise`: re-enabling clears a failed bake, and pending bakes start in the background. */
export function setDenoise(editor: Editor, clipIds: ReadonlySet<string>, enabled: boolean, amount: number | undefined, actionName: string): void {
  if (enabled) for (const id of clipIds) { const ref = editor.clipFor(id)?.mediaRef; if (ref !== undefined) clearDenoiseFailure(ref); }
  const clamped = amount === undefined ? undefined : Math.min(1, Math.max(0, amount));
  mutateClips(editor, clipIds, actionName, (clip) => {
    const stack = clip.effects ? [...clip.effects] : [];
    const i = stack.findIndex((e) => e.type === clipDenoiseEffectType);
    const existing = stack[i];
    if (existing) {
      existing.enabled = enabled;
      if (clamped !== undefined) existing.params["amount"] = makeEffectParam({ value: clamped });
    } else if (enabled) {
      stack.push(makeEffect({ type: clipDenoiseEffectType, params: { amount: makeEffectParam({ value: clamped ?? clipDefaultDenoiseAmount }) } }));
    }
    if (stack.length === 0) delete clip.effects;
    else clip.effects = stack;
  });
}
