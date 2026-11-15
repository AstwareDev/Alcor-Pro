import { clipTypeIsVisual, effectInsertIndex, makeEffectParam } from "../../model";
import { effectDescriptor, effectDescriptorMakeEffect } from "../../preview/effects/effectRegistry";
import type { Editor } from "../editor";
import { applyClipProperty, commitClipProperty, revertClipProperty } from "./clipMutations";

export const chromaKeyType = "key.chroma";

/** Narrow seams for the chroma-key eyedropper; the preview feature assigns these. */
export interface ChromaKeyHooks {
  /** Port of `activePreviewTab == .timeline`. Unset means the timeline preview is active. */
  isTimelinePreviewActive?: (editor: Editor) => boolean;
}

export const chromaKeyHooks: ChromaKeyHooks = {};

export function cancelChromaKeySampling(editor: Editor): void {
  const clipId = editor.ui.chromaKeySamplingClipId;
  if (clipId === null) return;
  editor.ui.chromaKeySamplingClipId = null;
  revertClipProperty(editor, clipId);
}

export function toggleChromaKeySampling(editor: Editor, clipId: string): void {
  if (editor.ui.chromaKeySamplingClipId === clipId) {
    cancelChromaKeySampling(editor);
    return;
  }
  cancelChromaKeySampling(editor);
  const clip = editor.clipFor(clipId);
  if (!(chromaKeyHooks.isTimelinePreviewActive?.(editor) ?? true) || !clip || !clipTypeIsVisual(clip.mediaType)) return;
  editor.ui.isPlaying = false;
  applyClipProperty(editor, clipId, (c) => {
    const effect = c.effects?.find((e) => e.type === chromaKeyType);
    if (effect) effect.enabled = false;
  });
  editor.ui.chromaKeySamplingClipId = clipId;
}

export function commitChromaKeySample(editor: Editor, hue: number, clipId: string): void {
  if (editor.ui.chromaKeySamplingClipId !== clipId || !Number.isFinite(hue)) return;
  editor.ui.chromaKeySamplingClipId = null;
  commitClipProperty(
    editor,
    clipId,
    (clip) => {
      const descriptor = effectDescriptor(chromaKeyType);
      if (!descriptor) return;
      const effects = clip.effects ?? [];
      const effect = effects.find((e) => e.type === descriptor.id) ?? effectDescriptorMakeEffect(descriptor);
      effect.enabled = true;
      effect.params["keyHue"] = makeEffectParam({ value: hue });
      effect.params["tolerance"] = makeEffectParam({ value: 0.15 });
      effect.params["softness"] = makeEffectParam({ value: 0.1 });
      const rest = effects.filter((e) => e.type !== descriptor.id);
      rest.splice(effectInsertIndex(rest, descriptor.id), 0, effect);
      clip.effects = rest;
    },
    "Sample Key Color",
  );
}
