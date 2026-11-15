import type { MediaAsset } from "../../model";
import { mediaAssetResolvedDuration } from "../../model";
import { swiftRound } from "../../util/math";
import type { Editor } from "../editor";
import { linkedClipIdsSharingMedia, replaceClipMediaRef } from "./clipMutations";

// Port of EditorViewModel+MediaSwap.swift (the part the agent tool needs; the armed-swap UI session lives elsewhere).

export interface ClipMediaSwapPlan {
  clipId: string;
  oldMediaRef: string;
  newMediaRef: string;
  affectedClipIds: string[];
  changed: boolean;
}

export class ClipMediaSwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipMediaSwapError";
  }
}

function mediaSwapTargetClipIds(editor: Editor, clipId: string): string[] {
  const clip = editor.clipFor(clipId);
  if (!clip) throw new ClipMediaSwapError(`Clip not found: ${clipId}`);
  if (clip.mediaType === "text" || clip.sourceClipType === "text" || clip.sourceClipType === "sequence") {
    throw new ClipMediaSwapError("This clip does not support media source swapping.");
  }
  const ids = [...linkedClipIdsSharingMedia(editor, clipId)].sort();
  if (ids.some((id) => editor.clipFor(id)?.multicamGroupId !== undefined)) {
    throw new ClipMediaSwapError("Use change_cam for multicam clips.");
  }
  return ids;
}

/** Validates the swap and (when `commit`) performs it as one undo step. */
export function swapClipMedia(
  editor: Editor,
  clipId: string,
  replacement: MediaAsset,
  options: { targetClipIds?: string[]; commit?: boolean } = {},
): ClipMediaSwapPlan {
  const { commit = true } = options;
  const anchor = editor.clipFor(clipId);
  if (!anchor) throw new ClipMediaSwapError(`Clip not found: ${clipId}`);
  const ids = options.targetClipIds ?? mediaSwapTargetClipIds(editor, clipId);
  const targets = ids.flatMap((id) => {
    const c = editor.clipFor(id);
    return c ? [c] : [];
  });
  if (targets.length !== ids.length) throw new ClipMediaSwapError("Linked clip not found.");
  if (!targets.every((c) => c.sourceClipType === replacement.type)) {
    throw new ClipMediaSwapError("Replacement must match the clip's source type.");
  }

  const plan: ClipMediaSwapPlan = {
    clipId,
    oldMediaRef: anchor.mediaRef,
    newMediaRef: replacement.id,
    affectedClipIds: ids,
    changed: anchor.mediaRef !== replacement.id,
  };
  if (!plan.changed) return plan;
  if (replacement.type === "video" && !replacement.hasAudio && targets.some((c) => c.mediaType === "audio")) {
    throw new ClipMediaSwapError("Replacement video has no audio for the linked clip.");
  }

  const trimEndFrames: Record<string, number> = {};
  if (replacement.type !== "image") {
    const available = Math.floor(mediaAssetResolvedDuration(replacement) * editor.timeline.fps);
    if (!Number.isSafeInteger(available) || available <= 0) throw new ClipMediaSwapError("Replacement media has no valid duration.");
    for (const clip of targets) {
      const consumed = swiftRound(clip.durationFrames * clip.speed);
      if (!Number.isSafeInteger(consumed) || consumed < 0) throw new ClipMediaSwapError("Clip has invalid source timing.");
      const required = clip.trimStartFrame + consumed;
      if (!Number.isSafeInteger(required) || required < 0 || required > available) {
        throw new ClipMediaSwapError("Replacement media is too short for the clip's source range.");
      }
      trimEndFrames[clip.id] = available - required;
    }
  }

  if (commit) replaceClipMediaRef(editor, plan.clipId, plan.newMediaRef, { trimEndFrames });
  return plan;
}
