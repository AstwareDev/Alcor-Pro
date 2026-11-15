import { commitClipProperties, commitClipProperty } from "../../editor/mutations/clipMutations";
import { applyClipSettings, clipSettingsSnapshot } from "../../editor/mutations/clipSettings";
import { deepEqual } from "../../editor/mutations/core";
import { timingPropagationPartners } from "../../editor/mutations/linking";
import {
  VolumeScale, blendModes, clipCropAt, clipEndFrame, clipSetDuration, clipSetFade, clipSetFadeInterpolation,
  clipSetBlurKeyframeTrack, clipSupportsRetiming, cropVisibleHeightFraction, cropVisibleWidthFraction, cropMinimumVisibleFraction,
  clipSupportsKeyframes, makeKeyframe, makeKeyframeTrack, makeAnimPair, makeCrop, interpolations,
  type AnimPair, type BezierHandles, type BlendMode, type Clip, type Crop, type Interpolation, type Keyframe, type KeyframeTrack,
} from "../../model";
import { swiftRound } from "../../util/math";
import { snapshot as detach } from "../../util/snapshot";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { swiftNumber } from "./clipTools";
import { ToolError, decodeToolArgs, isRecord, safeInt, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of the property half of ToolExecutor+Clips.swift: set_clip_properties, copy_clip_settings, set_keyframes.

interface ParsedTransform {
  centerX?: number;
  centerY?: number;
  width?: number;
  height?: number;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

interface ParsedCrop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

const transformAllowedKeys = ["centerX", "centerY", "width", "height", "rotation", "flipHorizontal", "flipVertical"];
const cropAllowedKeys = ["left", "top", "right", "bottom"];

function transformHasAnyField(t: ParsedTransform | undefined): boolean {
  return t !== undefined && Object.values(t).some((v) => v !== undefined);
}

function cropHasAnyField(c: ParsedCrop | undefined): boolean {
  return c !== undefined && Object.values(c).some((v) => v !== undefined);
}

function applyTransform(t: ParsedTransform, clip: Clip): void {
  if (t.centerX !== undefined) clip.transform.centerX = t.centerX;
  if (t.centerY !== undefined) clip.transform.centerY = t.centerY;
  if (t.width !== undefined) clip.transform.width = t.width;
  if (t.height !== undefined) clip.transform.height = t.height;
  if (t.rotation !== undefined) {
    clip.transform.rotation = t.rotation;
    delete clip.rotationTrack;
  }
  if (t.flipHorizontal !== undefined) clip.transform.flipHorizontal = t.flipHorizontal;
  if (t.flipVertical !== undefined) clip.transform.flipVertical = t.flipVertical;
}

function mergedCrop(parsed: ParsedCrop, onto: Crop, path: string): Crop {
  const inset = (value: number | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!(value >= 0)) throw new ToolError(`${path}.${name} must be >= 0 (got ${swiftNumber(value)})`);
    return value;
  };
  const out = { ...onto };
  const left = inset(parsed.left, "left");
  if (left !== undefined) out.left = left;
  const top = inset(parsed.top, "top");
  if (top !== undefined) out.top = top;
  const right = inset(parsed.right, "right");
  if (right !== undefined) out.right = right;
  const bottom = inset(parsed.bottom, "bottom");
  if (bottom !== undefined) out.bottom = bottom;
  if (!(cropVisibleWidthFraction(out) >= cropMinimumVisibleFraction && cropVisibleHeightFraction(out) >= cropMinimumVisibleFraction)) {
    throw new ToolError(
      `${path} must leave at least ${swiftNumber(cropMinimumVisibleFraction)} of the source visible on each axis (got width ${swiftNumber(cropVisibleWidthFraction(out))}, height ${swiftNumber(cropVisibleHeightFraction(out))})`,
    );
  }
  return out;
}

interface TimingChange {
  durationFrames?: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
  speed?: number;
}

function applyTimingChanges(t: TimingChange, clip: Clip): string[] {
  const changed: string[] = [];
  if (t.durationFrames !== undefined) {
    clipSetDuration(clip, t.durationFrames);
    changed.push("durationFrames");
  }
  if (t.trimStartFrame !== undefined) {
    clip.trimStartFrame = t.trimStartFrame;
    changed.push("trimStartFrame");
  }
  if (t.trimEndFrame !== undefined) {
    clip.trimEndFrame = t.trimEndFrame;
    changed.push("trimEndFrame");
  }
  if (t.speed !== undefined) {
    if (!clipSupportsRetiming(clip)) {
      changed.push("speed skipped (nested timelines don't support retiming)");
    } else {
      if (t.durationFrames === undefined && t.speed > 0) {
        const sourceConsumed = clip.durationFrames * clip.speed;
        clipSetDuration(clip, Math.max(1, safeInt(swiftRound(sourceConsumed / t.speed)) ?? clip.durationFrames));
        changed.push("durationFrames");
      }
      clip.speed = t.speed;
      changed.push("speed");
    }
  }
  return changed;
}

function fadeInterpolationValue(raw: string | undefined, field: string): Interpolation | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "linear" && raw !== "smooth") throw new ToolError(`${field} must be 'linear' or 'smooth' (got '${raw}')`);
  return raw;
}

interface SetClipPropertiesInput extends TimingChange {
  clipIds?: string[];
  volumeDb?: number;
  opacity?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  fadeInInterpolation?: string;
  fadeOutInterpolation?: string;
  edgeRounding?: number;
  edgeSoftness?: number;
  transform?: ParsedTransform;
  crop?: ParsedCrop;
  blendMode?: string;
}

export function setClipProperties({ editor }: ToolContext, args: ToolArgs): ToolResult {
  if ("transform" in args) {
    if (!isRecord(args.transform)) throw new ToolError("set_clip_properties.transform: expected object");
    validateUnknownKeys(args.transform, transformAllowedKeys, "set_clip_properties.transform");
  }
  if ("crop" in args) {
    if (!isRecord(args.crop)) throw new ToolError("set_clip_properties.crop: expected object");
    validateUnknownKeys(args.crop, cropAllowedKeys, "set_clip_properties.crop");
  }
  const input = decodeToolArgs<SetClipPropertiesInput>(args, "set_clip_properties", {
    clipIds: { spec: { array: "string" } },
    durationFrames: { spec: "int" },
    trimStartFrame: { spec: "int" },
    trimEndFrame: { spec: "int" },
    speed: { spec: "double" },
    volumeDb: { spec: "double" },
    opacity: { spec: "double" },
    fadeInFrames: { spec: "int" },
    fadeOutFrames: { spec: "int" },
    fadeInInterpolation: { spec: "string" },
    fadeOutInterpolation: { spec: "string" },
    edgeRounding: { spec: "double" },
    edgeSoftness: { spec: "double" },
    transform: {
      spec: {
        typeName: "ParsedTransform",
        object: {
          centerX: { spec: "double" }, centerY: { spec: "double" }, width: { spec: "double" }, height: { spec: "double" },
          rotation: { spec: "double" }, flipHorizontal: { spec: "bool" }, flipVertical: { spec: "bool" },
        },
      },
    },
    crop: {
      spec: {
        typeName: "ParsedCrop",
        object: { left: { spec: "double" }, top: { spec: "double" }, right: { spec: "double" }, bottom: { spec: "double" } },
      },
    },
    blendMode: { spec: "string" },
  });
  const clipIds = input.clipIds ?? [];
  if (clipIds.length === 0) throw new ToolError("Provide a non-empty 'clipIds' array");
  const hasAnyProperty =
    input.durationFrames !== undefined || input.trimStartFrame !== undefined || input.trimEndFrame !== undefined ||
    input.speed !== undefined || input.volumeDb !== undefined || input.opacity !== undefined ||
    input.fadeInFrames !== undefined || input.fadeOutFrames !== undefined ||
    input.fadeInInterpolation !== undefined || input.fadeOutInterpolation !== undefined ||
    input.edgeRounding !== undefined || input.edgeSoftness !== undefined ||
    transformHasAnyField(input.transform) || cropHasAnyField(input.crop) || input.blendMode !== undefined;
  if (!hasAnyProperty) throw new ToolError("set_clip_properties needs at least one property to apply");
  if (input.durationFrames !== undefined && input.durationFrames < 1) {
    throw new ToolError(`durationFrames must be >= 1 (got ${input.durationFrames})`);
  }
  if (input.speed !== undefined && input.speed <= 0) throw new ToolError(`speed must be > 0 (got ${swiftNumber(input.speed)})`);
  if (input.volumeDb !== undefined && !(input.volumeDb >= VolumeScale.floorDb && input.volumeDb <= VolumeScale.ceilingDb)) {
    throw new ToolError(
      `volumeDb must be between ${swiftNumber(VolumeScale.floorDb)} and +${swiftNumber(VolumeScale.ceilingDb)} dB (got ${swiftNumber(input.volumeDb)})`,
    );
  }
  if (input.opacity !== undefined && !(input.opacity >= 0 && input.opacity <= 1)) {
    throw new ToolError(`opacity must be between 0 and 1 (got ${swiftNumber(input.opacity)})`);
  }
  if (input.fadeInFrames !== undefined && input.fadeInFrames < 0) throw new ToolError(`fadeInFrames must be >= 0 (got ${input.fadeInFrames})`);
  if (input.fadeOutFrames !== undefined && input.fadeOutFrames < 0) throw new ToolError(`fadeOutFrames must be >= 0 (got ${input.fadeOutFrames})`);
  const fadeInInterpolation = fadeInterpolationValue(input.fadeInInterpolation, "fadeInInterpolation");
  const fadeOutInterpolation = fadeInterpolationValue(input.fadeOutInterpolation, "fadeOutInterpolation");
  for (const [name, value] of [["edgeRounding", input.edgeRounding], ["edgeSoftness", input.edgeSoftness]] as const) {
    if (value === undefined) continue;
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) throw new ToolError(`${name} must be between 0 and 1 (got ${swiftNumber(value)})`);
  }
  if (input.trimStartFrame !== undefined && input.trimStartFrame < 0) throw new ToolError(`trimStartFrame must be >= 0 (got ${input.trimStartFrame})`);
  if (input.trimEndFrame !== undefined && input.trimEndFrame < 0) throw new ToolError(`trimEndFrame must be >= 0 (got ${input.trimEndFrame})`);

  // Resolve clipIds + collect clips for validation.
  const targetClips = new Map<string, Clip>();
  for (const id of clipIds) {
    const loc = editor.findClip(id);
    if (!loc) throw new ToolError(`Clip not found: ${id}`);
    targetClips.set(id, editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
  }
  const sortedIdsWhere = (pred: (c: Clip) => boolean): string[] => [...targetClips].filter(([, c]) => pred(c)).map(([id]) => id).sort();

  if (clipIds.some((id) => editor.clipFor(id)?.multicamGroupId !== undefined) &&
      (input.trimStartFrame !== undefined || input.trimEndFrame !== undefined || input.durationFrames !== undefined || input.speed !== undefined)) {
    throw new ToolError(
      "Timing fields would slip a multicam clip out of sync — switch angles with change_cam; split/delete and property fields (volumeDb, opacity, edgeRounding, edgeSoftness, transform, crop) stay editable.",
    );
  }

  if (input.fadeInFrames !== undefined || input.fadeOutFrames !== undefined) {
    for (const id of clipIds) {
      const original = targetClips.get(id);
      if (!original) continue;
      const candidate = structuredClone(detach(original));
      applyTimingChanges(input, candidate);
      const fadeInFrames = input.fadeInFrames ?? candidate.fadeInFrames;
      const fadeOutFrames = input.fadeOutFrames ?? candidate.fadeOutFrames;
      if (!(fadeInFrames <= candidate.durationFrames && fadeOutFrames <= candidate.durationFrames - fadeInFrames)) {
        throw new ToolError(
          `Fades for clip ${id} must fit within its resulting duration of ${candidate.durationFrames} frames (fadeInFrames ${fadeInFrames} + fadeOutFrames ${fadeOutFrames})`,
        );
      }
    }
  }

  // blendMode applies only to visual (video/image) clips. "normal" clears it.
  let blendMode: BlendMode | undefined;
  const setBlendMode = input.blendMode !== undefined;
  if (input.blendMode !== undefined) {
    const nonVisual = sortedIdsWhere((c) => c.mediaType === "text" || c.mediaType === "audio");
    if (nonVisual.length > 0) throw new ToolError(`blendMode only applies to video/image clips: ${nonVisual.join(", ")}`);
    if (input.blendMode !== "normal") {
      if (!(blendModes as readonly string[]).includes(input.blendMode)) {
        throw new ToolError(`invalid blendMode '${input.blendMode}'. Valid: ${blendModes.join(", ")}`);
      }
      blendMode = input.blendMode as BlendMode;
    }
  }
  if (input.edgeRounding !== undefined || input.edgeSoftness !== undefined) {
    const unsupported = sortedIdsWhere((c) => c.mediaType === "audio" || c.mediaType === "text");
    if (unsupported.length > 0) {
      throw new ToolError(`edgeRounding and edgeSoftness only apply to non-text visual clips: ${unsupported.join(", ")}`);
    }
  }
  const crops = new Map<string, Crop>();
  if (input.crop && cropHasAnyField(input.crop)) {
    const unsupported = sortedIdsWhere((c) => c.mediaType === "audio" || c.mediaType === "text");
    if (unsupported.length > 0) throw new ToolError(`crop only applies to non-text visual clips: ${unsupported.join(", ")}`);
    for (const id of clipIds) {
      const clip = targetClips.get(id);
      if (!clip) continue;
      crops.set(id, mergedCrop(input.crop, clipCropAt(clip, editor.ui.currentFrame), "set_clip_properties.crop"));
    }
  }

  // Expand timing fields to linked partners via the shared model helper.
  const propagatesTiming =
    input.durationFrames !== undefined || input.trimStartFrame !== undefined || input.trimEndFrame !== undefined || input.speed !== undefined;
  const partners = propagatesTiming ? timingPropagationPartners(editor, new Set(clipIds)) : new Set<string>();

  const notes: string[] = [];
  const clearedKeyframes = clipIds.filter((id) => {
    const clip = editor.clipFor(id);
    if (!clip) return false;
    return (
      (input.volumeDb !== undefined && clip.volumeTrack !== undefined) ||
      (input.opacity !== undefined && clip.opacityTrack !== undefined) ||
      (input.transform?.rotation !== undefined && clip.rotationTrack !== undefined) ||
      (cropHasAnyField(input.crop) && clip.cropTrack !== undefined)
    );
  });
  if (clearedKeyframes.length > 0) notes.push(`Setting a static value cleared existing keyframes on: ${clearedKeyframes.join(", ")}.`);

  const beforeClips = new Map<string, Clip | null>();
  for (const id of [...clipIds, ...partners]) beforeClips.set(id, editor.clipFor(id));

  const snapshot = timelineSnapshot(editor);
  const actionName = clipIds.length === 1 ? "Set Clip Property (Agent)" : "Set Clip Properties (Agent)";
  const primary = new Set(clipIds);
  commitClipProperties(
    editor,
    [...clipIds, ...partners],
    (clip) => {
      if (primary.has(clip.id)) {
        const changed = applyTimingChanges(input, clip);
        // Setting a scalar clears any existing keyframe track on the same property.
        if (input.volumeDb !== undefined) {
          clip.volume = VolumeScale.linearFromDb(input.volumeDb);
          delete clip.volumeTrack;
          changed.push("volumeDb");
        }
        if (input.opacity !== undefined) {
          clip.opacity = input.opacity;
          delete clip.opacityTrack;
          changed.push("opacity");
        }
        if (input.fadeInFrames !== undefined) {
          clipSetFade(clip, "left", input.fadeInFrames);
          changed.push("fadeInFrames");
        }
        if (input.fadeOutFrames !== undefined) {
          clipSetFade(clip, "right", input.fadeOutFrames);
          changed.push("fadeOutFrames");
        }
        if (fadeInInterpolation !== undefined) {
          clipSetFadeInterpolation(clip, "left", fadeInInterpolation);
          changed.push("fadeInInterpolation");
        }
        if (fadeOutInterpolation !== undefined) {
          clipSetFadeInterpolation(clip, "right", fadeOutInterpolation);
          changed.push("fadeOutInterpolation");
        }
        if (input.edgeRounding !== undefined) {
          clip.edgeRounding = input.edgeRounding;
          changed.push("edgeRounding");
        }
        if (input.edgeSoftness !== undefined) {
          clip.edgeSoftness = input.edgeSoftness;
          changed.push("edgeSoftness");
        }
        if (setBlendMode) {
          if (blendMode === undefined) delete clip.blendMode;
          else clip.blendMode = blendMode;
          changed.push("blendMode");
        }
        if (input.transform && transformHasAnyField(input.transform)) {
          applyTransform(input.transform, clip);
          changed.push("transform");
        }
        const crop = crops.get(clip.id);
        if (crop) {
          clip.crop = crop;
          delete clip.cropTrack;
          changed.push("crop");
        }
        notes.push(...changed.filter((c) => c.includes("skipped")).map((c) => `${clip.id}: ${c}`));
      } else {
        // Partners drop trim/speed when they're text.
        const isText = clip.mediaType === "text";
        applyTimingChanges(
          {
            ...(input.durationFrames !== undefined ? { durationFrames: input.durationFrames } : {}),
            ...(!isText && input.trimStartFrame !== undefined ? { trimStartFrame: input.trimStartFrame } : {}),
            ...(!isText && input.trimEndFrame !== undefined ? { trimEndFrame: input.trimEndFrame } : {}),
            ...(!isText && input.speed !== undefined ? { speed: input.speed } : {}),
          },
          clip,
        );
      }
    },
    actionName,
  );
  const changed = [...beforeClips].some(([id, clip]) => !deepEqual(editor.clipFor(id), clip));
  return mutationResult(editor, snapshot, { touched: [...clipIds, ...partners], extra: { changed }, notes });
}

// MARK: copy_clip_settings

export function copyClipSettings({ editor }: ToolContext, args: ToolArgs): ToolResult {
  if ("targetTrack" in args) {
    if (!isRecord(args.targetTrack)) throw new ToolError("copy_clip_settings.targetTrack: expected object");
    validateUnknownKeys(args.targetTrack, ["trackId", "range"], "copy_clip_settings.targetTrack");
  }
  const input = decodeToolArgs<{
    sourceClipId: string;
    targetClipIds?: string[];
    targetTrack?: { trackId: string; range?: number[] };
  }>(args, "copy_clip_settings", {
    sourceClipId: { spec: "string", required: true },
    targetClipIds: { spec: { array: "string" } },
    targetTrack: {
      spec: {
        typeName: "TargetTrack",
        object: { trackId: { spec: "string", required: true }, range: { spec: { array: "int" } } },
      },
    },
  });
  if ((input.targetClipIds !== undefined) === (input.targetTrack !== undefined)) {
    throw new ToolError("Provide exactly one of 'targetClipIds' or 'targetTrack'");
  }

  const settings = clipSettingsSnapshot(editor, input.sourceClipId);

  let targetSelection: Record<string, unknown> | undefined;
  let incompatibleClipCount = 0;
  let sourceExcluded = false;
  let targetClipIds: string[];
  if (input.targetClipIds) {
    targetClipIds = [...new Set(input.targetClipIds)];
    if (targetClipIds.length === 0) throw new ToolError("Provide a non-empty 'targetClipIds' array");
  } else {
    const targetTrack = input.targetTrack;
    if (!targetTrack) throw new ToolError("Provide exactly one of 'targetClipIds' or 'targetTrack'");
    const track = editor.timeline.tracks.find((t) => t.id === targetTrack.trackId);
    if (!track) throw new ToolError(`Track not found: ${targetTrack.trackId}`);
    let range: { lower: number; upper: number } | undefined;
    if (targetTrack.range) {
      const frames = targetTrack.range;
      if (!(frames.length === 2 && frames[0] >= 0 && frames[1] > frames[0])) {
        throw new ToolError("targetTrack.range must be [startFrame, endFrame) with 0 <= startFrame < endFrame");
      }
      range = { lower: frames[0], upper: frames[1] };
    }
    const scoped = track.clips.filter((clip) => (range ? clip.startFrame < range.upper && clipEndFrame(clip) > range.lower : true));
    targetClipIds = scoped.filter((c) => c.id !== input.sourceClipId && c.mediaType === settings.mediaType).map((c) => c.id);
    sourceExcluded = scoped.some((c) => c.id === input.sourceClipId);
    incompatibleClipCount = scoped.filter((c) => c.id !== input.sourceClipId && c.mediaType !== settings.mediaType).length;
    if (targetClipIds.length === 0) throw new ToolError(`No ${settings.mediaType} clips matched targetTrack ${targetTrack.trackId}`);
    targetSelection = { trackId: targetTrack.trackId };
    if (targetTrack.range) targetSelection.range = targetTrack.range;
  }

  const snapshot = timelineSnapshot(editor);
  const transfer = applyClipSettings(editor, settings, targetClipIds, "Copy Clip Settings (Agent)");

  const extra: Record<string, unknown> = {
    changed: transfer.changedClipIds.length > 0,
    sourceClipId: input.sourceClipId,
    mediaType: settings.mediaType,
  };
  if (targetSelection) {
    extra.targetTrack = targetSelection;
    extra.matchedClipCount = targetClipIds.length;
    extra.changedClipCount = transfer.changedClipIds.length;
    extra.unchangedClipCount = transfer.unchangedClipIds.length;
    extra.incompatibleClipCount = incompatibleClipCount;
    extra.sourceExcluded = sourceExcluded;
  } else {
    extra.targetClipIds = targetClipIds;
    extra.changedClipIds = transfer.changedClipIds;
    extra.unchangedClipIds = transfer.unchangedClipIds;
  }
  return mutationResult(editor, snapshot, { touched: targetSelection ? [] : transfer.changedClipIds, extra });
}

// MARK: set_keyframes

const keyframePropertyNames = ["volumeDb", "opacity", "rotation", "position", "scale", "crop", "blur"];

export function kfInt(raw: unknown, at: string): number {
  const v = typeof raw === "number" ? safeInt(raw) : undefined;
  if (v === undefined) throw new ToolError(`${at}: expected integer`);
  return v;
}

export function kfDouble(raw: unknown, at: string): number {
  if (typeof raw !== "number") throw new ToolError(`${at}: expected number`);
  if (!Number.isFinite(raw)) throw new ToolError(`${at}: value must be finite (got ${raw})`);
  return raw;
}

export function kfBezier(raw: unknown, interp: Interpolation, at: string): BezierHandles | undefined {
  if (raw === undefined) {
    if (interp === "bezier") throw new ToolError(`${at}: interp 'bezier' needs a [x1, y1, x2, y2] curve`);
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new ToolError(`${at}: expected [x1, y1, x2, y2] finite numbers`);
  }
  const [x1, y1, x2, y2] = raw as number[];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) throw new ToolError(`${at}: x1 and x2 must be within 0-1`);
  return [x1, y1, x2, y2];
}

export function kfInterp(raw: unknown, at: string): Interpolation {
  if (raw === undefined) return "smooth";
  if (typeof raw !== "string" || !(interpolations as readonly string[]).includes(raw)) {
    throw new ToolError(`${at}: expected one of ${interpolations.map((i) => `'${i}'`).join(", ")} (got ${String(raw)})`);
  }
  return raw as Interpolation;
}

/** Parse `[[frame, value0, value1, ..., interp?], ...]` into a keyframe track. */
function parseKeyframes<V>(
  rows: unknown[],
  path: string,
  fieldNames: string[],
  build: (values: number[]) => V,
  validateValues: (index: number, values: number[]) => void = () => {},
): KeyframeTrack<V> {
  const arity = fieldNames.length;
  const labels = fieldNames.join(", ");
  const minLen = arity + 1;
  const maxLen = arity + 3;
  const out: Keyframe<V>[] = [];
  rows.forEach((raw, i) => {
    if (!Array.isArray(raw)) throw new ToolError(`${path}[${i}]: expected array [frame, ${labels}, interp?, bezier?]`);
    if (raw.length < minLen || raw.length > maxLen) {
      throw new ToolError(`${path}[${i}]: expected [frame, ${labels}], optionally followed by interp and a bezier [x1, y1, x2, y2] (got ${raw.length} elements)`);
    }
    const frame = kfInt(raw[0], `${path}[${i}][0] (frame)`);
    const values = fieldNames.map((name, k) => kfDouble(raw[k + 1], `${path}[${i}][${k + 1}] (${name})`));
    validateValues(i, values);
    const interp = kfInterp(raw.length > minLen ? raw[minLen] : undefined, `${path}[${i}][${minLen}] (interp)`);
    const bezier = kfBezier(raw.length > minLen + 1 ? raw[minLen + 1] : undefined, interp, `${path}[${i}][${minLen + 1}] (bezier)`);
    out.push(makeKeyframe(frame, build(values), interp, bezier));
  });
  return makeKeyframeTrack(sortAndDedupe(out));
}

function sortAndDedupe<V>(kfs: Keyframe<V>[]): Keyframe<V>[] {
  const sorted = [...kfs].sort((a, b) => a.frame - b.frame);
  const out: Keyframe<V>[] = [];
  for (const kf of sorted) {
    if (out.length > 0 && out[out.length - 1].frame === kf.frame) out[out.length - 1] = kf;
    else out.push(kf);
  }
  return out;
}

function parseScalarKeyframes(rows: unknown[], path: string, valueName = "value", range?: [number, number]): KeyframeTrack<number> {
  return parseKeyframes(rows, path, [valueName], (v) => v[0], (index, values) => {
    if (range && !(values[0] >= range[0] && values[0] <= range[1])) {
      throw new ToolError(`${path}[${index}][1] (${valueName}): must be between ${swiftNumber(range[0])} and ${swiftNumber(range[1])} (got ${swiftNumber(values[0])})`);
    }
  });
}

export function setKeyframes({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ clipId: string; property: string }>(args, "set_keyframes", {
    clipId: { spec: "string", required: true },
    property: { spec: "string", required: true },
    keyframes: { spec: "any" },
  });
  const rows = args.keyframes;
  if (!Array.isArray(rows)) throw new ToolError("Missing required field 'keyframes' (must be an array)");
  const { clipId, property } = input;
  if (!keyframePropertyNames.includes(property)) {
    throw new ToolError(`Unknown property '${property}'. Expected one of: ${[...keyframePropertyNames].sort().join(", ")}`);
  }
  const targetClip = editor.clipFor(clipId);
  if (!targetClip) throw new ToolError(`Clip not found: ${clipId}`);
  if (property === "blur" && !clipSupportsKeyframes(targetClip, "blur")) {
    throw new ToolError(`Clip ${clipId} does not support blur keyframes.`);
  }

  let apply: (clip: Clip) => void;
  switch (property) {
    case "volumeDb": {
      const kfs = parseScalarKeyframes(rows, "keyframes", "decibels", [VolumeScale.floorDb, VolumeScale.ceilingDb]);
      apply = (c) => setOrClear(c, "volumeTrack", kfs);
      break;
    }
    case "opacity": {
      const kfs = parseScalarKeyframes(rows, "keyframes", "value", [0, 1]);
      apply = (c) => setOrClear(c, "opacityTrack", kfs);
      break;
    }
    case "rotation": {
      const kfs = parseScalarKeyframes(rows, "keyframes");
      apply = (c) => setOrClear(c, "rotationTrack", kfs);
      break;
    }
    case "position": {
      const kfs = parseKeyframes<AnimPair>(rows, "keyframes", ["a", "b"], (v) => makeAnimPair(v[0], v[1]));
      apply = (c) => setOrClear(c, "positionTrack", kfs);
      break;
    }
    case "scale": {
      const kfs = parseKeyframes<AnimPair>(rows, "keyframes", ["a", "b"], (v) => makeAnimPair(v[0], v[1]));
      apply = (c) => setOrClear(c, "scaleTrack", kfs);
      break;
    }
    case "crop": {
      const kfs = parseKeyframes<Crop>(rows, "keyframes", ["top", "right", "bottom", "left"], (v) =>
        makeCrop({ left: v[3], top: v[0], right: v[1], bottom: v[2] }),
      );
      apply = (c) => setOrClear(c, "cropTrack", kfs);
      break;
    }
    case "blur": {
      const kfs = parseScalarKeyframes(rows, "keyframes", "value", [0, 100]);
      apply = (c) => clipSetBlurKeyframeTrack(c, kfs.keyframes.length === 0 ? undefined : kfs);
      break;
    }
    default:
      throw new ToolError(`Unknown property '${property}'`);
  }

  const snapshot = timelineSnapshot(editor);
  commitClipProperty(editor, clipId, apply, "Set Keyframes (Agent)");
  const notes = rows.length === 0 ? [`Cleared ${property} keyframes.`] : [];
  return mutationResult(editor, snapshot, { touched: [clipId], notes });
}

type TrackKey = "volumeTrack" | "opacityTrack" | "rotationTrack" | "positionTrack" | "scaleTrack" | "cropTrack";

function setOrClear<K extends TrackKey>(clip: Clip, key: K, track: NonNullable<Clip[K]>): void {
  if (track.keyframes.length === 0) delete clip[key];
  else clip[key] = track;
}

