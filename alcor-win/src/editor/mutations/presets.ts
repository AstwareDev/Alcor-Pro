import {
  clipSetTextFillMode, cloneTextStyle, effectInsertIndex, makeEffect, makeEffectParam, makeTrack, type Clip, type Effect, type TextMeasurer,
} from "../../model";
import { canvasTextMeasurer } from "../../preview/textRenderer";
import { effectDescriptor } from "../../preview/effects/effectRegistry";
import type {
  EffectPreset, LookPreset, PresetEffect, TextAnimationPreset, TextStylePreset, TitlePreset,
} from "../../library/presetFormat";
import { swiftRound } from "../../util/math";
import type { Editor } from "../editor";
import { fitTextClipToContent } from "./textFit";
import { placeTextClips, type TextClipSpec } from "./captions";

// Applies library presets (Looks, Effects, Text styles, Text animations, Titles) to the timeline. Every public
// function is one undo entry; unknown effect ids / params are skipped with a warning and never throw.

export interface PresetApplyOptions {
  /** Maps a preset effect's LUT `resource` to an absolute path; undefined = not installed (effect skipped). */
  resolveResource?: (resource: string) => string | undefined;
  measure?: TextMeasurer;
}

export interface PresetApplyResult {
  /** Clips (or created clips) the preset was applied to. */
  clipIds: string[];
  warnings: string[];
}

/** Effects a look owns: replacing a look removes these and leaves keying, blur, invert and denoise alone. */
export const lookManagedEffectTypes: ReadonlySet<string> = new Set([
  "color.exposure", "color.contrast", "color.highlightsShadows", "color.blacksWhites", "color.temperature",
  "color.vibrance", "color.saturation", "color.wheels", "color.curves", "color.hueCurves", "color.lut",
  "detail.clarity", "blur.sharpen", "stylize.grain", "stylize.vignette", "stylize.glow",
]);

function describe(preset: { name: string }): string {
  return preset.name;
}

/** Validated, fresh `Effect` instances for a preset (new ids every call). */
export function buildPresetEffects(
  effects: readonly PresetEffect[], options: PresetApplyOptions = {},
): { effects: Effect[]; warnings: string[] } {
  const out: Effect[] = [];
  const warnings: string[] = [];
  for (const spec of effects) {
    const descriptor = effectDescriptor(spec.type);
    if (!descriptor) {
      warnings.push(`Skipped unknown effect "${spec.type}".`);
      continue;
    }
    const params: Effect["params"] = {};
    for (const s of descriptor.params) {
      const raw = spec.params[s.key];
      params[s.key] = makeEffectParam({ value: Math.min(s.max, Math.max(s.min, raw ?? s.defaultValue)) });
    }
    for (const key of Object.keys(spec.params)) {
      if (!descriptor.params.some((s) => s.key === key)) warnings.push(`Ignored unknown parameter "${spec.type}.${key}".`);
    }
    if (descriptor.resourceKey !== undefined) {
      const path = spec.resource === undefined ? undefined : (options.resolveResource ? options.resolveResource(spec.resource) : spec.resource);
      if (path === undefined) {
        warnings.push(`Skipped "${descriptor.displayName}": its file is not installed.`);
        continue;
      }
      params[descriptor.resourceKey] = makeEffectParam({ string: path });
    }
    out.push(makeEffect({ type: spec.type, params }));
  }
  return { effects: out, warnings };
}

function targetClips(editor: Editor, ids: ReadonlySet<string>, accepts: (clip: Clip) => boolean): Clip[] {
  return editor.timeline.tracks.flatMap((t) => t.clips).filter((c) => ids.has(c.id) && accepts(c));
}

const visualClip = (c: Clip): boolean => c.mediaType !== "audio";
const textClip = (c: Clip): boolean => c.mediaType === "text";

/** Writes `stack` onto the clip (deleting the key when empty, so an unchanged clip stays unchanged). */
function writeStack(clip: Clip, stack: Effect[]): void {
  if (stack.length === 0) delete clip.effects;
  else clip.effects = stack;
}

function mergeStack(existing: readonly Effect[], fresh: readonly Effect[], mode: "replace" | "add"): Effect[] {
  const stack = existing.filter((e) => (mode === "replace" ? !lookManagedEffectTypes.has(e.type) : !fresh.some((f) => f.type === e.type)));
  for (const effect of fresh) stack.splice(effectInsertIndex(stack, effect.type), 0, structuredClone(effect));
  return stack;
}

/**
 * Applies a Look (replace: previous look-managed effects are removed, like CapCut's filters) or an Effect preset
 * (add: same-type effects are updated, others are kept) to the visual clips among `clipIds`.
 */
export function applyEffectPreset(
  editor: Editor, clipIds: ReadonlySet<string>, preset: LookPreset | EffectPreset, options: PresetApplyOptions = {},
): PresetApplyResult {
  const targets = targetClips(editor, clipIds, visualClip);
  const built = buildPresetEffects(preset.effects, options);
  if (targets.length === 0 || built.effects.length === 0) return { clipIds: [], warnings: built.warnings };
  const mode = preset.kind === "look" ? "replace" : "add";
  const ids = targets.map((c) => c.id);
  editor.perform(`Apply ${describe(preset)}`, () => {
    for (const clip of targetClips(editor, new Set(ids), visualClip)) writeStack(clip, mergeStack(clip.effects ?? [], built.effects, mode));
  });
  return { clipIds: ids, warnings: built.warnings };
}

/** Removes every look-managed effect from the visual clips among `clipIds` ("No filter"). */
export function removeLookFromClips(editor: Editor, clipIds: ReadonlySet<string>): string[] {
  const ids = targetClips(editor, clipIds, (c) => visualClip(c) && (c.effects ?? []).some((e) => lookManagedEffectTypes.has(e.type))).map((c) => c.id);
  if (ids.length === 0) return [];
  editor.perform("Remove Filter", () => {
    for (const clip of targetClips(editor, new Set(ids), visualClip)) {
      writeStack(clip, (clip.effects ?? []).filter((e) => !lookManagedEffectTypes.has(e.type)));
    }
  });
  return ids;
}

/**
 * Temporary, non-undoable application for hover previews. Returns a function that restores the previous stacks;
 * call it exactly once (extra calls are no-ops).
 */
export function beginEffectPresetPreview(
  editor: Editor, clipIds: ReadonlySet<string>, preset: LookPreset | EffectPreset, options: PresetApplyOptions = {},
): () => void {
  const targets = targetClips(editor, clipIds, visualClip);
  const built = buildPresetEffects(preset.effects, options);
  if (targets.length === 0 || built.effects.length === 0) return () => undefined;
  const mode = preset.kind === "look" ? "replace" : "add";
  const before = new Map<string, Effect[] | undefined>(targets.map((c) => [c.id, c.effects === undefined ? undefined : structuredClone(c.effects)]));
  editor.withoutRegistration(() => {
    for (const clip of targetClips(editor, new Set(before.keys()), visualClip)) writeStack(clip, mergeStack(clip.effects ?? [], built.effects, mode));
  });
  let reverted = false;
  return () => {
    if (reverted) return;
    reverted = true;
    editor.withoutRegistration(() => {
      for (const clip of targetClips(editor, new Set(before.keys()), visualClip)) {
        const prior = before.get(clip.id);
        if (prior === undefined) delete clip.effects;
        else clip.effects = structuredClone(prior);
      }
    });
  };
}

/** Applies a text style (keeping each clip's font size) and fill mode to the text clips among `clipIds`. */
export function applyTextStylePreset(
  editor: Editor, clipIds: ReadonlySet<string>, preset: TextStylePreset, options: PresetApplyOptions = {},
): PresetApplyResult {
  const targets = targetClips(editor, clipIds, textClip);
  if (targets.length === 0) return { clipIds: [], warnings: [] };
  const measure = options.measure ?? canvasTextMeasurer;
  const ids = targets.map((c) => c.id);
  editor.perform(`Apply ${describe(preset)}`, () => {
    for (const clip of targetClips(editor, new Set(ids), textClip)) {
      const style = cloneTextStyle(preset.style);
      style.fontSize = clip.textStyle?.fontSize ?? style.fontSize;
      clip.textStyle = style;
      clipSetTextFillMode(clip, preset.fillMode ?? "color", style.color);
      fitTextClipToContent(clip, editor.timeline.width, editor.timeline.height, measure);
    }
  });
  return { clipIds: ids, warnings: [] };
}

/** Applies a text animation to the text clips among `clipIds`, keeping an existing highlight colour. */
export function applyTextAnimationPreset(editor: Editor, clipIds: ReadonlySet<string>, preset: TextAnimationPreset): PresetApplyResult {
  const targets = targetClips(editor, clipIds, textClip);
  if (targets.length === 0) return { clipIds: [], warnings: [] };
  const ids = targets.map((c) => c.id);
  editor.perform(`Apply ${describe(preset)}`, () => {
    for (const clip of targetClips(editor, new Set(ids), textClip)) {
      const animation = structuredClone(preset.animation);
      if (animation.highlight === undefined && clip.textAnimation?.highlight !== undefined) animation.highlight = clip.textAnimation.highlight;
      if (animation.preset === "none") delete clip.textAnimation;
      else clip.textAnimation = animation;
    }
  });
  return { clipIds: ids, warnings: [] };
}

/** Places a title template at `frame` on new video tracks above everything (one per lane). */
export function placeTitlePreset(
  editor: Editor, preset: TitlePreset, options: { frame?: number; measure?: TextMeasurer } = {},
): PresetApplyResult {
  const fps = editor.timeline.fps;
  const start = Math.max(0, Math.trunc(options.frame ?? editor.ui.currentFrame));
  const total = Math.max(1, swiftRound(preset.durationSeconds * fps));
  const lanes = Math.max(...preset.items.map((i) => i.layer)) + 1;
  let created: string[] = [];
  editor.perform(`Add ${describe(preset)}`, () => {
    for (let i = 0; i < lanes; i++) editor.timeline.tracks.unshift(makeTrack({ type: "video" }));
    const specs: TextClipSpec[] = preset.items.map((item) => {
      const offset = swiftRound(item.startOffsetSeconds * fps);
      const wanted = item.durationSeconds === undefined ? total - offset : swiftRound(item.durationSeconds * fps);
      return {
        trackIndex: item.layer,
        startFrame: start + offset,
        durationFrames: Math.max(1, Math.min(wanted, total - offset)),
        content: item.text,
        style: item.style,
        ...(item.animation ? { animation: item.animation } : {}),
        ...(item.fillMode ? { fillMode: item.fillMode } : {}),
      };
    });
    created = placeTextClips(editor, specs, { clearExistingRegions: false, ...(options.measure ? { measure: options.measure } : {}) });
    preset.items.forEach((item, i) => {
      const id = created[i];
      const clip = id === undefined ? undefined : editor.clipFor(id);
      if (clip && item.box) {
        clip.transform.centerX = item.box.centerX;
        clip.transform.centerY = item.box.centerY;
      }
    });
  });
  if (created.length > 0) editor.ui.selectedClipIds = new Set(created);
  return { clipIds: created, warnings: [] };
}
