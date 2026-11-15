// Ports of VideoGenerationSubmission.InputAssets and AudioGenerationSubmission.InputAssets (validation + ordering).
import type { ClipType, MediaAsset } from "../model";
import { pathExtension } from "../media/paths";
import {
  audioMaxReferenceAudios, audioMaxReferenceImages, audioReferencesExclusive, videoRequiresReferenceAudio,
  videoRequiresSourceVideo, type AudioEntry, type VideoEntry,
} from "./modelConfig";
import { trimmedSourceDurationSeconds, trimmedSourceHasTrim, type TrimmedSource } from "./trimmedSource";

export interface VideoInputAssets {
  sourceVideo?: MediaAsset;
  frames: MediaAsset[];
  imageRefs: MediaAsset[];
  videoRefs: MediaAsset[];
  audioRefs: MediaAsset[];
}

export function makeVideoInputAssets(p: Partial<VideoInputAssets> = {}): VideoInputAssets {
  return { sourceVideo: p.sourceVideo, frames: p.frames ?? [], imageRefs: p.imageRefs ?? [], videoRefs: p.videoRefs ?? [], audioRefs: p.audioRefs ?? [] };
}

export const videoAllRefs = (a: VideoInputAssets): MediaAsset[] => [...a.imageRefs, ...a.videoRefs, ...a.audioRefs];
export const videoTextToVideoReferences = (a: VideoInputAssets): MediaAsset[] => [...a.frames, ...videoAllRefs(a)];
export const videoEditReferences = (a: VideoInputAssets): MediaAsset[] => [...(a.sourceVideo ? [a.sourceVideo] : []), ...videoAllRefs(a)];
export const videoTotalRefCount = (a: VideoInputAssets): number => videoAllRefs(a).length;

export function validateVideoInputs(a: VideoInputAssets, model: VideoEntry, trimmedSource?: TrimmedSource): string | undefined {
  if (videoRequiresSourceVideo(model) || a.sourceVideo) return validateEditReferences(a, model, trimmedSource);
  return validateTextToVideoReferences(a, model, trimmedSource);
}

function validateEditReferences(a: VideoInputAssets, model: VideoEntry, trimmedSource: TrimmedSource | undefined): string | undefined {
  const c = model.uiCapabilities;
  if (!a.sourceVideo) return `Model '${model.id}' requires a source video.`;
  if (a.sourceVideo.type !== "video") return "sourceVideoMediaRef must reference a video asset";
  if (a.frames.length > 0) return `${model.displayName} does not accept frame references`;
  if (c.requiresReferenceImage && a.imageRefs.length === 0) return `${model.displayName} requires an image reference`;
  if (videoRequiresReferenceAudio(model) && a.audioRefs.length === 0) return `${model.displayName} requires an audio reference`;
  return validateReferences(a, model, false, trimmedSource);
}

function validateTextToVideoReferences(a: VideoInputAssets, model: VideoEntry, trimmedSource: TrimmedSource | undefined): string | undefined {
  const c = model.uiCapabilities;
  if (a.sourceVideo) return `${model.displayName} does not accept a source video`;
  if (a.frames.length > 2) return `${model.displayName} accepts at most 2 frame references`;
  if (a.frames.length > 0 && !c.supportsFirstFrame) return `${model.displayName} does not accept frame references`;
  if (a.frames.length > 1 && !c.supportsLastFrame) return `${model.displayName} does not accept a last frame`;
  if (c.framesAndReferencesExclusive && a.frames.length > 0 && videoAllRefs(a).length > 0) {
    return `${model.displayName} uses frames OR references, not both. Clear one side.`;
  }
  return validateReferences(a, model, true, trimmedSource);
}

function validateReferences(
  a: VideoInputAssets,
  model: VideoEntry,
  includingFrames: boolean,
  trimmedSource: TrimmedSource | undefined,
): string | undefined {
  const c = model.uiCapabilities;
  const label = a.sourceVideo ? "reference(s)" : "references";
  if (a.imageRefs.length > c.maxReferenceImages) return `${model.displayName} accepts at most ${c.maxReferenceImages} image ${label}`;
  if (a.videoRefs.length > c.maxReferenceVideos) return `${model.displayName} accepts at most ${c.maxReferenceVideos} video ${label}`;
  if (a.audioRefs.length > c.maxReferenceAudios) return `${model.displayName} accepts at most ${c.maxReferenceAudios} audio ${label}`;
  if (c.maxTotalReferences !== undefined && videoTotalRefCount(a) > c.maxTotalReferences) {
    return `${model.displayName} accepts at most ${c.maxTotalReferences} references total`;
  }
  const uploadOrder = includingFrames ? videoTextToVideoReferences(a) : videoEditReferences(a);
  const sum = (assets: MediaAsset[]) => assets.reduce((total, x) => total + referenceDuration(x, trimmedSource, uploadOrder), 0);
  if (c.maxCombinedVideoRefSeconds !== undefined && sum(a.videoRefs) > c.maxCombinedVideoRefSeconds) {
    return `Combined video reference duration exceeds ${Math.trunc(c.maxCombinedVideoRefSeconds)}s`;
  }
  if (c.maxCombinedAudioRefSeconds !== undefined && sum(a.audioRefs) > c.maxCombinedAudioRefSeconds) {
    return `Combined audio reference duration exceeds ${Math.trunc(c.maxCombinedAudioRefSeconds)}s`;
  }
  const groups: [MediaAsset[], ClipType, string][] = [
    [a.imageRefs, "image", "referenceImageMediaRefs"],
    [a.videoRefs, "video", "referenceVideoMediaRefs"],
    [a.audioRefs, "audio", "referenceAudioMediaRefs"],
  ];
  if (includingFrames) groups.unshift([a.frames, "image", "frame references"]);
  for (const [assets, expected, groupLabel] of groups) {
    for (const asset of assets) if (asset.type !== expected) return `${groupLabel} entry '${asset.id}' must be a ${expected} asset`;
  }
  return undefined;
}

/** GenerationService rewrites the first uploaded reference whose path matches the trim. */
function referenceDuration(asset: MediaAsset, trim: TrimmedSource | undefined, uploadOrder: MediaAsset[]): number {
  if (!trim || !trimmedSourceHasTrim(trim) || trim.sourceURL !== asset.url) return asset.duration;
  if (uploadOrder.find((x) => x.url === trim.sourceURL)?.id !== asset.id) return asset.duration;
  return trimmedSourceDurationSeconds(trim);
}

export interface AudioInputAssets {
  imageRefs: MediaAsset[];
  audioRefs: MediaAsset[];
}

export const audioInputReferences = (a: AudioInputAssets): MediaAsset[] => [...a.imageRefs, ...a.audioRefs];

export function validateAudioInputs(a: AudioInputAssets, model: AudioEntry): string | undefined {
  if (a.imageRefs.length > audioMaxReferenceImages(model)) {
    return `${model.displayName} accepts at most ${audioMaxReferenceImages(model)} image reference(s).`;
  }
  if (a.audioRefs.length > audioMaxReferenceAudios(model)) {
    return `${model.displayName} accepts at most ${audioMaxReferenceAudios(model)} audio references.`;
  }
  if (audioReferencesExclusive(model) && a.imageRefs.length > 0 && a.audioRefs.length > 0) {
    return `${model.displayName} uses either image or audio references, not both.`;
  }
  if (a.imageRefs.some((x) => x.type !== "image")) return "Image references must be image assets.";
  const caps = model.uiCapabilities;
  for (const asset of a.audioRefs) {
    if (asset.type !== "audio") return "Audio references must be audio assets.";
    const maximum = caps.maxReferenceAudioSeconds;
    if (maximum !== undefined && (!Number.isFinite(asset.duration) || asset.duration <= 0 || asset.duration > maximum)) {
      return `${asset.name} must be valid audio no longer than ${Math.trunc(maximum)} seconds.`;
    }
    const allowed = caps.referenceAudioExtensions;
    if (allowed && !allowed.includes(pathExtension(asset.url).toLowerCase())) return `${asset.name} must be a WAV or MP3 file.`;
  }
  return undefined;
}
