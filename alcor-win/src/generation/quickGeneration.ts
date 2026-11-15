// Shared submit path for text-prompted generation (video, image, audio without a source clip). `GenerationPanel` builds
// its `GenerationInput` / `AudioParams` through the helpers here, and the prompt bar submits through
// `submitQuickGeneration`, which turns a model + settings + references into the same `GenerationPlan` the panel hands to
// `generationService.generate`.
import { makeGenerationInput, type GenerationInput, type MediaAsset } from "../model";
import type { Editor } from "../editor/editor";
import { selectMediaPanelItem } from "../editor/mutations/mediaPanel";
import { folder } from "../media/folders";
import type { GenerationService } from "./generationService";
import {
  makeVideoInputAssets, validateAudioInputs, validateVideoInputs, type AudioInputAssets, type VideoInputAssets,
} from "./inputAssets";
import {
  audioAcceptsSourceMedia, audioHasDurationControl, audioMaxReferenceAudios, audioMaxReferenceImages,
  audioSupportsReferences, imageMaxImages, isAudioEntry, isImageEntry, isVideoEntry, validateAudioParams,
  validateImage, validateVideo, videoRequiresSourceVideo, videoSupportsReferences,
  type AudioEntry, type ImageEntry, type VideoEntry,
} from "./modelConfig";
import type { AudioParams, CatalogEntry } from "./providers/types";
import { makeAudioSubmission, makeImageSubmission, makeVideoSubmission, type GenerationPlan } from "./submission";

/** The user-editable values a generation request is built from. Optional fields are omitted from the stored input. */
export interface GenerationSettings {
  prompt: string;
  /** Output duration in seconds (0 for images). */
  duration: number;
  aspectRatio: string;
  resolution?: string | undefined;
  quality?: string | undefined;
  numImages?: number | undefined;
  voice?: string | undefined;
  lyrics?: string | undefined;
  styleInstructions?: string | undefined;
  instrumental?: boolean | undefined;
  targetLanguage?: string | undefined;
  multilingual?: boolean | undefined;
  generateAudio?: boolean | undefined;
  usesSourceVideo?: boolean | undefined;
  audioInput?: "text" | "audio" | "video" | undefined;
}

/** Builds the stored `GenerationInput`; fields a model cannot use are left out. */
export function buildGenerationInput(entry: CatalogEntry, s: GenerationSettings): GenerationInput {
  const a = isAudioEntry(entry) ? entry.uiCapabilities : undefined;
  const supportsAudioToggle = isVideoEntry(entry) && entry.uiCapabilities.supportsGenerateAudio === true;
  const input = makeGenerationInput({
    prompt: s.prompt, model: entry.id, duration: s.duration, aspectRatio: s.aspectRatio,
    ...(s.resolution !== undefined ? { resolution: s.resolution } : {}),
    ...(isImageEntry(entry) && s.quality !== undefined ? { quality: s.quality } : {}),
    ...(a?.voices && s.voice !== undefined && s.voice !== "" ? { voice: s.voice } : {}),
    ...(a?.supportsLyrics && s.lyrics !== undefined && s.lyrics !== "" ? { lyrics: s.lyrics } : {}),
    ...(a?.supportsStyleInstructions && s.styleInstructions !== undefined && s.styleInstructions !== "" ? { styleInstructions: s.styleInstructions } : {}),
    ...(a?.supportsInstrumental ? { instrumental: s.instrumental ?? false } : {}),
    ...(a?.targetLanguages ? { targetLanguage: s.targetLanguage ?? "" } : {}),
    ...(a?.supportsMultilingual ? { multilingual: s.multilingual ?? false } : {}),
    ...(supportsAudioToggle ? { generateAudio: s.generateAudio ?? true } : {}),
    ...(isVideoEntry(entry) && s.usesSourceVideo !== undefined ? { usesSourceVideo: s.usesSourceVideo } : {}),
  });
  if (s.numImages !== undefined && s.numImages > 1) input.numImages = s.numImages;
  if (s.audioInput !== undefined) input.audioInput = s.audioInput;
  return input;
}

/** Provider parameters of an audio generation. `audioDuration` is the resolved span (0 when the model has none). */
export function buildAudioParams(m: AudioEntry | undefined, s: GenerationSettings, audioDuration: number): AudioParams {
  const c = m?.uiCapabilities;
  return {
    kind: "audio",
    prompt: s.prompt,
    ...(c?.voices && s.voice !== undefined && s.voice !== "" ? { voice: s.voice } : {}),
    ...(c?.supportsLyrics && s.lyrics !== undefined && s.lyrics !== "" ? { lyrics: s.lyrics } : {}),
    ...(c?.supportsStyleInstructions && s.styleInstructions !== undefined && s.styleInstructions !== "" ? { styleInstructions: s.styleInstructions } : {}),
    instrumental: c?.supportsInstrumental ? s.instrumental ?? false : false,
    ...(m && (audioHasDurationControl(m) || audioAcceptsSourceMedia(m)) ? { durationSeconds: audioDuration } : {}),
    ...(c?.targetLanguages ? { targetLanguage: s.targetLanguage ?? "" } : {}),
    ...(c?.supportsMultilingual ? { multilingual: s.multilingual ?? false } : {}),
  };
}

// MARK: - References

export interface ClassifiedReferences {
  video: VideoInputAssets;
  audio: AudioInputAssets;
  image: MediaAsset[];
  /** References the model cannot take (shown to the user instead of silently dropping). */
  rejected: MediaAsset[];
}

/** Sorts reference assets into the slots a model offers; pure. */
export function classifyReferences(entry: VideoEntry | ImageEntry | AudioEntry, assets: readonly MediaAsset[]): ClassifiedReferences {
  const out: ClassifiedReferences = { video: makeVideoInputAssets(), audio: { imageRefs: [], audioRefs: [] }, image: [], rejected: [] };
  if (isVideoEntry(entry)) {
    const c = entry.uiCapabilities;
    const frames: MediaAsset[] = [];
    const imageRefs: MediaAsset[] = [];
    const videoRefs: MediaAsset[] = [];
    const audioRefs: MediaAsset[] = [];
    const frameCap = c.supportsFirstFrame ? (c.supportsLastFrame ? 2 : 1) : 0;
    const wantsRefs = assets.some((a) => a.type !== "image") || assets.filter((a) => a.type === "image").length > frameCap;
    const useFrames = frameCap > 0 && !(c.framesAndReferencesExclusive && wantsRefs && videoSupportsReferences(entry));
    for (const a of assets) {
      if (a.type === "image") {
        if (useFrames && frames.length < frameCap) frames.push(a);
        else if (!(c.framesAndReferencesExclusive && frames.length > 0) && imageRefs.length < c.maxReferenceImages) imageRefs.push(a);
        else out.rejected.push(a);
      } else if (a.type === "video") {
        if (videoRefs.length < c.maxReferenceVideos) videoRefs.push(a); else out.rejected.push(a);
      } else if (a.type === "audio") {
        if (audioRefs.length < c.maxReferenceAudios) audioRefs.push(a); else out.rejected.push(a);
      } else out.rejected.push(a);
    }
    out.video = makeVideoInputAssets({ frames, imageRefs, videoRefs, audioRefs });
  } else if (isImageEntry(entry)) {
    const cap = entry.uiCapabilities.supportsImageReference ? 4 : 0;
    for (const a of assets) {
      if (a.type === "image" && out.image.length < cap) out.image.push(a); else out.rejected.push(a);
    }
  } else {
    const imageCap = audioMaxReferenceImages(entry);
    const audioCap = audioMaxReferenceAudios(entry);
    for (const a of assets) {
      if (a.type === "image" && out.audio.imageRefs.length < imageCap) out.audio.imageRefs.push(a);
      else if (a.type === "audio" && out.audio.audioRefs.length < audioCap) out.audio.audioRefs.push(a);
      else out.rejected.push(a);
    }
  }
  return out;
}

// MARK: - Submit

export interface QuickGenerationRequest {
  entry: CatalogEntry;
  settings: GenerationSettings;
  references: readonly MediaAsset[];
  onComplete?: (asset: MediaAsset) => void;
  onFailure?: () => void;
}

export type QuickGenerationResult = { id: string } | { error: string };

/** Model-level validation shared by `submitQuickGeneration` and the prompt bar's disabled state. */
export function validateQuickGeneration(req: Pick<QuickGenerationRequest, "entry" | "settings" | "references">): string | undefined {
  const { entry, settings: s } = req;
  const text = Array.from(s.prompt.trim()).length;
  if (isVideoEntry(entry)) {
    if (videoRequiresSourceVideo(entry)) return `${entry.displayName} needs a source video.`;
    if (text === 0) return "Enter a prompt.";
    const refs = classifyReferences(entry, req.references);
    if (refs.rejected.length > 0) return `${entry.displayName} cannot use ${refs.rejected[0].name} as a reference.`;
    return validateVideo(entry, s.duration, s.aspectRatio, s.resolution) ?? validateVideoInputs(refs.video, entry);
  }
  if (isImageEntry(entry)) {
    if (text === 0) return "Enter a prompt.";
    const refs = classifyReferences(entry, req.references);
    if (refs.rejected.length > 0) return `${entry.displayName} cannot use ${refs.rejected[0].name} as a reference.`;
    return validateImage(entry, {
      aspectRatio: s.aspectRatio, resolution: s.resolution, quality: s.quality, imageRefCount: refs.image.length,
      numImages: Math.min(imageMaxImages(entry), Math.max(1, s.numImages ?? 1)),
    });
  }
  if (isAudioEntry(entry)) {
    if (text < Math.max(1, entry.uiCapabilities.minPromptLength)) return "Enter a prompt.";
    const refs = classifyReferences(entry, req.references);
    if (refs.rejected.length > 0) return `${entry.displayName} cannot use ${refs.rejected[0].name} as a reference.`;
    return validateAudioParams(entry, buildAudioParams(entry, s, audioHasDurationControl(entry) ? s.duration : 0)) ??
      (audioSupportsReferences(entry) ? validateAudioInputs(refs.audio, entry) : undefined);
  }
  return "This model is not available here.";
}

/** Builds the plan for a request; the caller must have validated it. */
export function makeQuickPlan(req: QuickGenerationRequest, folderId: string | undefined): GenerationPlan | undefined {
  const { entry, settings: s } = req;
  const folderPart = folderId !== undefined ? { folderId } : {};
  if (isVideoEntry(entry)) {
    const refs = classifyReferences(entry, req.references);
    const genInput = buildGenerationInput(entry, { ...s, usesSourceVideo: false });
    return makeVideoSubmission({
      genInput, model: entry, inputAssets: refs.video, placeholderDuration: s.duration,
      generateAudio: entry.uiCapabilities.supportsGenerateAudio === true ? s.generateAudio ?? true : true, ...folderPart,
    });
  }
  if (isImageEntry(entry)) {
    const refs = classifyReferences(entry, req.references);
    const count = imageMaxImages(entry) > 1 ? Math.min(imageMaxImages(entry), Math.max(1, s.numImages ?? 1)) : 1;
    const genInput = buildGenerationInput(entry, { ...s, numImages: count });
    return makeImageSubmission({ genInput, model: entry, references: refs.image, numImages: count, ...folderPart });
  }
  if (isAudioEntry(entry)) {
    const refs = classifyReferences(entry, req.references);
    const span = audioHasDurationControl(entry) ? s.duration : 0;
    const genInput = buildGenerationInput(entry, { ...s, duration: span, audioInput: "text" });
    const references = audioSupportsReferences(entry) ? [...refs.audio.imageRefs, ...refs.audio.audioRefs] : [];
    return makeAudioSubmission({ genInput, model: entry, params: buildAudioParams(entry, s, span), references, ...folderPart });
  }
  return undefined;
}

/**
 * Validates, builds the plan and hands it to `service.generate` (the same call `GenerationPanel` makes).
 * The placeholder lands in the current media folder and is selected in the media panel.
 */
export function submitQuickGeneration(editor: Editor, service: GenerationService, req: QuickGenerationRequest): QuickGenerationResult {
  const error = validateQuickGeneration(req);
  if (error !== undefined) return { error };
  const current = editor.ui.mediaPanelCurrentFolderId ?? undefined;
  const folderId = current !== undefined && folder(editor, current) ? current : undefined;
  const plan = makeQuickPlan(req, folderId);
  if (!plan) return { error: "This model is not available here." };
  const id = service.generate(editor, plan, {
    ...(req.onComplete ? { onComplete: req.onComplete } : {}),
    ...(req.onFailure ? { onFailure: req.onFailure } : {}),
  });
  selectMediaPanelItem(editor, id);
  return { id };
}
