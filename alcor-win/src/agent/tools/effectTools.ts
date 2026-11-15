import { mutateClips } from "../../editor/mutations/clipMutations";
import { clipBlurKeyframeTrack, effectInsertIndex, gaussianBlurRadiusKey, gaussianBlurType, makeEffectParam, type Effect } from "../../model";
import { effectDescriptor, effectDescriptorMakeEffect } from "../../preview/effects/effectRegistry";
import { swiftRound } from "../../util/math";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { ToolError, decodeToolArgs, isRecord } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of ToolExecutor+Effect.swift: generic, registry-driven editing of the non-color effect stack.

interface EffectEntry {
  type: string;
  params?: Record<string, number>;
  enabled?: boolean;
}

function mismatch(path: string, type: string): ToolError {
  return new ToolError(`${path}: expected ${type}, got something else`);
}

/** Swift Decodable for `Entry`: unknown keys are ignored, `null` reads as absent. */
function decodeEntries(raw: unknown): EffectEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw mismatch("apply_effect.effects", "Array<Any>");
  return raw.map((item, i) => {
    const path = `apply_effect.effects[${i}]`;
    if (!isRecord(item)) throw mismatch(path, "Dictionary<String, Any>");
    const type = item.type;
    if (type === undefined || type === null) throw new ToolError(`${path}: missing required field 'type'`);
    if (typeof type !== "string") throw mismatch(`${path}.type`, "String");
    const entry: EffectEntry = { type };
    const params = item.params;
    if (params !== undefined && params !== null) {
      if (!isRecord(params)) throw mismatch(`${path}.params`, "Dictionary<String, Double>");
      entry.params = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v !== "number") throw mismatch(`${path}.params.${k}`, "Double");
        entry.params[k] = v;
      }
    }
    const enabled = item.enabled;
    if (enabled !== undefined && enabled !== null) {
      if (typeof enabled !== "boolean") throw mismatch(`${path}.enabled`, "Bool");
      entry.enabled = enabled;
    }
    return entry;
  });
}

/** Generic, registry-driven effect stack editing for non-color effects (apply_color owns color.*). */
export function applyEffect({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const raw = decodeToolArgs<{ clipIds: string[]; effects?: unknown; remove?: string[] }>(args, "apply_effect", {
    clipIds: { spec: { array: "string" }, required: true },
    effects: { spec: "any" },
    remove: { spec: { array: "string" } },
  });
  const clipIds = raw.clipIds;
  if (clipIds.length === 0) throw new ToolError("clipIds is empty.");
  const adds = decodeEntries(raw.effects) ?? [];
  const removes = raw.remove ?? [];
  if (adds.length === 0 && removes.length === 0) throw new ToolError("Provide effects to add/update or remove types to delete.");

  for (const e of adds) {
    const d = effectDescriptor(e.type);
    if (!d) throw new ToolError(`Unknown effect '${e.type}'. See the apply_effect description for available types.`);
    if (e.type.startsWith("color.")) throw new ToolError(`'${e.type}' is a color grade — use apply_color, not apply_effect.`);
    if (e.params) {
      const allowed = new Set(d.params.map((p) => p.key));
      const unknown = Object.keys(e.params).filter((k) => !allowed.has(k)).sort();
      if (unknown.length > 0) {
        throw new ToolError(`${e.type}: unknown param(s) '${unknown.join("', '")}'. Allowed: ${[...allowed].sort().join(", ")}.`);
      }
    }
  }
  for (const id of clipIds) {
    const clip = editor.clipFor(id);
    if (!clip) throw new ToolError(`Clip not found: ${id}`);
    if (clip.mediaType !== "video" && clip.mediaType !== "image") {
      throw new ToolError(`Clip ${id} is a ${clip.mediaType} clip; apply_effect needs a video or image clip.`);
    }
  }
  const clearsBlur = adds.some((e) => e.type === gaussianBlurType && e.params?.[gaussianBlurRadiusKey] !== undefined);
  const clearedBlurIds = clearsBlur
    ? clipIds.filter((id) => {
        const clip = editor.clipFor(id);
        return clip !== null && clipBlurKeyframeTrack(clip) !== undefined;
      })
    : [];

  const since = timelineSnapshot(editor);
  const actionName = clipIds.length === 1 ? "Apply Effect (Agent)" : `Apply Effect ×${clipIds.length} (Agent)`;
  mutateClips(editor, new Set(clipIds), actionName, (clip) => {
    let stack: Effect[] = [...(clip.effects ?? [])];
    for (const type of removes) stack = stack.filter((e) => e.type !== type);
    for (const e of adds) {
      const d = effectDescriptor(e.type);
      if (!d) continue;
      const effect = stack.find((x) => x.type === e.type) ?? effectDescriptorMakeEffect(d);
      if (e.enabled !== undefined) effect.enabled = e.enabled;
      const params = e.params;
      if (params) {
        for (const spec of d.params) {
          const value = params[spec.key];
          if (value === undefined) continue;
          const v = Math.min(spec.max, Math.max(spec.min, value));
          effect.params[spec.key] = makeEffectParam({ value: swiftRound(v * 1000) / 1000 });
        }
      }
      stack = stack.filter((x) => x.type !== e.type);
      stack.splice(effectInsertIndex(stack, e.type), 0, effect);
    }
    if (stack.length === 0) delete clip.effects;
    else clip.effects = stack;
  });
  const notes = clearedBlurIds.length === 0 ? [] : [`Static blur cleared existing blur keyframes on: ${clearedBlurIds.join(", ")}.`];
  return mutationResult(editor, since, { touched: clipIds, notes });
}
