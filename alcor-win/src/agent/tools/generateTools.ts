import type { Editor } from "../../editor/editor";
import { finalizeGeneratingClip, placeGeneratingAudioClip } from "../../editor/mutations/generatedClips";
import { audioModels, imageModels, isEntryUsable, upscaleModels, videoModels } from "../../generation/catalog";
import { submitUpscale } from "../../generation/edit/editSubmitter";
import { getGenerationService } from "../../generation/generationService";
import {
  makeVideoInputAssets, validateAudioInputs, validateVideoInputs, videoTextToVideoReferences,
  type AudioInputAssets, audioInputReferences,
} from "../../generation/inputAssets";
import {
  audioAcceptsSource, audioAcceptsSourceMedia, audioCategory, audioCategoryLabel, audioInputs, audioMaxReferenceAudios,
  audioMaxReferenceImages, audioReferencesExclusive, audioSupportsReferences, audioUsesSourceURL, billingDurationSeconds,
  draftResolution, upscaleAvailableOptions, upscaleDefaultSettings, upscaleNormalizedSettings, upscaleOptionLabel,
  upscaleSupports, validateAudioParams, validateAudioSpan, validateImage, validateSourceDuration, validateVideo,
  videoIsLipSync, videoRequiresReferenceAudio, videoSupportsPrompt, videoSupportsReferences, videoSupportsSourceVideo,
  videoUsesOutputDuration, type AudioEntry, type ImageEntry, type UpscaleEntry, type VideoEntry,
} from "../../generation/modelConfig";
import { musicHooks } from "../../generation/musicGeneration";
import { allProviders } from "../../generation/providers/registry";
import type { AudioParams, CatalogEntry, LocalReference } from "../../generation/providers/types";
import { makeAudioSubmission, makeImageSubmission, makeVideoSubmission, setAudioSourceAsset } from "../../generation/submission";
import type { TrimmedSource } from "../../generation/trimmedSource";
import { makeGenerationInput, mediaAssetResolvedDuration, type GenerationInput, type MediaAsset, type UpscaleSettings } from "../../model";
import { clipSourceFramesConsumed } from "../../model/timeline";
import { swiftRound } from "../../util/math";
import { jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { resolveFolder } from "./organizeTools";
import { ToolError, argBool, argDouble, argInt, argString, argStringArray, isRecord, requireString } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Generate.swift. Palmier account gating (sign-in, credits, paid plans) does not exist here:
// a model is usable when its provider has an API key. Draft generation and draft enhancement are Palmier-backend
// features the provider contract has no equivalent for, so `draft` is refused and no model reports supportsDraft.

type Json = Record<string, unknown>;

// MARK: - Model resolution

function missingKeyError(entry: CatalogEntry): ToolError {
  const name = allProviders().find((p) => p.id === entry.providerId)?.displayName ?? entry.providerId;
  return new ToolError(`Model '${entry.id}' needs a ${name} API key. Pick a model from list_models, or tell the user to add the key in Settings.`);
}

function resolveModel<T extends CatalogEntry>(requested: string | undefined, all: readonly T[], kind: string): T {
  const usable = all.filter(isEntryUsable);
  if (requested === undefined) {
    const first = usable[0];
    if (first) return first;
    throw new ToolError(
      all.length === 0
        ? "Model catalog not loaded yet. Try again in a moment."
        : `No ${kind} model is available: no provider API key is configured for one. Tell the user to add an API key in Settings.`,
    );
  }
  const match = all.find((m) => m.id === requested);
  if (!match) throw new ToolError(`Unknown model '${requested}'. Available: ${usable.map((m) => m.id).join(", ")}`);
  if (!isEntryUsable(match)) throw missingKeyError(match);
  return match;
}

const videoModelFor = (id: string | undefined): VideoEntry => resolveModel(id, videoModels(), "video");

function draftMode(args: ToolArgs, model: VideoEntry): boolean {
  const draft = argBool(args, "draft") ?? false;
  if (draft) throw new ToolError(`Model '${model.id}' does not support draft generation.`);
  return false;
}

// MARK: - Shared argument helpers

function referenceAssets(context: ToolContext, args: ToolArgs, key: string, label: string): MediaAsset[] {
  return argStringArray(args, key).map((id) => context.executor.asset(id, context.editor, label));
}

function trimmedSource(editor: Editor, args: ToolArgs, source: MediaAsset): TrimmedSource | undefined {
  const clipId = argString(args, "sourceClipId");
  if (clipId === undefined) return undefined;
  const clip = editor.clipFor(clipId);
  if (!clip) throw new ToolError(`sourceClipId not found: ${clipId}`);
  if (clip.mediaRef !== source.id) throw new ToolError(`sourceClipId ${clipId} references a different asset than the source`);
  if (source.type !== "video") throw new ToolError("sourceClipId only applies to video sources");
  if (!(clip.trimStartFrame > 0 || clip.trimEndFrame > 0)) return undefined;
  return {
    sourceURL: source.url,
    trimStartFrame: clip.trimStartFrame,
    trimEndFrame: clip.trimEndFrame,
    sourceFramesConsumed: clipSourceFramesConsumed(clip),
    fps: editor.timeline.fps,
  };
}

/** Swift prints a whole `Double` as "1.0". */
const swiftDouble = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// MARK: - generate_video

export function generateVideo(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const prompt = args.prompt === undefined ? "" : requireString(args, "prompt");
  const enhanceRef = argString(args, "enhanceDraftMediaRef");
  if (enhanceRef !== undefined) {
    context.executor.asset(enhanceRef, editor, "Draft");
    throw new ToolError(`Asset '${enhanceRef}' is not a completed enhanceable draft.`);
  }
  const model = videoModelFor(argString(args, "model"));
  const hasSourceVideo = argString(args, "sourceVideoMediaRef") !== undefined;
  if (hasSourceVideo && !videoSupportsSourceVideo(model)) throw new ToolError(`Model '${model.id}' does not accept a source video.`);
  if (model.uiCapabilities.requiresSourceVideo || hasSourceVideo) return generateVideoEdit(context, args, prompt, model);
  return generateVideoText(context, args, prompt, model);
}

function generateVideoEdit(context: ToolContext, args: ToolArgs, prompt: string, model: VideoEntry): ToolResult {
  const { editor } = context;
  const caps = model.uiCapabilities;
  const sourceRef = argString(args, "sourceVideoMediaRef");
  if (sourceRef === undefined) throw new ToolError(`Model '${model.id}' requires 'sourceVideoMediaRef' pointing to a video asset.`);
  const sourceAsset = context.executor.asset(sourceRef, editor, "Source video");
  const trimmed = trimmedSource(editor, args, sourceAsset);

  const imageRefs = referenceAssets(context, args, "referenceImageMediaRefs", "Reference image");
  const videoRefs = referenceAssets(context, args, "referenceVideoMediaRefs", "Reference video");
  const audioRefs = referenceAssets(context, args, "referenceAudioMediaRefs", "Reference audio");
  const inputAssets = makeVideoInputAssets({ sourceVideo: sourceAsset, imageRefs, videoRefs, audioRefs });
  const inputError = validateVideoInputs(inputAssets, model);
  if (inputError !== undefined) throw new ToolError(inputError);

  const sourceVideoDuration = trimmed ? trimmed.sourceFramesConsumed / Math.max(1, trimmed.fps) : mediaAssetResolvedDuration(sourceAsset);
  const draft = draftMode(args, model);
  let duration: number;
  if (videoUsesOutputDuration(model)) {
    duration = argInt(args, "duration") ?? caps.durations[0] ?? 0;
  } else {
    const billing = billingDurationSeconds(model, sourceVideoDuration, audioRefs[0] ? mediaAssetResolvedDuration(audioRefs[0]) : undefined);
    if (billing === undefined) {
      throw new ToolError(videoIsLipSync(model) ? "Replacement audio has an invalid duration." : "Source video has an invalid duration.");
    }
    duration = billing;
  }
  const aspectRatio = argString(args, "aspectRatio") ?? caps.aspectRatios[0] ?? "";
  const resolution = draft ? draftResolution : (argString(args, "resolution") ?? caps.resolutions?.[0]);
  const usesOutput = videoUsesOutputDuration(model);
  const validation = validateSourceDuration(model, sourceVideoDuration) ??
    validateVideo(model, usesOutput ? duration : 0, usesOutput ? aspectRatio : "", usesOutput ? resolution : undefined);
  if (validation !== undefined) throw new ToolError(validation);

  const genInput: GenerationInput = makeGenerationInput({
    prompt, model: model.id, duration, aspectRatio, ...(resolution !== undefined ? { resolution } : {}), usesSourceVideo: true,
  });
  const name = argString(args, "name");
  const plan = makeVideoSubmission({
    genInput, model, inputAssets,
    placeholderDuration: usesOutput ? Math.max(1, duration) : sourceVideoDuration,
    ...(trimmed ? { trimmedSourceOverride: trimmed } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(sourceAsset.folderId !== undefined ? { folderId: sourceAsset.folderId } : {}),
    generateAudio: true,
  });
  const placeholderId = getGenerationService().generate(editor, plan);
  return ok(`Edit started. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, source: ${sourceAsset.name}`);
}

function generateVideoText(context: ToolContext, args: ToolArgs, prompt: string, model: VideoEntry): ToolResult {
  const { editor } = context;
  const caps = model.uiCapabilities;
  if (prompt === "") throw new ToolError("Empty prompt");

  const draft = draftMode(args, model);
  const duration = argInt(args, "duration") ?? caps.durations[0] ?? 0;
  const aspectRatio = argString(args, "aspectRatio") ?? caps.aspectRatios[0] ?? "";
  const resolution = draft ? draftResolution : (argString(args, "resolution") ?? caps.resolutions?.[0]);
  const validation = validateVideo(model, duration, aspectRatio, resolution);
  if (validation !== undefined) throw new ToolError(validation);

  const frames: MediaAsset[] = [];
  const startRef = argString(args, "startFrameMediaRef");
  if (startRef !== undefined) frames.push(context.executor.asset(startRef, editor, "Start frame"));
  const endRef = argString(args, "endFrameMediaRef");
  if (endRef !== undefined) frames.push(context.executor.asset(endRef, editor, "End frame"));

  const imageRefs = referenceAssets(context, args, "referenceImageMediaRefs", "Image reference");
  const videoRefs = referenceAssets(context, args, "referenceVideoMediaRefs", "Video reference");
  const audioRefs = referenceAssets(context, args, "referenceAudioMediaRefs", "Audio reference");
  const inputAssets = makeVideoInputAssets({ frames, imageRefs, videoRefs, audioRefs });
  const inputError = validateVideoInputs(inputAssets, model);
  if (inputError !== undefined) throw new ToolError(inputError);

  const totalRefs = imageRefs.length + videoRefs.length + audioRefs.length;
  const genInput = makeGenerationInput({
    prompt, model: model.id, duration, aspectRatio, ...(resolution !== undefined ? { resolution } : {}),
  });
  const folderId = resolveFolder(editor, args, videoTextToVideoReferences(inputAssets));
  const name = argString(args, "name");
  const plan = makeVideoSubmission({
    genInput, model, inputAssets, placeholderDuration: Math.max(1, duration),
    ...(name !== undefined ? { name } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
    generateAudio: true,
  });
  const placeholderId = getGenerationService().generate(editor, plan);
  const refSummary = totalRefs > 0 ? `, refs: ${imageRefs.length}img/${videoRefs.length}vid/${audioRefs.length}aud` : "";
  return ok(`Generation started. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, duration: ${duration}s, aspect: ${aspectRatio}${refSummary}`);
}

// MARK: - generate_image

export function generateImage(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const prompt = args.prompt === undefined ? "" : requireString(args, "prompt");
  if (prompt === "") throw new ToolError("Empty prompt");
  const model = resolveModel<ImageEntry>(argString(args, "model"), imageModels(), "image");
  const caps = model.uiCapabilities;
  const aspectRatio = argString(args, "aspectRatio") ?? caps.aspectRatios[0] ?? "";
  const resolution = argString(args, "resolution") ?? caps.resolutions?.[0];
  const quality = argString(args, "quality") ?? caps.qualities?.[caps.qualities.length - 1];
  const refIds = argStringArray(args, "referenceMediaRefs");
  const validation = validateImage(model, { aspectRatio, resolution, quality, imageRefCount: refIds.length, numImages: 1 });
  if (validation !== undefined) throw new ToolError(validation);
  const refs = refIds.map((id) => {
    const a = context.executor.asset(id, editor, "Reference image");
    if (a.type !== "image") throw new ToolError(`referenceMediaRefs entry '${id}' must be an image asset (got ${a.type})`);
    return a;
  });

  const genInput = makeGenerationInput({
    prompt, model: model.id, duration: 0, aspectRatio,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(quality !== undefined ? { quality } : {}),
  });
  const folderId = resolveFolder(editor, args, refs);
  const name = argString(args, "name");
  const plan = makeImageSubmission({
    genInput, model, references: refs,
    ...(name !== undefined ? { name } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
  });
  const placeholderId = getGenerationService().generate(editor, plan);
  return ok(`Generation started. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, aspect: ${aspectRatio}`);
}

// MARK: - generate_audio

export async function generateAudio(context: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const { editor } = context;
  const model = resolveModel<AudioEntry>(argString(args, "model"), audioModels(), "audio");
  const caps = model.uiCapabilities;

  const prompt = (argString(args, "prompt") ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  const inputAssets: AudioInputAssets = {
    imageRefs: referenceAssets(context, args, "referenceImageMediaRefs", "Image reference"),
    audioRefs: referenceAssets(context, args, "referenceAudioMediaRefs", "Audio reference"),
  };
  const inputError = validateAudioInputs(inputAssets, model);
  if (inputError !== undefined) throw new ToolError(inputError);

  const acceptsVideo = audioInputs(model).includes("video");
  const sourceMediaRef = argString(args, "sourceMediaRef") ?? argString(args, "videoSourceMediaRef");
  let sourceAsset: MediaAsset | undefined;
  let video: LocalReference | undefined;
  let renderedPath: string | undefined;
  let spanSeconds: number | undefined;
  let placementStartFrame: number | undefined;
  if (sourceMediaRef !== undefined) {
    const candidate = context.executor.asset(sourceMediaRef, editor, "Source media");
    if (argString(args, "sourceMediaRef") === undefined && candidate.type !== "video") {
      throw new ToolError(`videoSourceMediaRef must be a video asset (got ${candidate.type}).`);
    }
    if (!audioAcceptsSource(model, candidate.type)) throw new ToolError(`Model '${model.id}' does not accept ${candidate.type} source media.`);
    if (audioUsesSourceURL(model) && candidate.type === "video" && !candidate.hasAudio) {
      throw new ToolError(`${model.displayName} requires source video with an audio track.`);
    }
    const spanError = validateAudioSpan(model, candidate.duration);
    if (spanError !== undefined) throw new ToolError(spanError);
    sourceAsset = candidate;
    spanSeconds = candidate.duration;
  } else {
    const start = argInt(args, "videoSourceStartFrame");
    const end = argInt(args, "videoSourceEndFrame");
    if (start !== undefined && end !== undefined) {
      if (!acceptsVideo) throw new ToolError(`Model '${model.id}' does not accept a video input (see list_models 'inputs').`);
      if (audioUsesSourceURL(model)) throw new ToolError(`Use sourceMediaRef for ${model.displayName}.`);
      if (!(start >= 0 && end > start)) throw new ToolError("videoSourceEndFrame must be greater than videoSourceStartFrame (>= 0).");
      const span = (end - start) / Math.max(1, editor.timeline.fps);
      const spanError = validateAudioSpan(model, span);
      if (spanError !== undefined) throw new ToolError(spanError);
      if (!musicHooks.renderTimelineSpan) throw new ToolError("Rendering the timeline for video-to-audio is not available yet.");
      renderedPath = await musicHooks.renderTimelineSpan(editor, { startFrame: start, frameCount: end - start }, 240);
      video = { path: renderedPath, type: "video", contentType: "video/mp4" };
      spanSeconds = span;
      placementStartFrame = start;
    }
  }
  const tempPath = renderedPath;
  let submitted = false;
  const removeRendered = (): void => {
    if (tempPath !== undefined) void musicHooks.removeTempFile?.(tempPath);
  };

  try {
    if (audioAcceptsSourceMedia(model) && !audioInputs(model).includes("text") && sourceAsset === undefined && video === undefined) {
      throw new ToolError(`Model '${model.id}' needs source media. Provide sourceMediaRef.`);
    }

    const instrumental = argBool(args, "instrumental") ?? false;
    const requestedDuration = argInt(args, "duration");
    const sourceDuration = spanSeconds === undefined ? undefined : Math.max(1, swiftRound(spanSeconds));
    const durationSeconds = audioUsesSourceURL(model) ? sourceDuration : (requestedDuration ?? sourceDuration);
    const voice = caps.voices !== undefined ? (argString(args, "voice") ?? caps.defaultVoice) : undefined;
    const lyrics = caps.supportsLyrics ? argString(args, "lyrics") : undefined;
    const styleInstructions = caps.supportsStyleInstructions ? argString(args, "styleInstructions") : undefined;
    const targetLanguage = caps.targetLanguages !== undefined ? argString(args, "targetLanguage") : undefined;
    const multilingual = caps.supportsMultilingual === true ? (argBool(args, "multilingual") ?? false) : undefined;
    const params: AudioParams = {
      kind: "audio",
      prompt,
      ...(voice !== undefined ? { voice } : {}),
      ...(lyrics !== undefined ? { lyrics } : {}),
      ...(styleInstructions !== undefined ? { styleInstructions } : {}),
      instrumental: caps.supportsInstrumental ? instrumental : false,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(video ? { video } : {}),
      ...(targetLanguage !== undefined ? { targetLanguage } : {}),
      ...(multilingual !== undefined ? { multilingual } : {}),
    };
    const paramsError = validateAudioParams(model, {
      prompt,
      ...(voice !== undefined ? { voice } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(targetLanguage !== undefined ? { targetLanguage } : {}),
    });
    if (paramsError !== undefined) throw new ToolError(paramsError);

    const genInput: GenerationInput = makeGenerationInput({
      prompt, model: model.id, duration: durationSeconds ?? 0, aspectRatio: "",
      ...(voice !== undefined ? { voice } : {}),
      ...(lyrics !== undefined ? { lyrics } : {}),
      ...(styleInstructions !== undefined ? { styleInstructions } : {}),
      ...(caps.supportsInstrumental ? { instrumental } : {}),
      ...(targetLanguage !== undefined ? { targetLanguage } : {}),
      ...(multilingual !== undefined ? { multilingual } : {}),
    });
    if (sourceAsset) genInput.audioInput = sourceAsset.type === "video" ? "video" : "audio";
    else genInput.audioInput = video === undefined ? "text" : "video";
    if (sourceAsset) setAudioSourceAsset(genInput, sourceAsset);

    const sourceReferences = sourceAsset ? [sourceAsset] : [];
    const folderId = resolveFolder(editor, args, [...sourceReferences, ...audioInputReferences(inputAssets)]);
    const name = argString(args, "name");
    const plan = makeAudioSubmission({
      genInput, model, params,
      ...(name !== undefined ? { name } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      references: audioSupportsReferences(model) ? audioInputReferences(inputAssets) : sourceReferences,
    });
    const service = getGenerationService();

    if (placementStartFrame !== undefined && spanSeconds !== undefined) {
      const startFrame = placementStartFrame;
      const outputSpan = requestedDuration ?? spanSeconds;
      const label = audioCategoryLabel[audioCategory(model)];
      const placeholderId = editor.perform(`Add ${label} (Agent)`, () => {
        const id = service.generate(editor, plan, {
          onComplete: (asset) => {
            finalizeGeneratingClip(editor, asset.id, asset);
            removeRendered();
          },
          onFailure: removeRendered,
        });
        placeGeneratingAudioClip(editor, id, startFrame, outputSpan, `Add ${label}`);
        return id;
      });
      submitted = true;
      return ok(`Generation started and placed on the timeline at frame ${startFrame}. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, ${label} (scored from video).`);
    }

    const placeholderId = service.generate(editor, plan, { onComplete: removeRendered, onFailure: removeRendered });
    submitted = true;
    const sourceNote = sourceAsset !== undefined || video !== undefined ? " (from source media)" : "";
    return ok(`Generation started. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, ${audioCategoryLabel[audioCategory(model)]}${sourceNote}. Place it with add_clips.`);
  } catch (e) {
    if (!submitted) removeRendered();
    throw e;
  }
}

// MARK: - upscale_media

function resolvedUpscaleSettings(raw: unknown, model: UpscaleEntry, source: MediaAsset): UpscaleSettings {
  let supplied: Record<string, unknown> = {};
  if (raw !== undefined) {
    if (!isRecord(raw)) throw new ToolError("settings must be an object");
    supplied = raw;
  }
  const caps = model.uiCapabilities;
  const resolved = upscaleNormalizedSettings(model, upscaleDefaultSettings(model), source);
  for (const [id, rawValue] of Object.entries(supplied)) {
    const select = (caps.selectSettings ?? []).find((s) => s.key === id);
    const numeric = (caps.numericSettings ?? []).find((s) => s.key === id);
    if (select) {
      const options = upscaleAvailableOptions(model, select, source);
      if (typeof rawValue !== "string" || !options.includes(rawValue)) {
        throw new ToolError(`Unsupported ${id}. Available: ${options.join(", ")}`);
      }
      resolved.selections[id] = rawValue;
    } else if (numeric) {
      const value = argDouble({ value: rawValue }, "value");
      if (value === undefined || !Number.isFinite(value) || value < numeric.minimum || value > numeric.maximum) {
        throw new ToolError(`${id} must be between ${swiftDouble(numeric.minimum)} and ${swiftDouble(numeric.maximum)}`);
      }
      resolved.numbers[id] = value;
    } else if ((caps.toggleSettings ?? []).some((s) => s.key === id)) {
      if (typeof rawValue !== "boolean") throw new ToolError(`${id} must be true or false`);
      resolved.toggles[id] = rawValue;
    } else {
      const valid = [...(caps.selectSettings ?? []), ...(caps.numericSettings ?? []), ...(caps.toggleSettings ?? [])].map((s) => s.key);
      throw new ToolError(`Unknown upscale setting '${id}'. Available: ${valid.join(", ")}`);
    }
  }
  return resolved;
}

export function upscaleMedia(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const mediaRef = requireString(args, "mediaRef");
  const asset = context.executor.asset(mediaRef, editor);
  if (asset.type !== "video" && asset.type !== "image") {
    throw new ToolError(`Upscale supports video and image assets only (got ${asset.type})`);
  }
  if (asset.sourceWidth === undefined || asset.sourceHeight === undefined) {
    throw new ToolError("Source dimensions are not available yet. Poll get_media until the asset is ready.");
  }
  if (asset.type === "video" && asset.sourceFPS === undefined) {
    throw new ToolError("Source FPS is not available yet. Poll get_media until the asset is ready.");
  }

  const forType = upscaleModels().filter((m) => m.uiCapabilities.supportedTypes.includes(asset.type as "video" | "image"));
  const requested = argString(args, "model");
  let model: UpscaleEntry;
  if (requested !== undefined) {
    const match = forType.find((m) => m.id === requested);
    if (!match) {
      throw new ToolError(`Model '${requested}' does not support ${asset.type}. Available: ${forType.filter(isEntryUsable).map((m) => m.id).join(", ")}`);
    }
    if (!isEntryUsable(match)) throw missingKeyError(match);
    if (!upscaleSupports(match, asset)) throw new ToolError(`Model '${requested}' is not compatible with this source's resolution or frame rate.`);
    model = match;
  } else {
    const first = forType.find((m) => isEntryUsable(m) && upscaleSupports(m, asset));
    if (!first) throw new ToolError(`No compatible upscaler is available for this ${asset.type} with the configured provider API keys.`);
    model = first;
  }

  const settings = resolvedUpscaleSettings(args.settings, model, asset);
  const trimmed = trimmedSource(editor, args, asset);
  const placeholderId = submitUpscale(editor, asset, model, { settings, ...(trimmed ? { trimmedSource: trimmed } : {}) });
  if (placeholderId === undefined) throw new ToolError("Failed to start upscale");
  return ok(`Upscale started. Placeholder asset ID: ${placeholderId}. Model: ${model.displayName}, source: ${asset.name}${trimmed ? " (trimmed range)" : ""}`);
}

// MARK: - list_models

export function videoModelInfo(m: VideoEntry, includeType = false): Json {
  const c = m.uiCapabilities;
  const info: Json = {
    id: m.id, displayName: m.displayName,
    durations: c.durations, aspectRatios: c.aspectRatios,
    supportsFirstFrame: c.supportsFirstFrame, supportsLastFrame: c.supportsLastFrame,
    supportsReferences: videoSupportsReferences(m), supportsPrompt: videoSupportsPrompt(m),
  };
  if (includeType) info.type = "video";
  if (c.resolutions) info.resolutions = c.resolutions;
  if (videoSupportsReferences(m)) {
    if (c.maxReferenceImages > 0) info.maxReferenceImages = c.maxReferenceImages;
    if (c.maxReferenceVideos > 0) info.maxReferenceVideos = c.maxReferenceVideos;
    if (c.maxReferenceAudios > 0) info.maxReferenceAudios = c.maxReferenceAudios;
    if (c.maxTotalReferences !== undefined) info.maxTotalReferences = c.maxTotalReferences;
    if (c.maxCombinedVideoRefSeconds !== undefined) info.maxCombinedVideoRefSeconds = Math.trunc(c.maxCombinedVideoRefSeconds);
    if (c.maxCombinedAudioRefSeconds !== undefined) info.maxCombinedAudioRefSeconds = Math.trunc(c.maxCombinedAudioRefSeconds);
    if (c.framesAndReferencesExclusive) info.framesAndReferencesExclusive = true;
    info.referenceTagNoun = c.referenceTagNoun;
  }
  if (c.requiresSourceVideo) info.requiresSourceVideo = true;
  if (videoSupportsSourceVideo(m)) info.supportsSourceVideo = true;
  if (c.maxSourceVideoSeconds !== undefined) info.maxSourceVideoSeconds = c.maxSourceVideoSeconds;
  if (c.requiresReferenceImage) info.requiresReferenceImage = true;
  if (videoRequiresReferenceAudio(m)) info.requiresReferenceAudio = true;
  if (videoUsesOutputDuration(m)) info.usesOutputDuration = true;
  return info;
}

export function imageModelInfo(m: ImageEntry, includeType = false): Json {
  const c = m.uiCapabilities;
  const info: Json = {
    id: m.id, displayName: m.displayName, aspectRatios: c.aspectRatios, supportsImageReference: c.supportsImageReference,
  };
  if (includeType) info.type = "image";
  if (c.resolutions) info.resolutions = c.resolutions;
  if (c.qualities) info.qualities = c.qualities;
  return info;
}

export function audioModelInfo(m: AudioEntry): Json {
  const c = m.uiCapabilities;
  const info: Json = {
    id: m.id, displayName: m.displayName, type: "audio", category: audioCategory(m),
    inputs: audioInputs(m), minPromptLength: c.minPromptLength,
    supportsMultilingual: c.supportsMultilingual ?? false,
    supportsLyrics: c.supportsLyrics, supportsInstrumental: c.supportsInstrumental,
    supportsStyleInstructions: c.supportsStyleInstructions,
  };
  if (c.voices) {
    info.voicesSample = c.voices.slice(0, 3);
    info.voiceCount = c.voices.length;
  }
  if (c.defaultVoice !== undefined) info.defaultVoice = c.defaultVoice;
  if (c.durations) info.durations = c.durations;
  if (c.durationRange) info.durationRange = c.durationRange;
  if (audioMaxReferenceImages(m) > 0) info.maxReferenceImages = audioMaxReferenceImages(m);
  if (audioMaxReferenceAudios(m) > 0) info.maxReferenceAudios = audioMaxReferenceAudios(m);
  if (c.maxReferenceAudioSeconds !== undefined) info.maxReferenceAudioSeconds = c.maxReferenceAudioSeconds;
  if (c.referenceAudioExtensions) info.referenceAudioExtensions = [...c.referenceAudioExtensions].sort();
  if (audioReferencesExclusive(m)) info.referenceImagesAndAudiosExclusive = true;
  if (audioAcceptsSourceMedia(m)) {
    info.minSeconds = c.minSeconds ?? 1;
    info.maxSeconds = c.maxSeconds ?? 600;
  }
  if (c.targetLanguages) info.targetLanguages = c.targetLanguages;
  return info;
}

export function upscaleModelInfo(m: UpscaleEntry): Json {
  const c = m.uiCapabilities;
  const info: Json = {
    id: m.id, displayName: m.displayName, type: "upscale", speed: c.speed, supportedTypes: [...c.supportedTypes].sort(),
  };
  if (m.description !== undefined) info.description = m.description;
  if (c.maximumUpscaleFactor !== undefined) info.maximumUpscaleFactor = c.maximumUpscaleFactor;
  const selects = (c.selectSettings ?? []).map((s) => ({
    id: s.key, label: s.label, type: "select", default: s.defaultValue,
    options: s.options.map((value) => ({ value, label: upscaleOptionLabel(s.key, value) })),
  }));
  const numbers = (c.numericSettings ?? []).map((s) => ({
    id: s.key, label: s.label, type: "number", minimum: s.minimum, maximum: s.maximum, step: s.step,
  }));
  const toggles = (c.toggleSettings ?? []).map((s) => ({ id: s.key, label: s.label, type: "boolean", default: s.defaultValue }));
  info.settings = [...selects, ...numbers, ...toggles];
  return info;
}

export function listModels(_context: ToolContext, args: ToolArgs): ToolResult {
  const filter = argString(args, "type");
  const usable = <T extends CatalogEntry>(all: readonly T[]): T[] => all.filter(isEntryUsable);
  const out: Json[] = [];
  if (filter === undefined || filter === "video") out.push(...usable(videoModels()).map((m) => videoModelInfo(m, true)));
  if (filter === undefined || filter === "image") out.push(...usable(imageModels()).map((m) => imageModelInfo(m, true)));
  if (filter === undefined || filter === "audio") out.push(...usable(audioModels()).map((m) => audioModelInfo(m)));
  if (filter === undefined || filter === "upscale") out.push(...usable(upscaleModels()).map((m) => upscaleModelInfo(m)));
  const body: Json = { models: out, loaded: true };
  if (out.length === 0) {
    body.note = "No models are available: no provider API key is configured for them. Tell the user to add an API key in Settings.";
  }
  return ok(jsonString(roundJSONFloatingPointNumbers(body, 3)));
}

// MARK: - MCP resources

/** `MCPService.readResource` for `palmier://models/video` and `palmier://models/image`; null for other uris. */
export function modelResourceText(uri: string): string | null {
  switch (uri) {
    case "palmier://models/video": return jsonString(videoModels().filter(isEntryUsable).map((m) => videoModelInfo(m)));
    case "palmier://models/image": return jsonString(imageModels().filter(isEntryUsable).map((m) => imageModelInfo(m)));
    default: return null;
  }
}
