// Port of Edit/EditAction.swift. `enhanceDraft` and the paid-plan gating are not ported (Palmier backend features).
import { mediaAssetIsGenerated, mediaAssetIsGenerating, mediaAssetResolvedDuration, type MediaAsset } from "../../model";
import { audioModels, editVideoModel, lipSyncVideoModel, reframeVideoModel } from "../catalog";
import { validateAudioSpan, validateReframeDuration, validateSourceDuration, type AudioEntry } from "../modelConfig";
import { catalogEntry } from "../providers/registry";
import { videoToAudioKinds, videoToAudioModel, type VideoToAudioEditKind } from "./videoToAudioEditKind";

export type EditAction = "upscale" | "edit" | "rerun" | "lipSync" | "reframe" | "generateMusic" | "generateSFX" | "createVideo";

export const editMaxDurationSeconds = 10;

export type AIEditActionGroup = "enhance" | "audio";

export type EditActionAvailability = { available: true } | { available: false; reason: string };

export function editActionGroup(action: EditAction, mediaType: MediaAsset["type"]): AIEditActionGroup {
  if (action === "generateMusic" || action === "generateSFX") return "audio";
  if (action === "rerun" && mediaType === "audio") return "audio";
  return "enhance";
}

const disabled = (reason: string): EditActionAvailability => ({ available: false, reason });
const generating = disabled("Generation in progress");

function videoAudioAvailability(
  asset: MediaAsset,
  kind: VideoToAudioEditKind,
  effectiveDurationOverride: number | undefined,
  models: readonly AudioEntry[],
): EditActionAvailability {
  if (asset.type !== "video") return disabled(kind === "music" ? "Generate Music only works on video" : "Generate SFX only works on video");
  if (mediaAssetIsGenerating(asset)) return generating;
  const duration = effectiveDurationOverride ?? mediaAssetResolvedDuration(asset);
  if (!(duration > 0)) return disabled("Loading video metadata…");
  const model = videoToAudioModel(kind, models);
  if (!model) return disabled(`${videoToAudioKinds[kind].providerName} model not available`);
  const error = validateAudioSpan(model, duration);
  return error ? disabled(error) : { available: true };
}

export function editActionAvailability(
  action: EditAction,
  asset: MediaAsset,
  effectiveDurationOverride?: number,
): EditActionAvailability {
  switch (action) {
    case "upscale":
      if (asset.type !== "video" && asset.type !== "image") return disabled("Upscale only works on video or images");
      return mediaAssetIsGenerating(asset) ? generating : { available: true };
    case "reframe": {
      if (asset.type !== "video") return disabled("Reframe only works on video");
      if (mediaAssetIsGenerating(asset)) return generating;
      const model = reframeVideoModel();
      if (!model) return disabled("Reframe model not available");
      const error = validateReframeDuration(model, effectiveDurationOverride ?? mediaAssetResolvedDuration(asset));
      return error ? disabled(error) : { available: true };
    }
    case "lipSync": {
      if (asset.type !== "video") return disabled("Lip Sync only works on video");
      if (mediaAssetIsGenerating(asset)) return generating;
      const model = lipSyncVideoModel();
      if (!model) return disabled("Lip Sync model not available");
      const error = validateSourceDuration(model, effectiveDurationOverride ?? mediaAssetResolvedDuration(asset));
      return error ? disabled(error) : { available: true };
    }
    case "edit":
      switch (asset.type) {
        case "video": {
          if (!editVideoModel()) return disabled("Edit model not available");
          const duration = effectiveDurationOverride ?? mediaAssetResolvedDuration(asset);
          if (!(duration > 0)) return disabled("Loading video metadata…");
          if (!(duration <= editMaxDurationSeconds)) {
            return disabled(`Edit supports up to ${editMaxDurationSeconds}s (this is ${Math.round(duration)}s)`);
          }
          break;
        }
        case "image": break;
        case "audio": return disabled("Edit doesn't support audio");
        case "text": return disabled("Edit doesn't support text");
        case "lottie": return disabled("Edit doesn't support Lottie");
        case "sequence": return disabled("Edit doesn't support sequences");
        case "subtitle": return disabled("Edit doesn't support subtitles");
      }
      return mediaAssetIsGenerating(asset) ? generating : { available: true };
    case "generateMusic":
      return videoAudioAvailability(asset, "music", effectiveDurationOverride, audioModels());
    case "generateSFX":
      return videoAudioAvailability(asset, "sfx", effectiveDurationOverride, audioModels());
    case "createVideo":
      if (asset.type !== "image") return disabled("Create Video only works on images");
      return mediaAssetIsGenerating(asset) ? generating : { available: true };
    case "rerun": {
      if (!mediaAssetIsGenerated(asset)) return disabled("Only available for AI-generated media");
      if (mediaAssetIsGenerating(asset)) return generating;
      const modelId = asset.generationInput?.model;
      if (modelId === undefined || !catalogEntry(modelId)) return disabled("Model no longer available");
      return { available: true };
    }
  }
}

export function availableEditActions(asset: MediaAsset, effectiveDurationOverride?: number): EditAction[] {
  let candidates: EditAction[];
  switch (asset.type) {
    case "image": candidates = ["upscale", "edit", "rerun", "createVideo"]; break;
    case "video": candidates = ["upscale", "edit", "rerun", "lipSync", "reframe", "generateMusic", "generateSFX"]; break;
    case "audio":
    case "text": candidates = ["upscale", "edit", "rerun"]; break;
    default: candidates = [];
  }
  return candidates.filter((a) => editActionAvailability(a, asset, effectiveDurationOverride).available);
}

export function actionForKind(kind: VideoToAudioEditKind): EditAction {
  return videoToAudioKinds[kind].action;
}
