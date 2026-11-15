import type { MediaAsset } from "../../model";
import type { Editor } from "../editor";
import { mediaSwapTargetClipIds, swapClipMedia } from "./mediaSwap";

// The armed-swap session of EditorViewModel+MediaSwap.swift: "Swap Media" arms a clip, the media panel then
// offers compatible assets, and picking one performs `swapClipMedia`.

export function beginMediaSwap(editor: Editor, clipId: string): void {
  try {
    mediaSwapTargetClipIds(editor, clipId);
  } catch {
    return;
  }
  editor.ui.pendingSwapClipId = clipId;
}

export function cancelMediaSwap(editor: Editor): void {
  if (editor.ui.pendingSwapClipId !== null) editor.ui.pendingSwapClipId = null;
}

/** Name of the media the armed clip currently plays (banner text). */
export function pendingSwapClipName(editor: Editor): string | undefined {
  const id = editor.ui.pendingSwapClipId;
  const clip = id === null ? undefined : editor.clipFor(id);
  return clip ? editor.mediaAsset(clip.mediaRef)?.name : undefined;
}

export function isAssetCompatibleWithPendingSwap(editor: Editor, asset: MediaAsset): boolean {
  const clipId = editor.ui.pendingSwapClipId;
  if (clipId === null) return false;
  try {
    swapClipMedia(editor, clipId, asset, { commit: false });
    return true;
  } catch {
    return false;
  }
}

export function completeMediaSwap(editor: Editor, asset: MediaAsset): void {
  const clipId = editor.ui.pendingSwapClipId;
  if (clipId === null || !editor.clipFor(clipId)) {
    cancelMediaSwap(editor);
    return;
  }
  try {
    swapClipMedia(editor, clipId, asset);
  } catch {
    editor.showToast("This source can’t replace the clip.", "error");
    return;
  }
  cancelMediaSwap(editor);
}
