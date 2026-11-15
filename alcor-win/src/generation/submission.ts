// Ports of Submission/{Video,Image,Audio}GenerationSubmission and GenerationInput+AudioSource: they turn the form state
// into a `GenerationPlan` the service executes.
import { Defaults, type ClipType, type GenerationInput, type MediaAsset } from "../model";
import {
  audioCategory, audioSupportsReferences, audioUsesSourceURL, videoRequiresSourceVideo,
  type AudioEntry, type ImageEntry, type VideoEntry,
} from "./modelConfig";
import {
  videoEditReferences, videoTextToVideoReferences, type VideoInputAssets,
} from "./inputAssets";
import type { PreprocessHooks } from "./referencePreparation";
import { downscaleIfNeeded, extractAudioTrack, transcodeIfNeeded } from "./preprocessing/preprocessors";
import type { AudioParams, GenerationParams, ImageParams, LocalReference, VideoParams } from "./providers/types";
import { trimmedSourceDurationSeconds, trimmedSourceHasTrim, type TrimmedSource } from "./trimmedSource";

export interface GenerationPlan extends PreprocessHooks {
  genInput: GenerationInput;
  assetType: ClipType;
  placeholderDuration: number;
  references: MediaAsset[];
  trimmedSourceOverride?: TrimmedSource;
  name?: string;
  numImages: number;
  folderId?: string;
  fileExtension: string;
  /** `refs` are in `references` order, after preprocessing. */
  buildParams: (refs: LocalReference[]) => GenerationParams;
  /** Records the references in the stored input; `sourcePaths` are the original asset files in `references` order. */
  snapshotRefs?: (input: GenerationInput, sourcePaths: string[]) => void;
}

/** `GenerationInput.setAudioSourceAsset` */
export function setAudioSourceAsset(input: GenerationInput, asset: MediaAsset): boolean {
  switch (asset.type) {
    case "audio":
      input.referenceAudioAssetIds = [asset.id];
      delete input.referenceVideoAssetIds;
      return true;
    case "video":
      input.referenceVideoAssetIds = [asset.id];
      delete input.referenceAudioAssetIds;
      return true;
    default:
      return false;
  }
}

const assetIds = (assets: readonly MediaAsset[]): string[] | undefined => (assets.length === 0 ? undefined : assets.map((a) => a.id));

// MARK: - Video

function splitVideoRefs(refs: LocalReference[], frameCount: number, imageCount: number, videoCount: number, audioCount: number) {
  const frames = refs.slice(0, frameCount);
  const rest = refs.slice(frameCount);
  return {
    frames,
    imageRefs: rest.slice(0, imageCount),
    videoRefs: rest.slice(imageCount, imageCount + videoCount),
    audioRefs: rest.slice(imageCount + videoCount, imageCount + videoCount + audioCount),
  };
}

export function makeVideoSubmission(p: {
  genInput: GenerationInput;
  model: VideoEntry;
  inputAssets: VideoInputAssets;
  placeholderDuration: number;
  trimmedSourceOverride?: TrimmedSource;
  name?: string;
  folderId?: string;
  generateAudio: boolean;
}): GenerationPlan {
  const { model, inputAssets, trimmedSourceOverride: trim } = p;
  const caps = model.uiCapabilities;
  const genInput: GenerationInput = { ...p.genInput };
  const outputName = p.name ?? (caps.supportsPrompt === false ? model.displayName : undefined);
  const counts = {
    frames: videoRequiresSourceVideo(model) || inputAssets.sourceVideo ? (inputAssets.sourceVideo ? 1 : 0) : inputAssets.frames.length,
    images: inputAssets.imageRefs.length,
    videos: inputAssets.videoRefs.length,
    audios: inputAssets.audioRefs.length,
  };
  const snapshotRefs = (input: GenerationInput, paths: string[]): void => {
    const split = splitVideoRefs(paths.map((path) => ({ path, type: "image" as const })), counts.frames, counts.images, counts.videos, counts.audios);
    const set = (key: "imageURLs" | "referenceImageURLs" | "referenceVideoURLs" | "referenceAudioURLs", list: LocalReference[]) => {
      if (list.length === 0) delete input[key];
      else input[key] = list.map((r) => r.path);
    };
    set("imageURLs", split.frames);
    set("referenceImageURLs", split.imageRefs);
    set("referenceVideoURLs", split.videoRefs);
    set("referenceAudioURLs", split.audioRefs);
  };
  const common = {
    placeholderDuration: p.placeholderDuration,
    assetType: "video" as const,
    ...(trim ? { trimmedSourceOverride: trim } : {}),
    ...(outputName !== undefined ? { name: outputName } : {}),
    ...(p.folderId !== undefined ? { folderId: p.folderId } : {}),
    numImages: 1,
    fileExtension: "mp4",
    snapshotRefs,
  };

  genInput.referenceImageAssetIds = assetIds(inputAssets.imageRefs);
  genInput.referenceVideoAssetIds = assetIds(inputAssets.videoRefs);
  genInput.referenceAudioAssetIds = assetIds(inputAssets.audioRefs);
  for (const k of ["referenceImageAssetIds", "referenceVideoAssetIds", "referenceAudioAssetIds"] as const) {
    if (genInput[k] === undefined) delete genInput[k];
  }

  if (videoRequiresSourceVideo(model) || inputAssets.sourceVideo) {
    const sourceVideoDuration = trim && trimmedSourceHasTrim(trim) ? trimmedSourceDurationSeconds(trim) : inputAssets.sourceVideo?.duration;
    if (inputAssets.sourceVideo) genInput.imageURLAssetIds = [inputAssets.sourceVideo.id];
    else delete genInput.imageURLAssetIds;
    const maxRes = caps.maxSourceVideoResolution;
    const encoding = caps.requiredSourceVideoEncoding;
    return {
      ...common,
      genInput,
      references: videoEditReferences(inputAssets),
      buildParams: (refs) => {
        const urls = splitVideoRefs(refs, counts.frames, counts.images, counts.videos, counts.audios);
        const params: VideoParams = {
          kind: "video",
          prompt: genInput.prompt,
          duration: genInput.duration,
          aspectRatio: genInput.aspectRatio,
          ...(genInput.resolution !== undefined ? { resolution: genInput.resolution } : {}),
          ...(sourceVideoDuration !== undefined ? { sourceVideoDuration } : {}),
          ...(urls.frames[0] ? { sourceVideo: urls.frames[0] } : {}),
          referenceImages: urls.imageRefs,
          referenceVideos: urls.videoRefs,
          referenceAudios: urls.audioRefs,
          generateAudio: p.generateAudio,
          ...(genInput.draft !== undefined ? { draft: genInput.draft } : {}),
        };
        return params;
      },
      ...(maxRes || encoding
        ? { preprocessSourceVideo: (path: string) => transcodeIfNeeded(path, maxRes, encoding) }
        : {}),
    };
  }

  if (inputAssets.frames.length > 0) genInput.imageURLAssetIds = assetIds(inputAssets.frames);
  else delete genInput.imageURLAssetIds;
  return {
    ...common,
    genInput,
    references: videoTextToVideoReferences(inputAssets),
    buildParams: (refs) => {
      const urls = splitVideoRefs(refs, counts.frames, counts.images, counts.videos, counts.audios);
      const params: VideoParams = {
        kind: "video",
        prompt: genInput.prompt,
        duration: genInput.duration,
        aspectRatio: genInput.aspectRatio,
        ...(genInput.resolution !== undefined ? { resolution: genInput.resolution } : {}),
        ...(urls.frames[0] ? { startFrame: urls.frames[0] } : {}),
        ...(urls.frames[1] ? { endFrame: urls.frames[1] } : {}),
        referenceImages: urls.imageRefs,
        referenceVideos: urls.videoRefs,
        referenceAudios: urls.audioRefs,
        generateAudio: p.generateAudio,
        ...(genInput.draft !== undefined ? { draft: genInput.draft } : {}),
      };
      return params;
    },
    // currentPath may already be a trimmed extract; the downscale chains onto it.
    ...(inputAssets.videoRefs.length > 0
      ? { preprocessRef: (_i: number, asset: MediaAsset, current: string) => (asset.type === "video" ? downscaleIfNeeded(current) : Promise.resolve(null)) }
      : {}),
  };
}

// MARK: - Image

export function makeImageSubmission(p: {
  genInput: GenerationInput;
  model: ImageEntry;
  references: MediaAsset[];
  name?: string;
  numImages?: number;
  folderId?: string;
}): GenerationPlan {
  const genInput: GenerationInput = { ...p.genInput };
  if (p.references.length === 0) delete genInput.imageURLAssetIds;
  else genInput.imageURLAssetIds = p.references.map((a) => a.id);
  const numImages = p.numImages ?? 1;
  return {
    genInput,
    assetType: "image",
    placeholderDuration: Defaults.imageDurationSeconds,
    references: p.references,
    ...(p.name !== undefined ? { name: p.name } : {}),
    numImages,
    ...(p.folderId !== undefined ? { folderId: p.folderId } : {}),
    fileExtension: "jpg",
    snapshotRefs: (input, paths) => {
      if (paths.length === 0) delete input.imageURLs;
      else input.imageURLs = paths;
    },
    buildParams: (refs) => {
      const params: ImageParams = {
        kind: "image",
        prompt: genInput.prompt,
        aspectRatio: genInput.aspectRatio,
        ...(genInput.resolution !== undefined ? { resolution: genInput.resolution } : {}),
        ...(genInput.quality !== undefined ? { quality: genInput.quality } : {}),
        images: refs,
        numImages,
      };
      return params;
    },
  };
}

// MARK: - Audio

export function audioPlaceholderDuration(model: AudioEntry, params: Pick<AudioParams, "durationSeconds">): number {
  if (params.durationSeconds !== undefined) return params.durationSeconds;
  return audioCategory(model) === "music" ? Defaults.audioMusicDurationSeconds : Defaults.audioTTSDurationSeconds;
}

export function makeAudioSubmission(p: {
  genInput: GenerationInput;
  model: AudioEntry;
  params: AudioParams;
  name?: string;
  folderId?: string;
  references?: MediaAsset[];
  trimmedSourceOverride?: TrimmedSource;
}): GenerationPlan {
  const { model, params } = p;
  const references = p.references ?? [];
  const genInput: GenerationInput = { ...p.genInput };
  const usesReferences = audioSupportsReferences(model);
  if (usesReferences) {
    const imageRefs = references.filter((a) => a.type === "image");
    const audioRefs = references.filter((a) => a.type === "audio");
    const set = (key: "referenceImageAssetIds" | "referenceAudioAssetIds", list: MediaAsset[]) => {
      if (list.length === 0) delete genInput[key];
      else genInput[key] = list.map((a) => a.id);
    };
    set("referenceImageAssetIds", imageRefs);
    set("referenceAudioAssetIds", audioRefs);
  }
  const usesSourceURL = audioUsesSourceURL(model);
  const first = references[0];
  const trim = p.trimmedSourceOverride;
  const shouldExtractAudio = !usesReferences && references.length > 0 && usesSourceURL &&
    (first?.type === "video" || (trim !== undefined && trimmedSourceHasTrim(trim)));
  const extractionTrim = shouldExtractAudio ? trim : undefined;
  const imageCount = genInput.referenceImageAssetIds?.length ?? 0;
  const splitReferences = (refs: LocalReference[]) => ({
    image: imageCount > 0 ? refs[0] : undefined,
    audio: refs.slice(imageCount),
  });
  return {
    genInput,
    assetType: "audio",
    placeholderDuration: audioPlaceholderDuration(model, params),
    references,
    ...(shouldExtractAudio ? {} : trim ? { trimmedSourceOverride: trim } : {}),
    ...(p.name !== undefined ? { name: p.name } : {}),
    numImages: 1,
    ...(p.folderId !== undefined ? { folderId: p.folderId } : {}),
    fileExtension: "mp3",
    ...(shouldExtractAudio
      ? { preprocessRef: (index: number, _asset: MediaAsset, current: string) => (index === 0 ? extractAudioTrack(current, extractionTrim) : Promise.resolve(null)) }
      : {}),
    ...(usesReferences
      ? {
          snapshotRefs: (input: GenerationInput, paths: string[]) => {
            const imagePaths = paths.slice(0, imageCount);
            const audioPaths = paths.slice(imageCount);
            if (imagePaths.length === 0) delete input.referenceImageURLs;
            else input.referenceImageURLs = imagePaths.slice(0, 1);
            if (audioPaths.length === 0) delete input.referenceAudioURLs;
            else input.referenceAudioURLs = audioPaths;
          },
        }
      : {}),
    buildParams: (refs) => {
      const resolved: AudioParams = { ...params };
      if (usesReferences) {
        const split = splitReferences(refs);
        if (split.image) resolved.referenceImage = split.image;
        if (split.audio.length > 0) resolved.referenceAudios = split.audio;
      } else if (refs.length > 0) {
        if (usesSourceURL && resolved.source === undefined) resolved.source = refs[0];
        else if (resolved.video === undefined) resolved.video = refs[0];
      }
      return resolved;
    },
  };
}
