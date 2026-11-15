import {
  VolumeScale,
  animatableProperties,
  clipBlurKeyframeTrack,
  clipBlurRadius,
  clipContainsTimelineFrame,
  clipCropAt,
  clipInterpolation,
  clipKeyframeFrames,
  clipMoveKeyframe,
  clipRawOpacityAt,
  clipRemoveKeyframe,
  clipRotationAt,
  clipSetFade,
  clipSetFadeInterpolation,
  clipSetStaticBlurRadius,
  clipSizeAt,
  clipTopLeftAt,
  clipUpsertBlurKeyframe,
  clipUpsertKeyframe,
  clipSetInterpolation,
  doubleInterpolator,
  keyframeTrackIsActive,
  keyframeTrackSample,
  keyframeTrackUpsert,
  makeAnimPair,
  makeKeyframe,
  makeTextStyle,
  transformTopLeft,
  type AnimatableProperty,
  type Clip,
  type Crop,
  type BezierHandles,
  type FadeEdge,
  type Interpolation,
  type Transform,
} from "../../model";
import type { Editor } from "../editor";
import { mediaCanvasAspectForClip } from "./core";
import { applyClipProperties, applyClipProperty, commitClipProperties, commitClipProperty } from "./clipMutations";
import { editorHooks } from "./hooks";
import { snapshot } from "../../util/snapshot";

/** Port of `activeFrame` (`playheadState.timelineFrame`). */
function activeFrame(editor: Editor): number {
  return editor.ui.currentFrame;
}

// MARK: - Read

export function keyframeFrames(editor: Editor, clipId: string, property: AnimatableProperty): number[] {
  const clip = editor.clipFor(clipId);
  return clip ? clipKeyframeFrames(clip, property) : [];
}

export function hasKeyframe(editor: Editor, clipId: string, property: AnimatableProperty, frame: number): boolean {
  return keyframeFrames(editor, clipId, property).includes(frame);
}

export function previousKeyframeFrame(editor: Editor, clipId: string, property: AnimatableProperty, before: number): number | undefined {
  const frames = keyframeFrames(editor, clipId, property).filter((f) => f < before);
  return frames.length === 0 ? undefined : Math.max(...frames);
}

export function nextKeyframeFrame(editor: Editor, clipId: string, property: AnimatableProperty, after: number): number | undefined {
  const frames = keyframeFrames(editor, clipId, property).filter((f) => f > after);
  return frames.length === 0 ? undefined : Math.min(...frames);
}

export function interpolationAt(editor: Editor, clipId: string, property: AnimatableProperty, frame: number): Interpolation | undefined {
  const clip = editor.clipFor(clipId);
  return clip ? clipInterpolation(clip, property, frame) : undefined;
}

// MARK: - Stamp / remove / clear

export function toggleKeyframe(editor: Editor, clipId: string, property: AnimatableProperty, frame: number): void {
  if (hasKeyframe(editor, clipId, property, frame)) removeKeyframe(editor, clipId, property, frame);
  else stampKeyframe(editor, clipId, property, frame);
}

export function stampKeyframe(editor: Editor, clipId: string, property: AnimatableProperty, frame?: number): void {
  const found = editor.clipFor(clipId);
  if (!found) return;
  const f = frame ?? editor.ui.currentFrame;
  if (!clipContainsTimelineFrame(found, f)) return;
  commitClipProperty(
    editor,
    clipId,
    (clip) => {
      switch (property) {
        case "opacity":
          clipUpsertKeyframe(clip, "opacityTrack", f, clipRawOpacityAt(clip, f));
          break;
        case "position": {
          const tl = clipTopLeftAt(clip, f);
          clipUpsertKeyframe(clip, "positionTrack", f, makeAnimPair(tl.x, tl.y));
          break;
        }
        case "scale": {
          const sz = clipSizeAt(clip, f);
          clipUpsertKeyframe(clip, "scaleTrack", f, makeAnimPair(sz.width, sz.height));
          break;
        }
        case "rotation":
          clipUpsertKeyframe(clip, "rotationTrack", f, clipRotationAt(clip, f));
          break;
        case "crop":
          clipUpsertKeyframe(clip, "cropTrack", f, structuredClone(clipCropAt(clip, f)));
          break;
        case "blur":
          clipUpsertBlurKeyframe(clip, f, clipBlurRadius(clip, f));
          break;
        case "volume": {
          const track = clip.volumeTrack;
          const currentDb = track ? keyframeTrackSample(track, f - clip.startFrame, 0, doubleInterpolator) : 0;
          clipUpsertKeyframe(clip, "volumeTrack", f, currentDb);
          break;
        }
      }
    },
    "Add Keyframe",
  );
}

export function removeKeyframe(editor: Editor, clipId: string, property: AnimatableProperty, frame: number): void {
  commitClipProperty(editor, clipId, (clip) => clipRemoveKeyframe(clip, property, frame), "Delete Keyframe");
}

export function setInterpolation(
  editor: Editor,
  clipId: string,
  property: AnimatableProperty,
  frame: number,
  interpolation: Interpolation,
  bezier?: BezierHandles,
): void {
  commitClipProperty(editor, clipId, (clip) => clipSetInterpolation(clip, property, frame, interpolation, bezier), "Change Interpolation");
}

export interface KeyframeRef {
  clipId: string;
  property: AnimatableProperty;
  /** Absolute timeline frame. */
  frame: number;
}

/** Eases several keyframes at once (across clips and properties) as one undo entry. */
export function setInterpolations(editor: Editor, refs: readonly KeyframeRef[], interpolation: Interpolation, bezier?: BezierHandles): void {
  const clipIds = [...new Set(refs.map((r) => r.clipId))];
  if (clipIds.length === 0) return;
  commitClipProperties(
    editor,
    clipIds,
    (clip) => {
      for (const r of refs) if (r.clipId === clip.id) clipSetInterpolation(clip, r.property, r.frame, interpolation, bezier);
    },
    "Change Interpolation",
  );
}

/** Keyframes F9 acts on: those at the playhead on the selected clips, else every keyframe of the selected clips. */
export function selectedKeyframeRefs(editor: Editor): KeyframeRef[] {
  const atPlayhead: KeyframeRef[] = [];
  const all: KeyframeRef[] = [];
  const frame = editor.ui.currentFrame;
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (!editor.ui.selectedClipIds.has(clip.id)) continue;
      for (const property of animatableProperties) {
        for (const f of clipKeyframeFrames(clip, property)) {
          const ref = { clipId: clip.id, property, frame: f };
          all.push(ref);
          if (f === frame) atPlayhead.push(ref);
        }
      }
    }
  }
  return atPlayhead.length > 0 ? atPlayhead : all;
}

/** After Effects F9: easy ease on the selected keyframes. Returns false when there is nothing to ease. */
export function easyEaseSelectedKeyframes(editor: Editor): boolean {
  const refs = selectedKeyframeRefs(editor);
  if (refs.length === 0) return false;
  setInterpolations(editor, refs, "easeInOut");
  return true;
}

// MARK: - Drag-to-move keyframe

/** Live move during a drag; pair with `commitMoveKeyframe` on release for a single undo entry. */
export function applyMoveKeyframe(editor: Editor, clipId: string, property: AnimatableProperty, fromFrame: number, toFrame: number): void {
  applyClipProperty(editor, clipId, (clip) => clipMoveKeyframe(clip, property, fromFrame, toFrame));
}

export function commitMoveKeyframe(editor: Editor, clipId: string): void {
  commitClipProperty(editor, clipId, () => undefined, "Move Keyframe");
}

// MARK: - Animation-aware property writes

function writeOpacity(editor: Editor, clip: Clip, value: number): void {
  const frame = activeFrame(editor);
  if (clip.opacityTrack && keyframeTrackIsActive(clip.opacityTrack)) {
    if (!clipContainsTimelineFrame(clip, frame)) return;
    clipUpsertKeyframe(clip, "opacityTrack", frame, value);
  } else {
    clip.opacity = value;
  }
}

export function applyOpacity(editor: Editor, clipId: string, value: number): void {
  applyClipProperty(editor, clipId, (clip) => writeOpacity(editor, clip, value));
}

export function commitOpacity(editor: Editor, clipId: string, value: number): void {
  commitClipProperty(editor, clipId, (clip) => writeOpacity(editor, clip, value), "Change Opacity");
}

function blurTrackIsActive(clip: Clip): boolean {
  const track = clipBlurKeyframeTrack(clip);
  return track !== undefined && keyframeTrackIsActive(track);
}

function writeBlur(editor: Editor, clip: Clip, radius: number): void {
  const frame = activeFrame(editor);
  if (blurTrackIsActive(clip)) {
    if (!clipContainsTimelineFrame(clip, frame)) return;
    clipUpsertBlurKeyframe(clip, frame, radius);
  } else {
    clipSetStaticBlurRadius(clip, radius);
  }
}

export function applyBlur(editor: Editor, clipIds: readonly string[], radius: number): void {
  applyClipProperties(editor, clipIds, (clip) => writeBlur(editor, clip, radius));
}

export function commitBlur(editor: Editor, clipIds: readonly string[], radius: number): void {
  commitClipProperties(editor, clipIds, (clip) => writeBlur(editor, clip, radius), "Change Blur");
}

function writeRotation(editor: Editor, clip: Clip, valueDeg: number): void {
  if (clip.rotationTrack && keyframeTrackIsActive(clip.rotationTrack)) {
    if (!clipContainsTimelineFrame(clip, activeFrame(editor))) return;
    clipUpsertKeyframe(clip, "rotationTrack", activeFrame(editor), valueDeg);
  } else {
    clip.transform.rotation = valueDeg;
  }
}

export function applyRotation(editor: Editor, clipIds: readonly string[], valueDeg: number): void {
  applyClipProperties(editor, clipIds, (clip) => writeRotation(editor, clip, valueDeg));
}

export function commitRotation(editor: Editor, clipIds: readonly string[], valueDeg: number): void {
  commitClipProperties(editor, clipIds, (clip) => writeRotation(editor, clip, valueDeg), "Change Rotation");
}

function writeVolume(editor: Editor, clip: Clip, valueDb: number): void {
  if (clip.volumeTrack && keyframeTrackIsActive(clip.volumeTrack)) {
    if (!clipContainsTimelineFrame(clip, activeFrame(editor))) return;
    clipUpsertKeyframe(clip, "volumeTrack", activeFrame(editor), valueDb);
  } else {
    clip.volume = VolumeScale.linearFromDb(valueDb);
  }
}

export function applyVolume(editor: Editor, clipId: string, valueDb: number): void {
  applyClipProperty(editor, clipId, (clip) => writeVolume(editor, clip, valueDb));
}

export function commitVolume(editor: Editor, clipId: string, valueDb: number): void {
  commitClipProperty(editor, clipId, (clip) => writeVolume(editor, clip, valueDb), "Change Volume");
}

// MARK: - Fades

export function applyFade(editor: Editor, clipId: string, edge: FadeEdge, frames: number): void {
  applyClipProperty(editor, clipId, (clip) => clipSetFade(clip, edge, frames));
}

export function commitFade(editor: Editor, clipId: string, edge: FadeEdge, frames: number): void {
  commitClipProperty(editor, clipId, (clip) => clipSetFade(clip, edge, frames), edge === "left" ? "Change Fade In" : "Change Fade Out");
}

export function setFadeInterpolation(editor: Editor, clipId: string, edge: FadeEdge, interpolation: Interpolation): void {
  commitClipProperty(editor, clipId, (clip) => clipSetFadeInterpolation(clip, edge, interpolation), "Change Fade Interpolation");
}

// MARK: - Position / scale / size

function writePosition(editor: Editor, clip: Clip, setX: number | undefined, setY: number | undefined): void {
  const frame = activeFrame(editor);
  const tl = clipTopLeftAt(clip, frame);
  const newX = setX ?? tl.x;
  const newY = setY ?? tl.y;
  const sz = clipSizeAt(clip, frame);
  if (clip.positionTrack && keyframeTrackIsActive(clip.positionTrack)) {
    if (!clipContainsTimelineFrame(clip, frame)) return;
    clipUpsertKeyframe(clip, "positionTrack", frame, makeAnimPair(newX, newY));
  } else {
    clip.transform.centerX = newX + sz.width / 2;
    clip.transform.centerY = newY + sz.height / 2;
  }
}

export function applyPositions(editor: Editor, clipIds: readonly string[], setX: number | undefined, setY: number | undefined): void {
  applyClipProperties(editor, clipIds, (clip) => writePosition(editor, clip, setX, setY));
}

export function commitPositions(editor: Editor, clipIds: readonly string[], setX: number | undefined, setY: number | undefined): void {
  commitClipProperties(editor, clipIds, (clip) => writePosition(editor, clip, setX, setY), "Change Position");
}

function writeScale(editor: Editor, clip: Clip, newScale: number): void {
  if (!(Number.isFinite(newScale) && newScale > 0)) return;
  const frame = activeFrame(editor);
  if (clip.mediaType === "text") {
    if (!(clip.scaleTrack && keyframeTrackIsActive(clip.scaleTrack) && clipContainsTimelineFrame(clip, frame))) return;
    const baseScale = clip.textStyle?.fontScale ?? makeTextStyle().fontScale;
    const { width, height } = clip.transform;
    if (!(Number.isFinite(baseScale) && baseScale > 0 && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return;
    const ratio = newScale / baseScale;
    clipUpsertKeyframe(clip, "scaleTrack", frame, makeAnimPair(width * ratio, height * ratio));
    return;
  }
  const aspect = mediaCanvasAspectForClip(editor, snapshot(clip)) ?? 1.0;
  const w = newScale;
  const h = newScale / aspect;
  if (clip.scaleTrack && keyframeTrackIsActive(clip.scaleTrack)) {
    if (!clipContainsTimelineFrame(clip, frame)) return;
    clipUpsertKeyframe(clip, "scaleTrack", frame, makeAnimPair(w, h));
  } else {
    clip.transform.width = w;
    clip.transform.height = h;
  }
}

export function applyScale(editor: Editor, clipId: string, newScale: number): void {
  applyClipProperty(editor, clipId, (clip) => writeScale(editor, clip, newScale));
}

export function commitScale(editor: Editor, clipId: string, newScale: number): void {
  commitClipProperty(editor, clipId, (clip) => writeScale(editor, clip, newScale), "Change Scale");
}

function writeTextSize(editor: Editor, clip: Clip, value: number): void {
  if (clip.mediaType !== "text" || !Number.isFinite(value) || !(value > 0)) return;
  const style = clip.textStyle ? structuredClone(snapshot(clip.textStyle)) : makeTextStyle();
  if (clip.scaleTrack && keyframeTrackIsActive(clip.scaleTrack)) {
    if (!(Number.isFinite(style.fontSize) && style.fontSize > 0)) return;
    writeScale(editor, clip, value / style.fontSize);
  } else {
    const staticScale = Number.isFinite(style.fontScale) && style.fontScale > 0 ? style.fontScale : makeTextStyle().fontScale;
    style.fontSize = value / staticScale;
    clip.textStyle = style;
    editorHooks.fitTextClipToContentIfNeeded?.(editor, clip, editor.timeline.width, editor.timeline.height);
  }
}

export function applyTextSize(editor: Editor, clipId: string, value: number): void {
  applyClipProperty(editor, clipId, (clip) => writeTextSize(editor, clip, value));
}

export function commitTextSize(editor: Editor, clipId: string, value: number): void {
  commitClipProperty(editor, clipId, (clip) => writeTextSize(editor, clip, value), "Change Text Size");
}

export function resetTextSize(editor: Editor, clipIds: readonly string[], defaultSize: number): void {
  commitClipProperties(
    editor,
    clipIds,
    (clip) => {
      if (clip.mediaType !== "text") return;
      delete clip.scaleTrack;
      writeTextSize(editor, clip, defaultSize);
    },
    "Reset Text Size",
  );
}

function writeTransform(editor: Editor, clip: Clip, t: Transform): void {
  const frame = activeFrame(editor);
  const inside = clipContainsTimelineFrame(clip, frame);
  if (clip.positionTrack && keyframeTrackIsActive(clip.positionTrack)) {
    if (inside) {
      const tl = transformTopLeft(t);
      clipUpsertKeyframe(clip, "positionTrack", frame, makeAnimPair(tl.x, tl.y));
    }
  } else {
    clip.transform.centerX = t.centerX;
    clip.transform.centerY = t.centerY;
  }
  if (clip.scaleTrack && keyframeTrackIsActive(clip.scaleTrack)) {
    if (inside) clipUpsertKeyframe(clip, "scaleTrack", frame, makeAnimPair(t.width, t.height));
  } else {
    clip.transform.width = t.width;
    clip.transform.height = t.height;
  }
  if (clip.rotationTrack && keyframeTrackIsActive(clip.rotationTrack)) {
    if (inside) clipUpsertKeyframe(clip, "rotationTrack", frame, t.rotation);
  } else {
    clip.transform.rotation = t.rotation;
  }
}

export function applyTransform(editor: Editor, clipId: string, newTransform: Transform): void {
  applyClipProperty(editor, clipId, (clip) => writeTransform(editor, clip, newTransform));
}

export function commitTransform(editor: Editor, clipId: string, newTransform: Transform, actionName = "Change Transform"): void {
  commitClipProperty(editor, clipId, (clip) => writeTransform(editor, clip, newTransform), actionName);
}

function writeCrop(editor: Editor, clip: Clip, newCrop: Crop): void {
  if (clip.cropTrack && keyframeTrackIsActive(clip.cropTrack)) {
    if (!clipContainsTimelineFrame(clip, activeFrame(editor))) return;
    clipUpsertKeyframe(clip, "cropTrack", activeFrame(editor), structuredClone(newCrop));
  } else {
    clip.crop = structuredClone(newCrop);
  }
}

export function applyCrop(editor: Editor, clipId: string, newCrop: Crop): void {
  applyClipProperty(editor, clipId, (clip) => writeCrop(editor, clip, newCrop));
}

export function commitCrop(editor: Editor, clipId: string, newCrop: Crop): void {
  commitClipProperty(editor, clipId, (clip) => writeCrop(editor, clip, newCrop), "Change Crop");
}

// MARK: - Volume keyframe 2D drag (rubber band)

export function applyMoveVolumeKeyframe(editor: Editor, clipId: string, fromFrame: number, toFrame: number, newDb: number): void {
  applyClipProperty(editor, clipId, (clip) => {
    const fromOffset = fromFrame - clip.startFrame;
    const toOffset = toFrame - clip.startFrame;
    const track = clip.volumeTrack;
    if (!track) return;
    const idx = track.keyframes.findIndex((k) => k.frame === fromOffset);
    if (idx < 0) return;
    const old = track.keyframes[idx] as { interpolationOut: Interpolation; bezier?: BezierHandles };
    track.keyframes.splice(idx, 1);
    keyframeTrackUpsert(track, makeKeyframe(toOffset, newDb, old.interpolationOut, old.bezier));
  });
}

export function commitMoveVolumeKeyframe(editor: Editor, clipId: string): void {
  commitClipProperty(editor, clipId, () => undefined, "Move Keyframe");
}

// MARK: - Batch commits (one undo entry across clips)

/** Commits an opacity / scale / text-size / blur / volume value to every clip as a single undo entry. */
export function commitScalarProperty(
  editor: Editor,
  clipIds: readonly string[],
  property: "opacity" | "scale" | "blur" | "volume",
  value: number,
  actionName: string,
): void {
  commitClipProperties(
    editor,
    clipIds,
    (clip) => {
      switch (property) {
        case "opacity": return writeOpacity(editor, clip, value);
        case "scale": return clip.mediaType === "text" ? writeTextSize(editor, clip, value) : writeScale(editor, clip, value);
        case "blur": return writeBlur(editor, clip, value);
        case "volume": return writeVolume(editor, clip, value);
      }
    },
    actionName,
  );
}

export function commitFades(editor: Editor, clipIds: readonly string[], edge: FadeEdge, frames: number): void {
  commitClipProperties(editor, clipIds, (clip) => clipSetFade(clip, edge, frames), edge === "left" ? "Change Fade In" : "Change Fade Out");
}
