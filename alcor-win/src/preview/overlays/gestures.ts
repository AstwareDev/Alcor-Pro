import type { Editor } from "../../editor/editor";
import { applyTextStyle, commitTextStyle, revertClipProperty } from "../../editor/mutations/clipMutations";
import { mediaCanvasAspectForClip, sourceDimensions } from "../../editor/mutations/core";
import {
  applyCrop,
  applyRotation,
  applyScale,
  applyTransform,
  commitCrop,
  commitRotation,
  commitScale,
  commitTransform,
} from "../../editor/mutations/keyframes";
import type { Point, Size } from "../../model/geometry";
import {
  clipCropAt,
  clipTextScaleAt,
  clipTransformAt,
  cropAspectLockPixelAspect,
  keyframeTrackIsActive,
  type Transform,
} from "../../model";
import { pannedCrop, resizedCrop, type CropHit } from "./cropMath";
import {
  angleStep,
  clipRectPx,
  movedTransform,
  pointerAngle,
  resizedTransform,
  rotationFromDrag,
  textScaleFromDrag,
  toLocalDelta,
  type CenterGuides,
  type TransformHit,
} from "./transformMath";

export interface DragModifiers {
  shift: boolean;
}

/**
 * One pointer drag on the preview. `move` applies live (no undo entry); `commit` writes the final value as exactly one
 * undo entry; `cancel` restores the clip as it was at pointer-down. Nothing is written until the first `move`.
 */
export interface DragSession {
  move(p: Point, mods: DragModifiers): void;
  commit(p: Point, mods: DragModifiers): void;
  cancel(): void;
}

const noGuides: CenterGuides = { x: false, y: false };

type TransformEdit =
  | { kind: "transform"; transform: Transform; name: string }
  | { kind: "rotation"; degrees: number }
  | { kind: "textScale"; value: number; scaleKeyframed: boolean };

function applyEdit(editor: Editor, clipId: string, edit: TransformEdit): void {
  switch (edit.kind) {
    case "transform": applyTransform(editor, clipId, edit.transform); break;
    case "rotation": applyRotation(editor, [clipId], edit.degrees); break;
    case "textScale":
      if (edit.scaleKeyframed) applyScale(editor, clipId, edit.value);
      else applyTextStyle(editor, clipId, (style) => { style.fontScale = edit.value; }, true);
      break;
  }
}

function commitEdit(editor: Editor, clipId: string, edit: TransformEdit): void {
  switch (edit.kind) {
    case "transform": commitTransform(editor, clipId, edit.transform, edit.name); break;
    case "rotation": commitRotation(editor, [clipId], edit.degrees); break;
    case "textScale":
      if (edit.scaleKeyframed) commitScale(editor, clipId, edit.value);
      else commitTextStyle(editor, clipId, (style) => { style.fontScale = edit.value; }, true);
      break;
  }
}

/**
 * Move / resize / rotate of one clip at the playhead, like the inspector's position, scale and rotation fields:
 * keyframed properties get a keyframe at the playhead, static ones are written directly. `size` is the overlay size
 * in pixels; `onGuides` receives the canvas-centre guides to draw.
 */
export function beginTransformDrag(
  editor: Editor,
  clipId: string,
  hit: TransformHit,
  startPoint: Point,
  size: Size,
  onGuides: (guides: CenterGuides) => void,
): DragSession | null {
  const clip = editor.clipFor(clipId);
  if (!clip || !(size.width > 0 && size.height > 0)) return null;
  const frame = editor.ui.currentFrame;
  const start: Transform = { ...clipTransformAt(clip, frame) };
  const isText = clip.mediaType === "text";
  const startScale = isText ? clipTextScaleAt(clip, frame) : 1;
  const scaleKeyframed = clip.scaleTrack !== undefined && keyframeTrackIsActive(clip.scaleTrack);
  const aspect = isText ? undefined : mediaCanvasAspectForClip(editor, clip);
  const rect = clipRectPx(start, size);
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const startAngle = pointerAngle(center, startPoint);
  let lastAngle = startAngle;
  let accumulated = 0;
  let moved = false;

  const resolve = (p: Point, mods: DragModifiers): { edit: TransformEdit; guides: CenterGuides } => {
    const delta: Size = { width: p.x - startPoint.x, height: p.y - startPoint.y };
    switch (hit.kind) {
      case "move": {
        const { transform, guides } = movedTransform(start, delta, size);
        return { edit: { kind: "transform", transform, name: "Change Position" }, guides };
      }
      case "resize": {
        const local = toLocalDelta(delta, start.rotation);
        if (isText) {
          const value = textScaleFromDrag(local, hit.corner, start, startScale, size);
          return { edit: { kind: "textScale", value, scaleKeyframed }, guides: noGuides };
        }
        const lock = aspect ?? (mods.shift && start.height > 0 ? start.width / start.height : undefined);
        const transform = resizedTransform(start, hit.corner, local, size, lock, start.rotation !== 0);
        return { edit: { kind: "transform", transform, name: "Change Scale" }, guides: noGuides };
      }
      case "rotate": {
        const angle = pointerAngle(center, p);
        accumulated += angleStep(lastAngle, angle);
        lastAngle = angle;
        const { rotation, guides } = rotationFromDrag(start.rotation + accumulated, mods.shift);
        return { edit: { kind: "rotation", degrees: rotation }, guides: guides ? { x: true, y: true } : noGuides };
      }
    }
  };

  return {
    move(p, mods) {
      const { edit, guides } = resolve(p, mods);
      moved = true;
      onGuides(guides);
      applyEdit(editor, clipId, edit);
    },
    commit(p, mods) {
      onGuides(noGuides);
      if (!moved) return;
      commitEdit(editor, clipId, resolve(p, mods).edit);
    },
    cancel() {
      onGuides(noGuides);
      if (moved) revertClipProperty(editor, clipId);
    },
  };
}

/** Crop pan / corner resize of one non-text clip at the playhead; axes follow the clip's rotation. */
export function beginCropDrag(editor: Editor, clipId: string, hit: CropHit, startPoint: Point, size: Size): DragSession | null {
  const clip = editor.clipFor(clipId);
  if (!clip || !(size.width > 0 && size.height > 0)) return null;
  const frame = editor.ui.currentFrame;
  const start = { ...clipCropAt(clip, frame) };
  const transform = clipTransformAt(clip, frame);
  const clipSize: Size = { width: transform.width * size.width, height: transform.height * size.height };
  const target = cropAspectLockPixelAspect(editor.ui.cropAspectLock);
  const dims = sourceDimensions(editor, clip);
  const aspectN = target !== undefined && dims ? target / (dims.width / dims.height) : undefined;
  let moved = false;

  const resolve = (p: Point) => {
    const local = toLocalDelta({ width: p.x - startPoint.x, height: p.y - startPoint.y }, transform.rotation);
    return hit.kind === "pan" ? pannedCrop(start, local, clipSize) : resizedCrop(start, hit.corner, local, clipSize, aspectN);
  };

  return {
    move(p) {
      moved = true;
      applyCrop(editor, clipId, resolve(p));
    },
    commit(p) {
      if (moved) commitCrop(editor, clipId, resolve(p));
    },
    cancel() {
      if (moved) revertClipProperty(editor, clipId);
    },
  };
}
