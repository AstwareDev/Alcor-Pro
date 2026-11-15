import type { Clip, MediaAsset } from "../../model";
import type { Editor } from "../editor";

/**
 * Narrow seams to features that live outside the editing core. Every hook is optional; when unset the
 * Swift "no restriction / no-op" behaviour applies. Owning features assign these at startup.
 */
export interface EditorHooks {
  /** Port of fitTextClipToContentIfNeeded (needs text measurement). Mutates `clip` in place; returns true if it changed. */
  fitTextClipToContentIfNeeded?: (editor: Editor, clip: Clip, canvasW: number, canvasH: number) => boolean;
  /** Port of prepareMediaVisuals(for:) (thumbnail / waveform warm-up). */
  prepareMediaVisuals?: (editor: Editor, asset: MediaAsset) => void;
  /** Port of closePreviewTab(id: PreviewTab.mediaAssetTabId(for:)) (preview tabs belong to the preview feature). */
  closeMediaAssetPreviewTab?: (editor: Editor, assetId: string) => void;
}

export const editorHooks: EditorHooks = {};
