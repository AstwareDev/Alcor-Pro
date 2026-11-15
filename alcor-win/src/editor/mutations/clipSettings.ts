import { clipBlurKeyframeTrack, clipSetBlurKeyframeTrack, gaussianBlurType, type Clip, type ClipType } from "../../model";
import type { Editor } from "../editor";
import { clipClipboardEntries } from "./clipboard";
import { commitClipProperties } from "./clipMutations";
import { copyClip, deepEqual } from "./core";
import { editorHooks } from "./hooks";

export interface ClipSettingsSnapshot {
  sourceClipId: string;
  clip: Clip;
  mediaType: ClipType;
}

export interface ClipSettingsTransferResult {
  changedClipIds: string[];
  unchangedClipIds: string[];
}

export type ClipSettingsTransferError =
  | { kind: "emptyTargets" }
  | { kind: "clipNotFound"; id: string }
  | { kind: "incompatibleType"; source: ClipType; targetId: string; target: ClipType };

/** Thrown by `applyClipSettings` / `clipSettingsSnapshot`; `error` carries the Swift enum case. */
export class ClipSettingsTransferFailure extends Error {
  constructor(readonly error: ClipSettingsTransferError) {
    super(clipSettingsTransferErrorDescription(error));
  }
}

export function clipSettingsTransferErrorDescription(e: ClipSettingsTransferError): string {
  switch (e.kind) {
    case "emptyTargets":
      return "Provide at least one target clip.";
    case "clipNotFound":
      return `Clip not found: ${e.id}`;
    case "incompatibleType":
      return `Clip ${e.targetId} is ${e.target}; copied settings require ${e.source} clips.`;
  }
}

export function copiedClipSettings(editor: Editor, mediaType: ClipType): ClipSettingsSnapshot | null {
  const sources = clipClipboardEntries(editor)
    .map((e) => e.clip)
    .filter((c) => c.mediaType === mediaType);
  const source = sources[0];
  if (sources.length !== 1 || !source) return null;
  return { sourceClipId: source.id, clip: source, mediaType: source.mediaType };
}

export function pasteClipSettingsFromClipboard(editor: Editor, clipIds: readonly string[]): void {
  let mediaType: ClipType | undefined;
  for (const id of clipIds) {
    const t = editor.clipFor(id)?.mediaType;
    if (t !== undefined) {
      mediaType = t;
      break;
    }
  }
  const settings = mediaType === undefined ? null : copiedClipSettings(editor, mediaType);
  if (!settings) {
    editor.refuseWithToast("Copy one clip of the same type and try again.");
    return;
  }
  try {
    applyClipSettings(editor, settings, clipIds);
  } catch (error) {
    if (!(error instanceof ClipSettingsTransferFailure)) throw error;
    editor.refuseWithToast("Select compatible clips and paste settings again.");
  }
}

export function clipSettingsSnapshot(editor: Editor, clipId: string): ClipSettingsSnapshot {
  const clip = editor.clipFor(clipId);
  if (!clip) throw new ClipSettingsTransferFailure({ kind: "clipNotFound", id: clipId });
  const copy = copyClip(clip);
  return { sourceClipId: clipId, clip: copy, mediaType: copy.mediaType };
}

export function compatibleClipSettingsTargets(editor: Editor, clipIds: readonly string[], snapshot: ClipSettingsSnapshot): string[] {
  return clipIds.filter((id) => id !== snapshot.sourceClipId && editor.clipFor(id)?.mediaType === snapshot.mediaType);
}

export function applyClipSettings(
  editor: Editor,
  snapshot: ClipSettingsSnapshot,
  targetClipIdsIn: readonly string[],
  actionName = "Paste Clip Settings",
): ClipSettingsTransferResult {
  const seen = new Set<string>();
  const targetClipIds = targetClipIdsIn.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (targetClipIds.length === 0) throw new ClipSettingsTransferFailure({ kind: "emptyTargets" });

  const replacements = new Map<string, Clip>();
  for (const clipId of targetClipIds) {
    const target = editor.clipFor(clipId);
    if (!target) throw new ClipSettingsTransferFailure({ kind: "clipNotFound", id: clipId });
    if (target.mediaType !== snapshot.mediaType) {
      throw new ClipSettingsTransferFailure({
        kind: "incompatibleType",
        source: snapshot.mediaType,
        targetId: clipId,
        target: target.mediaType,
      });
    }
    replacements.set(clipId, clipId === snapshot.sourceClipId ? copyClip(target) : applyingStaticSettings(editor, snapshot.clip, target));
  }

  const changedClipIds = targetClipIds.filter((id) => {
    const current = editor.clipFor(id);
    const replacement = replacements.get(id);
    return current !== null && replacement !== undefined && !deepEqual(current, replacement);
  });
  const changed = new Set(changedClipIds);
  commitClipProperties(
    editor,
    changedClipIds,
    (clip) => replacements.get(clip.id),
    actionName,
  );
  return { changedClipIds, unchangedClipIds: targetClipIds.filter((id) => !changed.has(id)) };
}

function applyingStaticSettings(editor: Editor, source: Clip, target: Clip): Clip {
  const result = copyClip(target);
  const blurTrack = clipBlurKeyframeTrack(target);
  const effects = source.effects?.flatMap((effect) => {
    if (source.mediaType === "text" && effect.type === gaussianBlurType) return [];
    const copy = structuredClone(effect);
    for (const param of Object.values(copy.params)) delete param.track;
    return [copy];
  });
  if (effects && effects.length > 0) result.effects = effects;
  else delete result.effects;

  switch (source.mediaType) {
    case "audio":
      result.volume = source.volume;
      break;
    case "text": {
      result.opacity = source.opacity;
      assignOptional(result, "textStyle", source.textStyle);
      assignOptional(result, "textAnimation", source.textAnimation);
      assignOptional(result, "textFillMode", source.textFillMode);
      editorHooks.fitTextClipToContentIfNeeded?.(editor, result, editor.timeline.width, editor.timeline.height);
      result.transform.centerX = source.transform.centerX;
      result.transform.centerY = source.transform.centerY;
      result.transform.rotation = source.transform.rotation;
      result.transform.flipHorizontal = source.transform.flipHorizontal;
      result.transform.flipVertical = source.transform.flipVertical;
      break;
    }
    case "video":
    case "image":
    case "lottie":
    case "sequence":
      result.opacity = source.opacity;
      result.transform = structuredClone(source.transform);
      result.crop = structuredClone(source.crop);
      result.edgeRounding = source.edgeRounding;
      result.edgeSoftness = source.edgeSoftness;
      assignOptional(result, "blendMode", source.blendMode);
      break;
    case "subtitle":
      // Asset-only type; never a clip's mediaType.
      break;
  }
  if (blurTrack) clipSetBlurKeyframeTrack(result, structuredClone(blurTrack));
  return result;
}

function assignOptional<K extends "textStyle" | "textAnimation" | "textFillMode" | "blendMode">(
  clip: Clip,
  key: K,
  value: Clip[K],
): void {
  if (value === undefined) delete clip[key];
  else clip[key] = structuredClone(value);
}
