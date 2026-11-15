// Port of Edit/AudioTransformEditKind.swift.
import type { MediaAsset } from "../../model";
import { audioModels } from "../catalog";
import { audioAcceptsSource, audioCategory, validateAudioSpan, type AudioCategory, type AudioEntry } from "../modelConfig";
import type { EditActionAvailability } from "./editAction";
import { mediaAssetIsGenerating } from "../../model";

export type AudioTransformEditKind = "cleanup" | "dubbing";

export const audioTransformKinds: readonly AudioTransformEditKind[] = ["cleanup", "dubbing"];

export const audioTransformCopy: Record<
  AudioTransformEditKind,
  { title: string; description: string; menuTitle: string; icon: "waveform" | "globe"; timelineActionName: string; category: AudioCategory }
> = {
  cleanup: {
    title: "Voice Cleanup",
    description: "Remove background sound and keep speech",
    menuTitle: "Clean Up Voice…",
    icon: "waveform",
    timelineActionName: "Add Cleaned Voice",
    category: "cleanup",
  },
  dubbing: {
    title: "Dubbing",
    description: "Translate speech into another language",
    menuTitle: "Dub…",
    icon: "globe",
    timelineActionName: "Add Dubbed Voice",
    category: "dubbing",
  },
};

export function audioTransformModel(kind: AudioTransformEditKind, models: readonly AudioEntry[] = audioModels()): AudioEntry | undefined {
  const matching = models.filter((m) => audioCategory(m) === audioTransformCopy[kind].category);
  return matching[0];
}

export function audioTransformAvailability(
  kind: AudioTransformEditKind,
  asset: MediaAsset,
  effectiveDurationOverride?: number,
  models?: readonly AudioEntry[],
): EditActionAvailability {
  const name = audioTransformCopy[kind].title;
  if (asset.type !== "audio" && asset.type !== "video") return { available: false, reason: `${name} requires audio or video` };
  if (asset.type === "video" && !asset.hasAudio) return { available: false, reason: "Video has no audio track" };
  if (mediaAssetIsGenerating(asset)) return { available: false, reason: "Generation in progress" };
  const model = audioTransformModel(kind, models);
  if (!model) return { available: false, reason: `${name} model not available` };
  if (!audioAcceptsSource(model, asset.type)) return { available: false, reason: `${model.displayName} does not accept this media` };
  const duration = effectiveDurationOverride ?? asset.duration;
  if (!(duration > 0)) return { available: false, reason: "Loading media metadata…" };
  const error = validateAudioSpan(model, duration);
  return error ? { available: false, reason: error } : { available: true };
}

export function availableAudioTransforms(asset: MediaAsset, effectiveDurationOverride?: number, models?: readonly AudioEntry[]): AudioTransformEditKind[] {
  return audioTransformKinds.filter((k) => audioTransformAvailability(k, asset, effectiveDurationOverride, models).available);
}
