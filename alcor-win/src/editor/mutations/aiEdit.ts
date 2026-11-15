// Port of EditorViewModel+AIEdit.swift: the clip-aware "AI Edit" entry points that seed the generation panel.
import { clipSourceFramesConsumed, clipTypeIsVisual, type Clip, type GenerationInput, type MediaAsset } from "../../model";
import { upscaleModelsFor } from "../../generation/catalog";
import { availableAudioTransforms, audioTransformCopy, type AudioTransformEditKind } from "../../generation/edit/audioTransformEditKind";
import { availableEditActions, type EditAction } from "../../generation/edit/editAction";
import {
  audioTransformSeed, createVideoSeed, editSeed, lipSyncSeed, reframeSeed, upscaleSeed, videoAudioSeed,
} from "../../generation/edit/editSubmitter";
import { videoToAudioKinds, type VideoToAudioEditKind } from "../../generation/edit/videoToAudioEditKind";
import {
  pendingGeneration, type PendingAudioPlacement, type PendingTransitionPlacement,
} from "../../generation/generationState";
import { upscaleSupports, type UpscaleEntry } from "../../generation/modelConfig";
import { providersWithKeys } from "../../generation/providers/registry";
import { trimmedSourceDurationSeconds, type TrimmedSource } from "../../generation/trimmedSource";
import type { Editor } from "../editor";

/** Whether any provider can take a generation right now. */
export function aiEditAllowed(): boolean {
  return providersWithKeys().size > 0;
}

function clipAsset(editor: Editor, clipId: string): { clip: Clip; asset: MediaAsset } | null {
  const clip = editor.clipFor(clipId);
  const asset = clip ? editor.mediaAsset(clip.mediaRef) : undefined;
  return clip && asset ? { clip, asset } : null;
}

export function aiEditTrimmedSource(editor: Editor, clipId: string): TrimmedSource | null {
  const found = clipAsset(editor, clipId);
  if (!found) return null;
  const { clip, asset } = found;
  if ((asset.type !== "video" && asset.type !== "audio") || !(clip.trimStartFrame > 0 || clip.trimEndFrame > 0)) return null;
  return {
    sourceURL: asset.url,
    trimStartFrame: clip.trimStartFrame,
    trimEndFrame: clip.trimEndFrame,
    sourceFramesConsumed: clipSourceFramesConsumed(clip),
    fps: editor.timeline.fps,
  };
}

export function aiEditActions(editor: Editor, clipId: string): EditAction[] {
  const found = clipAsset(editor, clipId);
  if (!found || !(clipTypeIsVisual(found.clip.mediaType) || found.clip.mediaType === "audio")) return [];
  const trim = aiEditTrimmedSource(editor, clipId);
  return availableEditActions(found.asset, trim ? trimmedSourceDurationSeconds(trim) : undefined);
}

export function aiAudioTransformKinds(editor: Editor, clipId: string): AudioTransformEditKind[] {
  const found = clipAsset(editor, clipId);
  if (!found || !(found.clip.mediaType === "audio" || clipTypeIsVisual(found.clip.mediaType))) return [];
  const trim = aiEditTrimmedSource(editor, clipId);
  return availableAudioTransforms(found.asset, trim ? trimmedSourceDurationSeconds(trim) : undefined);
}

export function aiAudioPlacement(editor: Editor, clipId: string, trimmedSource: TrimmedSource | null, actionName: string): PendingAudioPlacement | null {
  const found = clipAsset(editor, clipId);
  if (!found) return null;
  const { clip, asset } = found;
  const fps = Math.max(1, editor.timeline.fps);
  const span = trimmedSource ? trimmedSourceDurationSeconds(trimmedSource) : asset.duration > 0 ? asset.duration : clip.durationFrames / fps;
  return { startFrame: clip.startFrame, spanSeconds: Math.max(span, 1 / fps), actionName };
}

// MARK: - Seeding

export const transitionSeedTasks = new WeakMap<Editor, AbortController>();

export function cancelPendingTransitionSeed(editor: Editor): void {
  transitionSeedTasks.get(editor)?.abort();
  transitionSeedTasks.delete(editor);
}

export interface SeedOptions {
  replacementClipId?: string;
  trimmedSource?: TrimmedSource | null;
  audioPlacement?: PendingAudioPlacement | null;
  transitionPlacement?: PendingTransitionPlacement | null;
}

export function seedGenerationPanel(editor: Editor, asset: MediaAsset, stored: GenerationInput, options: SeedOptions = {}): void {
  if (!options.transitionPlacement) cancelPendingTransitionSeed(editor);
  const pending = pendingGeneration(editor);
  pending.replacementClipId = options.replacementClipId ?? null;
  pending.trimmedSource = options.trimmedSource ?? null;
  pending.audioPlacement = options.audioPlacement ?? null;
  pending.transitionPlacement = options.transitionPlacement ?? null;
  pending.panelSeed = { asset, stored };
  editor.ui.showGenerationPanel = true;
}

export function clearPendingGenerationPanelState(editor: Editor, preservingReplacement = false): void {
  cancelPendingTransitionSeed(editor);
  const pending = pendingGeneration(editor);
  if (!preservingReplacement) pending.replacementClipId = null;
  pending.trimmedSource = null;
  pending.audioPlacement = null;
  pending.transitionPlacement = null;
  pending.panelSeed = null;
}

// MARK: - Clip-aware actions (trim + replace-on-complete where applicable)

/** Edit: seed the panel with the trimmed range, replacing the clip's source on completion. */
export function beginAIEdit(editor: Editor, clipId: string): void {
  const found = clipAsset(editor, clipId);
  if (!found || !clipTypeIsVisual(found.clip.mediaType)) return;
  const stored = editSeed(found.asset);
  if (!stored) return;
  seedGenerationPanel(editor, found.asset, stored, { replacementClipId: clipId, trimmedSource: aiEditTrimmedSource(editor, clipId) });
}

export function beginAIReframe(editor: Editor, clipId: string): void {
  const found = clipAsset(editor, clipId);
  if (!found || found.clip.mediaType !== "video") return;
  const trim = aiEditTrimmedSource(editor, clipId);
  const stored = reframeSeed(found.asset, undefined, trim ?? undefined);
  if (!stored) return;
  seedGenerationPanel(editor, found.asset, stored, { replacementClipId: clipId, trimmedSource: trim });
}

export function beginAILipSync(editor: Editor, clipId: string): void {
  const found = clipAsset(editor, clipId);
  if (!found || found.clip.mediaType !== "video") return;
  const stored = lipSyncSeed(found.asset);
  if (!stored) return;
  seedGenerationPanel(editor, found.asset, stored, { replacementClipId: clipId, trimmedSource: aiEditTrimmedSource(editor, clipId) });
}

export function beginAIUpscale(editor: Editor, clipId: string, model?: UpscaleEntry): void {
  const found = clipAsset(editor, clipId);
  if (!found) return;
  const { asset } = found;
  const trim = aiEditTrimmedSource(editor, clipId);
  const candidates = model ? [model] : asset.type === "image" || asset.type === "video" ? upscaleModelsFor(asset.type) : [];
  const selected = candidates.find((m) => upscaleSupports(m, asset));
  if (!selected) return;
  seedGenerationPanel(editor, asset, upscaleSeed(asset, selected, trim ?? undefined), { replacementClipId: clipId, trimmedSource: trim });
}

/** Music/SFX: output is new audio, so no source replacement; it lands on the timeline at the clip. */
export function beginAIVideoAudio(editor: Editor, clipId: string, kind: VideoToAudioEditKind): void {
  const found = clipAsset(editor, clipId);
  if (!found) return;
  const stored = videoAudioSeed(found.asset, kind);
  if (!stored) return;
  const trim = aiEditTrimmedSource(editor, clipId);
  const placement = aiAudioPlacement(editor, clipId, trim, videoToAudioKinds[kind].timelineActionName);
  if (!placement) return;
  seedGenerationPanel(editor, found.asset, stored, { trimmedSource: trim, audioPlacement: placement });
}

export function beginAIAudioTransform(
  editor: Editor,
  clipId: string,
  kind: AudioTransformEditKind,
  options: { useTrimmedClip?: boolean; placeOnTimeline?: boolean } = {},
): void {
  const found = clipAsset(editor, clipId);
  if (!found) return;
  const trim = (options.useTrimmedClip ?? true) ? aiEditTrimmedSource(editor, clipId) : null;
  const placement = (options.placeOnTimeline ?? true) ? aiAudioPlacement(editor, clipId, trim, audioTransformCopy[kind].timelineActionName) : null;
  if ((options.placeOnTimeline ?? true) && !placement) return;
  const stored = audioTransformSeed(found.asset, kind, placement?.spanSeconds ?? (trim ? trimmedSourceDurationSeconds(trim) : undefined));
  if (!stored) return;
  seedGenerationPanel(editor, found.asset, stored, { trimmedSource: trim, audioPlacement: placement });
}

export function beginAIRerun(editor: Editor, clipId: string): void {
  const found = clipAsset(editor, clipId);
  if (!found?.asset.generationInput) return;
  seedGenerationPanel(editor, found.asset, structuredClone(found.asset.generationInput), { replacementClipId: clipId });
}

export function beginAICreateVideo(editor: Editor, clipId: string, asReference: boolean): void {
  const found = clipAsset(editor, clipId);
  if (!found) return;
  const stored = createVideoSeed(found.asset, asReference);
  if (!stored) return;
  seedGenerationPanel(editor, found.asset, stored, { replacementClipId: clipId });
}
