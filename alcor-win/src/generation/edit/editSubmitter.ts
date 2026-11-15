// Ports of Edit/EditSubmitter.swift and its +Seeds / +Upscale / +AudioTransform extensions.
import { Defaults, makeGenerationInput, mediaAssetResolvedDuration, type GenerationInput, type MediaAsset, type UpscaleSettings } from "../../model";
import type { Editor } from "../../editor/editor";
import { swiftRound } from "../../util/math";
import {
  createVideoModel, editVideoModel, lipSyncVideoModel, nanoBananaProModel, reframeVideoModel,
} from "../catalog";
import { getGenerationService, type GenerationService } from "../generationService";
import {
  isReframeModel, upscaleDefaultSettings, upscaleSupports, videoIsLipSync, videoNearestSupportedDuration,
  videoPreferredHighResolution, videoSupportedDurationCovering, type UpscaleEntry, type VideoEntry,
} from "../modelConfig";
import type { LocalReference, UpscaleParams } from "../providers/types";
import { setAudioSourceAsset, type GenerationPlan } from "../submission";
import { trimmedSourceDurationSeconds, trimmedSourceHasTrim, type TrimmedSource } from "../trimmedSource";
import { audioTransformCopy, audioTransformModel, type AudioTransformEditKind } from "./audioTransformEditKind";
import { videoToAudioModel, type VideoToAudioEditKind } from "./videoToAudioEditKind";

export const reframePrompt =
  "The exact same video as @Video1 but fill in to match the output aspect ratio. Keep movement, details, and audio the same as the original audio";

export const transitionPrompt =
  "Create a seamless transition between the first frame and the last frame, one continuous take. No weird movements, effects, or artifacts. Natural and consistent motion that makes sense. No music, just appropriate SFX.";

export function effectiveDuration(asset: MediaAsset, trimmedSource: TrimmedSource | undefined): number {
  const seconds = trimmedSource && trimmedSourceHasTrim(trimmedSource) ? trimmedSourceDurationSeconds(trimmedSource) : asset.duration;
  return Math.max(1, swiftRound(seconds));
}

export function prefixedName(prefix: string, asset: MediaAsset): string {
  const known = ["Upscaled ", "Edited ", "Rerun "].find((p) => asset.name.startsWith(p));
  const base = known ? asset.name.slice(known.length) : asset.name;
  return `${prefix} ${base}`;
}

const emptyInput = (model: string, duration = 0): GenerationInput =>
  makeGenerationInput({ prompt: "", model, duration, aspectRatio: "" });

export function reframeSeed(asset: MediaAsset, model: VideoEntry | undefined = reframeVideoModel(), trimmedSource?: TrimmedSource): GenerationInput | undefined {
  if (!model || asset.type !== "video" || !isReframeModel(model)) return undefined;
  const isPortrait = asset.sourceWidth !== undefined && asset.sourceHeight !== undefined ? asset.sourceHeight > asset.sourceWidth : false;
  const sourceSeconds = trimmedSource && trimmedSourceHasTrim(trimmedSource) ? trimmedSourceDurationSeconds(trimmedSource) : mediaAssetResolvedDuration(asset);
  const stored = makeGenerationInput({
    prompt: reframePrompt,
    model: model.id,
    duration: videoSupportedDurationCovering(model, sourceSeconds),
    aspectRatio: isPortrait ? "16:9" : "9:16",
  });
  const resolution = videoPreferredHighResolution(model);
  if (resolution !== undefined) stored.resolution = resolution;
  stored.referenceVideoAssetIds = [asset.id];
  return stored;
}

export function transitionSeed(model: VideoEntry, firstFrame: MediaAsset, lastFrame: MediaAsset, gapSeconds: number): GenerationInput {
  const stored = makeGenerationInput({
    prompt: transitionPrompt,
    model: model.id,
    duration: videoNearestSupportedDuration(model, gapSeconds),
    aspectRatio: "",
  });
  stored.imageURLAssetIds = [firstFrame.id, lastFrame.id];
  return stored;
}

export function editSeed(asset: MediaAsset): GenerationInput | undefined {
  let modelId: string;
  if (asset.type === "video") {
    const model = editVideoModel();
    if (!model) return undefined;
    modelId = model.id;
  } else if (asset.type === "image") {
    const model = nanoBananaProModel();
    if (!model) return undefined;
    modelId = model.id;
  } else {
    return undefined;
  }
  const stored = emptyInput(modelId);
  stored.imageURLAssetIds = [asset.id];
  return stored;
}

export function lipSyncSeed(asset: MediaAsset, model: VideoEntry | undefined = lipSyncVideoModel()): GenerationInput | undefined {
  if (!model || asset.type !== "video" || !videoIsLipSync(model)) return undefined;
  const stored = emptyInput(model.id);
  stored.imageURLAssetIds = [asset.id];
  return stored;
}

export function createVideoSeed(asset: MediaAsset, asReference: boolean): GenerationInput | undefined {
  const model = createVideoModel(asReference);
  if (!model) return undefined;
  const stored = emptyInput(model.id);
  if (asReference) stored.referenceImageAssetIds = [asset.id];
  else stored.imageURLAssetIds = [asset.id];
  return stored;
}

export function videoAudioSeed(asset: MediaAsset, kind: VideoToAudioEditKind): GenerationInput | undefined {
  const model = videoToAudioModel(kind);
  if (asset.type !== "video" || !model) return undefined;
  const stored = emptyInput(model.id, Math.max(0, swiftRound(asset.duration)));
  return setAudioSourceAsset(stored, asset) ? stored : undefined;
}

export function audioTransformSeed(asset: MediaAsset, kind: AudioTransformEditKind, durationOverride?: number): GenerationInput | undefined {
  const model = audioTransformModel(kind);
  if (!model) return undefined;
  const stored = emptyInput(model.id, Math.max(1, swiftRound(durationOverride ?? asset.duration)));
  return setAudioSourceAsset(stored, asset) ? stored : undefined;
}

export { audioTransformCopy };

// MARK: - Upscale

export function upscaleSeed(asset: MediaAsset, model: UpscaleEntry, trimmedSource?: TrimmedSource): GenerationInput {
  const input = emptyInput(model.id, effectiveDuration(asset, trimmedSource));
  input.upscaleSettings = upscaleDefaultSettings(model);
  input.imageURLAssetIds = [asset.id];
  if (asset.sourceWidth !== undefined) input.upscaleSourceWidth = asset.sourceWidth;
  if (asset.sourceHeight !== undefined) input.upscaleSourceHeight = asset.sourceHeight;
  if (asset.sourceFPS !== undefined) input.upscaleSourceFPS = asset.sourceFPS;
  return input;
}

export function flattenUpscaleSettings(settings: UpscaleSettings): Record<string, string | number | boolean> {
  return { ...settings.selections, ...settings.numbers, ...settings.toggles };
}

export function makeUpscalePlan(asset: MediaAsset, model: UpscaleEntry, settings: UpscaleSettings | undefined, trimmedSource: TrimmedSource | undefined): GenerationPlan {
  const duration = effectiveDuration(asset, trimmedSource);
  const genInput = upscaleSeed(asset, model, trimmedSource);
  const resolved = settings ?? upscaleDefaultSettings(model);
  genInput.upscaleSettings = resolved;
  const isImage = asset.type === "image";
  const placeholderDuration = isImage
    ? Defaults.imageDurationSeconds
    : trimmedSource && trimmedSourceHasTrim(trimmedSource)
      ? trimmedSourceDurationSeconds(trimmedSource)
      : asset.duration > 0 ? asset.duration : duration;
  return {
    genInput,
    assetType: asset.type,
    placeholderDuration,
    references: [asset],
    ...(trimmedSource ? { trimmedSourceOverride: trimmedSource } : {}),
    name: prefixedName("Upscaled", asset),
    ...(asset.folderId !== undefined ? { folderId: asset.folderId } : {}),
    numImages: 1,
    fileExtension: isImage ? "jpg" : "mp4",
    buildParams: (refs: LocalReference[]) => {
      const params: UpscaleParams = {
        kind: "upscale",
        source: refs[0],
        durationSeconds: isImage ? 1 : duration,
        ...(asset.sourceWidth !== undefined ? { sourceWidth: asset.sourceWidth } : {}),
        ...(asset.sourceHeight !== undefined ? { sourceHeight: asset.sourceHeight } : {}),
        ...(asset.sourceFPS !== undefined ? { sourceFPS: asset.sourceFPS } : {}),
        settings: flattenUpscaleSettings(resolved),
      };
      return params;
    },
    snapshotRefs: (input, paths) => {
      if (paths.length === 0) delete input.imageURLs;
      else input.imageURLs = paths;
      input.imageURLAssetIds = [asset.id];
    },
  };
}

/** Returns the placeholder's asset id, or undefined when the source or model cannot be upscaled. */
export function submitUpscale(
  editor: Editor,
  asset: MediaAsset,
  model: UpscaleEntry,
  options: {
    settings?: UpscaleSettings;
    trimmedSource?: TrimmedSource;
    onComplete?: (asset: MediaAsset) => void;
    onFailure?: () => void;
    service?: GenerationService;
  } = {},
): string | undefined {
  if (asset.sourceWidth === undefined || asset.sourceHeight === undefined) return undefined;
  if (!upscaleSupports(model, asset)) return undefined;
  if (asset.type === "video" && asset.sourceFPS === undefined) return undefined;
  const plan = makeUpscalePlan(asset, model, options.settings, options.trimmedSource);
  return (options.service ?? getGenerationService()).generate(editor, plan, {
    ...(options.onComplete ? { onComplete: options.onComplete } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
