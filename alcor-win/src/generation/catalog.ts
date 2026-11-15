// Port of ModelCatalog / ModelRegistry lookups over the provider registry. All lookups prefer models whose provider
// has a key and fall back to the full catalogue so seeds (Edit, Lip Sync…) still resolve while a key is missing.
import { fullCatalog, providersWithKeys } from "./providers/registry";
import type { CatalogEntry } from "./providers/types";
import {
  isAudioEntry, isImageEntry, isUpscaleEntry, isVideoEntry, isReframeModel, videoIsEdit, videoIsLipSync,
  videoRequiresSourceVideo, videoSupportsReferences, type AudioEntry, type ImageEntry, type UpscaleEntry, type VideoEntry,
} from "./modelConfig";

export const videoModels = (): VideoEntry[] => fullCatalog().filter(isVideoEntry);
export const imageModels = (): ImageEntry[] => fullCatalog().filter(isImageEntry);
export const audioModels = (): AudioEntry[] => fullCatalog().filter(isAudioEntry);
export const upscaleModels = (): UpscaleEntry[] => fullCatalog().filter(isUpscaleEntry);

/** Reactive: whether the provider that serves `entry` has a stored key. */
export function isEntryUsable(entry: CatalogEntry): boolean {
  return providersWithKeys().has(entry.providerId);
}

function preferUsable<T extends CatalogEntry>(models: readonly T[], pred: (m: T) => boolean): T | undefined {
  const matching = models.filter(pred);
  return matching.find(isEntryUsable) ?? matching[0];
}

export const editVideoModel = (): VideoEntry | undefined => preferUsable(videoModels(), videoIsEdit);
export const reframeVideoModel = (): VideoEntry | undefined => preferUsable(videoModels(), isReframeModel);
export const lipSyncVideoModel = (): VideoEntry | undefined => preferUsable(videoModels(), videoIsLipSync);
export const firstAndLastFrameModel = (): VideoEntry | undefined =>
  preferUsable(videoModels(), (m) => !videoRequiresSourceVideo(m) && m.uiCapabilities.supportsFirstFrame && m.uiCapabilities.supportsLastFrame);
export const nanoBananaProModel = (): ImageEntry | undefined =>
  preferUsable(imageModels(), (m) => m.id.endsWith("nano-banana-pro") || m.id === "nano-banana-pro");

export function createVideoModel(asReference: boolean): VideoEntry | undefined {
  return preferUsable(videoModels(), (m) =>
    !videoRequiresSourceVideo(m) && (asReference ? videoSupportsReferences(m) : m.uiCapabilities.supportsFirstFrame));
}

export function upscaleModelsFor(type: "image" | "video"): UpscaleEntry[] {
  return upscaleModels().filter((m) => m.uiCapabilities.supportedTypes.includes(type));
}

export function modelDisplayName(id: string, entries: readonly CatalogEntry[] = fullCatalog()): string {
  return entries.find((e) => e.id === id)?.displayName ?? id;
}
