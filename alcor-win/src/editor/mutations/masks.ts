import {
  clipContainsTimelineFrame,
  clipTypeIsVisual,
  defaultMaskPath,
  keyframeTrackIsActive,
  keyframeTrackRemove,
  keyframeTrackUpsert,
  makeKeyframe,
  makeKeyframeTrack,
  makeMask,

  maskExpansionAt,
  maskExpansionRange,
  maskFeatherAt,
  maskFeatherMax,
  maskModes,
  maskOpacityAt,
  maskPathAt,
  maskShapeLabel,
  maskTrack,
  maskTrackKey,

  type BezierHandles,
  type Clip,
  type Interpolation,
  type Mask,
  type MaskMode,
  type MaskPath,
  type MaskProperty,
  type MaskShape,
} from "../../model";
import { newId } from "../../util/id";
import { clamp } from "../../util/math";
import { snapshot } from "../../util/snapshot";
import type { Editor } from "../editor";
import { applyClipProperty, commitClipProperty, revertClipProperty } from "./clipMutations";

/** Fields settable through `updateMask`. Animated properties write a keyframe at the playhead instead of the base value. */
export interface MaskPatch {
  name?: string;
  mode?: MaskMode;
  inverted?: boolean;
  feather?: number;
  expansion?: number;
  opacity?: number;
  path?: MaskPath;
}

export function maskIn(clip: Clip, maskId: string): Mask | undefined {
  return clip.masks?.find((m) => m.id === maskId);
}

export function masksOf(editor: Editor, clipId: string): readonly Mask[] {
  return editor.clipFor(clipId)?.masks ?? [];
}

export function maskFor(editor: Editor, clipId: string, maskId: string): Mask | undefined {
  const clip = editor.clipFor(clipId);
  return clip ? maskIn(clip, maskId) : undefined;
}

function uniqueName(masks: readonly Mask[], base: string): string {
  const taken = new Set(masks.map((m) => m.name));
  for (let n = masks.length + 1; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

function clampedPath(path: MaskPath): MaskPath {
  const clone = structuredClone(snapshot(path));
  for (const v of clone.vertices) {
    for (const k of ["x", "y", "inX", "inY", "outX", "outY"] as const) if (!Number.isFinite(v[k])) v[k] = 0;
  }
  return clone;
}

// MARK: - Add / remove / reorder

/** Adds a mask on top of the clip's stack and selects it. Returns the new mask id, or undefined when the clip can't take masks. */
export function addMask(
  editor: Editor,
  clipId: string,
  shape: MaskShape,
  opts: { path?: MaskPath; name?: string; mode?: MaskMode; inverted?: boolean; feather?: number; expansion?: number; opacity?: number } = {},
): string | undefined {
  const found = editor.clipFor(clipId);
  if (!found || !clipTypeIsVisual(found.mediaType)) return undefined;
  const id = newId();
  editor.perform("Add Mask", () => {
    const clip = editor.clipFor(clipId);
    if (!clip) return;
    const mask = makeMask({
      id,
      shape,
      name: opts.name ?? uniqueName(clip.masks ?? [], maskShapeLabel(shape)),
      path: opts.path ? clampedPath(opts.path) : defaultMaskPath(shape),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.inverted !== undefined ? { inverted: opts.inverted } : {}),
      ...(opts.feather !== undefined ? { feather: opts.feather } : {}),
      ...(opts.expansion !== undefined ? { expansion: opts.expansion } : {}),
      ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
    });
    (clip.masks ??= []).push(mask);
  });
  editor.ui.selectedMaskId = id;
  return id;
}

export function removeMask(editor: Editor, clipId: string, maskId: string): void {
  if (!maskFor(editor, clipId, maskId)) return;
  editor.perform("Delete Mask", () => {
    const clip = editor.clipFor(clipId);
    if (!clip?.masks) return;
    clip.masks = clip.masks.filter((m) => m.id !== maskId);
    if (clip.masks.length === 0) delete clip.masks;
  });
  if (editor.ui.selectedMaskId === maskId) editor.ui.selectedMaskId = null;
}

export function duplicateMask(editor: Editor, clipId: string, maskId: string): string | undefined {
  const source = maskFor(editor, clipId, maskId);
  if (!source) return undefined;
  const id = newId();
  editor.perform("Duplicate Mask", () => {
    const clip = editor.clipFor(clipId);
    const masks = clip?.masks;
    const index = masks?.findIndex((m) => m.id === maskId) ?? -1;
    if (!masks || index < 0) return;
    const copy = structuredClone(snapshot(masks[index] as Mask));
    copy.id = id;
    copy.name = uniqueName(masks, copy.name.replace(/ \d+$/, ""));
    masks.splice(index + 1, 0, copy);
  });
  editor.ui.selectedMaskId = id;
  return id;
}

/** Draft-level reorder: moves a mask to `toIndex` in the stack (0 = bottom, applied first). */
export function reorderMaskIn(clip: Clip, maskId: string, toIndex: number): void {
  const list = clip.masks;
  const from = list?.findIndex((m) => m.id === maskId) ?? -1;
  if (!list || from < 0) return;
  const [moved] = list.splice(from, 1);
  if (moved) list.splice(clamp(Math.trunc(toIndex), 0, list.length), 0, moved);
}

export function reorderMask(editor: Editor, clipId: string, maskId: string, toIndex: number): void {
  const masks = masksOf(editor, clipId);
  const from = masks.findIndex((m) => m.id === maskId);
  if (from < 0 || clamp(Math.trunc(toIndex), 0, masks.length - 1) === from) return;
  editor.perform("Reorder Mask", () => {
    const clip = editor.clipFor(clipId);
    if (clip) reorderMaskIn(clip, maskId, toIndex);
  });
}

export function renameMask(editor: Editor, clipId: string, maskId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === "" || maskFor(editor, clipId, maskId)?.name === trimmed) return;
  commitClipProperty(editor, clipId, (clip) => { const m = maskIn(clip, maskId); if (m) m.name = trimmed; }, "Rename Mask");
}

// MARK: - Property writes

function writeValue(editor: Editor, clip: Clip, mask: Mask, property: MaskProperty, value: number | MaskPath): void {
  const track = maskTrack(mask, property);
  if (track && keyframeTrackIsActive(track)) {
    const frame = editor.ui.currentFrame;
    if (!clipContainsTimelineFrame(clip, frame)) return;
    const t = track as { keyframes: { frame: number; value: unknown; interpolationOut: Interpolation; bezier?: BezierHandles }[] };
    const existing = t.keyframes.find((k) => k.frame === frame - clip.startFrame);
    keyframeTrackUpsert(t, makeKeyframe(frame - clip.startFrame, value, existing?.interpolationOut, existing?.bezier));
  } else {
    (mask as unknown as Record<string, unknown>)[property] = value;
  }
}

export function writePatch(editor: Editor, clip: Clip, maskId: string, patch: MaskPatch): void {
  const mask = maskIn(clip, maskId);
  if (!mask) return;
  if (patch.name !== undefined && patch.name.trim() !== "") mask.name = patch.name.trim();
  if (patch.mode !== undefined && maskModes.includes(patch.mode)) mask.mode = patch.mode;
  if (patch.inverted !== undefined) mask.inverted = patch.inverted;
  if (patch.feather !== undefined && Number.isFinite(patch.feather)) writeValue(editor, clip, mask, "feather", clamp(patch.feather, 0, maskFeatherMax));
  if (patch.expansion !== undefined && Number.isFinite(patch.expansion)) {
    writeValue(editor, clip, mask, "expansion", clamp(patch.expansion, maskExpansionRange.min, maskExpansionRange.max));
  }
  if (patch.opacity !== undefined && Number.isFinite(patch.opacity)) writeValue(editor, clip, mask, "opacity", clamp(patch.opacity, 0, 1));
  if (patch.path !== undefined) writeValue(editor, clip, mask, "path", clampedPath(patch.path));
}

/** Live edit (no undo entry); finish the gesture with `commitMask` or `cancelMask`. */
export function applyMask(editor: Editor, clipId: string, maskId: string, patch: MaskPatch): void {
  applyClipProperty(editor, clipId, (clip) => writePatch(editor, clip, maskId, patch));
}

export function commitMask(editor: Editor, clipId: string, maskId: string, patch: MaskPatch, actionName = "Change Mask"): void {
  commitClipProperty(editor, clipId, (clip) => writePatch(editor, clip, maskId, patch), actionName);
}

export function cancelMask(editor: Editor, clipId: string): void {
  revertClipProperty(editor, clipId);
}

/** One undoable edit of several fields (used by the agent tools and the inspector). */
export function updateMask(editor: Editor, clipId: string, maskId: string, patch: MaskPatch): void {
  commitMask(editor, clipId, maskId, patch, "Edit Mask");
}

// MARK: - Keyframes

function currentValue(mask: Mask, property: MaskProperty, offset: number): number | MaskPath {
  switch (property) {
    case "path": return structuredClone(snapshot(maskPathAt(mask, offset)));
    case "feather": return maskFeatherAt(mask, offset);
    case "opacity": return maskOpacityAt(mask, offset);
    case "expansion": return maskExpansionAt(mask, offset);
  }
}

export function maskHasKeyframe(editor: Editor, clipId: string, maskId: string, property: MaskProperty, frame: number): boolean {
  const clip = editor.clipFor(clipId);
  const mask = clip ? maskIn(clip, maskId) : undefined;
  return mask?.[maskTrackKey(property)]?.keyframes.some((k) => k.frame === frame - (clip?.startFrame ?? 0)) ?? false;
}

/** Draft-level keyframe stamp (shared by the undoable wrappers and the agent tools). */
export function upsertMaskKeyframe(
  c: Clip, maskId: string, property: MaskProperty, frame: number,
  value?: number | MaskPath, interpolation?: Interpolation,
): void {
  const mask = maskIn(c, maskId);
  if (!mask) return;
  const offset = frame - c.startFrame;
  const raw = value ?? currentValue(mask, property, offset);
  const clamped = property === "path" ? clampedPath(raw as MaskPath)
    : property === "opacity" ? clamp(raw as number, 0, 1)
    : property === "feather" ? clamp(raw as number, 0, maskFeatherMax)
    : clamp(raw as number, maskExpansionRange.min, maskExpansionRange.max);
  const key = maskTrackKey(property);
  const track = (mask[key] ?? makeKeyframeTrack()) as { keyframes: { frame: number; value: unknown; interpolationOut: Interpolation; bezier?: BezierHandles }[] };
  const existing = track.keyframes.find((k) => k.frame === offset);
  keyframeTrackUpsert(track, makeKeyframe(offset, clamped, interpolation ?? existing?.interpolationOut, interpolation ? undefined : existing?.bezier));
  (mask as unknown as Record<string, unknown>)[key] = track;
}

/** Draft-level keyframe removal; removing the last keyframe drops the track and bakes its value into the base. */
export function deleteMaskKeyframe(c: Clip, maskId: string, property: MaskProperty, frame: number): void {
  const mask = maskIn(c, maskId);
  const track = mask ? maskTrack(mask, property) : undefined;
  if (!mask || !track) return;
  if (track.keyframes.length === 1) {
    if (track.keyframes[0]?.frame !== frame - c.startFrame) return;
    (mask as unknown as Record<string, unknown>)[property] = structuredClone(snapshot(track.keyframes[0]?.value));
    delete mask[maskTrackKey(property)];
  } else {
    keyframeTrackRemove(track, frame - c.startFrame);
  }
}

/** Stamps a keyframe holding the current evaluated value (or `value`) at `frame` (default: the playhead). */
export function setMaskKeyframe(
  editor: Editor,
  clipId: string,
  maskId: string,
  property: MaskProperty,
  opts: { frame?: number; value?: number | MaskPath; interpolation?: Interpolation } = {},
): boolean {
  const clip = editor.clipFor(clipId);
  const frame = opts.frame ?? editor.ui.currentFrame;
  if (!clip || !maskIn(clip, maskId) || !clipContainsTimelineFrame(clip, frame)) return false;
  commitClipProperty(editor, clipId, (c) => upsertMaskKeyframe(c, maskId, property, frame, opts.value, opts.interpolation), "Add Keyframe");
  return true;
}

/** Removes the keyframe at `frame`; removing the last one drops the track and bakes its value into the base. */
export function removeMaskKeyframe(editor: Editor, clipId: string, maskId: string, property: MaskProperty, frame: number): boolean {
  if (!maskHasKeyframe(editor, clipId, maskId, property, frame)) return false;
  commitClipProperty(editor, clipId, (c) => deleteMaskKeyframe(c, maskId, property, frame), "Delete Keyframe");
  return true;
}

export function toggleMaskKeyframe(editor: Editor, clipId: string, maskId: string, property: MaskProperty, frame: number): void {
  if (maskHasKeyframe(editor, clipId, maskId, property, frame)) removeMaskKeyframe(editor, clipId, maskId, property, frame);
  else setMaskKeyframe(editor, clipId, maskId, property, { frame });
}

/** Drops all keyframes of `property` and restores its default value. */
export function resetMaskProperty(editor: Editor, clipId: string, maskId: string, property: MaskProperty): void {
  const mask = maskFor(editor, clipId, maskId);
  if (!mask) return;
  commitClipProperty(
    editor,
    clipId,
    (c) => {
      const m = maskIn(c, maskId);
      if (!m) return;
      delete m[maskTrackKey(property)];
      switch (property) {
        case "path": if (m.shape !== "path") m.path = defaultMaskPath(m.shape); break;
        case "feather": m.feather = 0; break;
        case "opacity": m.opacity = 1; break;
        case "expansion": m.expansion = 0; break;
      }
    },
    "Reset Mask Property",
  );
}
