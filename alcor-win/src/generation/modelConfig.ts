// Ports of VideoModelConfig / ImageModelConfig / AudioModelConfig / UpscaleModelConfig computed properties and
// validators, as free functions over the provider contract's `CatalogEntry`.
import type { MediaAsset, UpscaleSettings } from "../model";
import { swiftRound } from "../util/math";
import type { CatalogEntry, UpscaleSelectSetting } from "./providers/types";

export type VideoEntry = Extract<CatalogEntry, { kind: "video" }>;
export type ImageEntry = Extract<CatalogEntry, { kind: "image" }>;
export type AudioEntry = Extract<CatalogEntry, { kind: "audio" }>;
export type UpscaleEntry = Extract<CatalogEntry, { kind: "upscale" }>;

export const isVideoEntry = (e: CatalogEntry | undefined): e is VideoEntry => e?.kind === "video";
export const isImageEntry = (e: CatalogEntry | undefined): e is ImageEntry => e?.kind === "image";
export const isAudioEntry = (e: CatalogEntry | undefined): e is AudioEntry => e?.kind === "audio";
export const isUpscaleEntry = (e: CatalogEntry | undefined): e is UpscaleEntry => e?.kind === "upscale";

export function unsupportedValue(model: string, field: string, value: string, allowed: readonly string[]): string {
  return `${model} does not support ${field} '${value}'. Valid: ${allowed.join(", ")}.`;
}

// MARK: - Video

export const draftResolution = "720p";

export const videoSupportsPrompt = (m: VideoEntry): boolean => m.uiCapabilities.supportsPrompt ?? true;
export const videoRequiresSourceVideo = (m: VideoEntry): boolean => m.uiCapabilities.requiresSourceVideo;
/** The contract has no "extend" flag; a model that bounds its source video length can take one. */
export const videoSupportsSourceVideo = (m: VideoEntry): boolean =>
  m.uiCapabilities.requiresSourceVideo || m.uiCapabilities.maxSourceVideoSeconds !== undefined;
export const videoSupportsReferences = (m: VideoEntry): boolean => {
  const c = m.uiCapabilities;
  return c.maxReferenceImages > 0 || c.maxReferenceVideos > 0 || c.maxReferenceAudios > 0;
};
export const videoRequiresReferenceAudio = (m: VideoEntry): boolean => m.uiCapabilities.requiresReferenceAudio ?? false;
export const videoUsesOutputDuration = (m: VideoEntry): boolean =>
  videoSupportsSourceVideo(m) && m.uiCapabilities.durations.length > 0;
export const videoIsEdit = (m: VideoEntry): boolean =>
  videoSupportsPrompt(m) &&
  videoRequiresSourceVideo(m) &&
  !m.uiCapabilities.requiresReferenceImage &&
  !videoRequiresReferenceAudio(m);
export const videoIsLipSync = (m: VideoEntry): boolean =>
  !videoSupportsPrompt(m) && videoRequiresSourceVideo(m) && videoRequiresReferenceAudio(m);

export function isReframeModel(m: VideoEntry): boolean {
  if (!videoSupportsPrompt(m) || videoRequiresSourceVideo(m) || m.uiCapabilities.maxReferenceVideos <= 0) return false;
  const id = m.id.toLowerCase();
  return id.includes("minimax-h3") || id.includes("hailuo-03");
}

export function nearestSupportedDurationIn(seconds: number, durations: readonly number[]): number {
  let best: number | undefined;
  for (const d of durations) if (best === undefined || Math.abs(d - seconds) < Math.abs(best - seconds)) best = d;
  return best ?? Math.max(1, swiftRound(seconds));
}

export const videoNearestSupportedDuration = (m: VideoEntry, seconds: number): number =>
  nearestSupportedDurationIn(seconds, m.uiCapabilities.durations);

/** Smallest supported duration that fully covers `seconds`, so generated media is never shorter than the span it replaces. */
export function videoSupportedDurationCovering(m: VideoEntry, seconds: number): number {
  const durations = m.uiCapabilities.durations;
  const covering = durations.filter((d) => d >= seconds);
  if (covering.length > 0) return Math.min(...covering);
  if (durations.length > 0) return Math.max(...durations);
  return Math.max(1, Math.ceil(seconds));
}

export function videoPreferredHighResolution(m: VideoEntry): string | undefined {
  const r = m.uiCapabilities.resolutions;
  if (r?.includes("2K")) return "2K";
  if (r?.includes("1080p")) return "1080p";
  return r?.[0];
}

function durationLimitLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export function reframeDurationLimitLabel(m: VideoEntry): string | undefined {
  const maximum = m.uiCapabilities.maxCombinedVideoRefSeconds;
  if (maximum !== undefined && Number.isFinite(maximum) && maximum > 0) return durationLimitLabel(swiftRound(maximum));
  const durations = m.uiCapabilities.durations;
  return durations.length > 0 ? durationLimitLabel(Math.max(...durations)) : undefined;
}

export function validateReframeDuration(m: VideoEntry, duration: number): string | undefined {
  if (!(Number.isFinite(duration) && duration > 0)) return "Loading video metadata…";
  const durations = m.uiCapabilities.durations;
  const maximum = m.uiCapabilities.maxCombinedVideoRefSeconds ?? (durations.length > 0 ? Math.max(...durations) : undefined);
  const limit = reframeDurationLimitLabel(m);
  if (maximum === undefined || !(duration > maximum) || limit === undefined) return undefined;
  return `${m.displayName} supports source videos up to ${limit}. Trim the clip to continue.`;
}

export function sourceDurationLimitLabel(m: VideoEntry): string | undefined {
  const maximum = m.uiCapabilities.maxSourceVideoSeconds;
  if (maximum === undefined || !Number.isFinite(maximum) || !(maximum > 0)) return undefined;
  return durationLimitLabel(swiftRound(maximum));
}

export function validateSourceDuration(m: VideoEntry, duration: number): string | undefined {
  if (!(Number.isFinite(duration) && duration > 0)) return "Loading video metadata…";
  const maximum = m.uiCapabilities.maxSourceVideoSeconds;
  const limit = sourceDurationLimitLabel(m);
  if (maximum === undefined || !(duration > maximum) || limit === undefined) return undefined;
  return `${m.displayName} supports source videos up to ${limit}. Trim the clip to continue.`;
}

export function billingDurationSeconds(
  m: VideoEntry,
  sourceVideoDuration: number,
  sourceAudioDuration: number | undefined,
): number | undefined {
  const seconds = videoIsLipSync(m) ? sourceAudioDuration : sourceVideoDuration;
  if (seconds === undefined || !Number.isFinite(seconds) || !(seconds > 0)) return undefined;
  return Math.max(1, swiftRound(seconds));
}

export function validateVideo(
  m: VideoEntry,
  duration: number,
  aspectRatio: string,
  resolution: string | undefined,
): string | undefined {
  const c = m.uiCapabilities;
  if (c.durations.length > 0 && !c.durations.includes(duration)) {
    return unsupportedValue(m.displayName, "duration", `${duration}s`, c.durations.map((d) => `${d}s`));
  }
  if (c.aspectRatios.length > 0 && aspectRatio !== "" && !c.aspectRatios.includes(aspectRatio)) {
    return unsupportedValue(m.displayName, "aspect ratio", aspectRatio, c.aspectRatios);
  }
  if (c.resolutions && resolution !== undefined && resolution !== "" && !c.resolutions.includes(resolution)) {
    return unsupportedValue(m.displayName, "resolution", resolution, c.resolutions);
  }
  return undefined;
}

// MARK: - Image

export const imageMaxImages = (m: ImageEntry): number => Math.max(1, Math.min(4, m.uiCapabilities.maxImages));

export function validateImage(
  m: ImageEntry,
  p: { aspectRatio: string; resolution: string | undefined; quality: string | undefined; imageRefCount: number; numImages: number },
): string | undefined {
  const c = m.uiCapabilities;
  if (c.aspectRatios.length > 0 && p.aspectRatio !== "" && !c.aspectRatios.includes(p.aspectRatio)) {
    return unsupportedValue(m.displayName, "aspect ratio", p.aspectRatio, c.aspectRatios);
  }
  if (c.resolutions && p.resolution !== undefined && p.resolution !== "" && !c.resolutions.includes(p.resolution)) {
    return unsupportedValue(m.displayName, "resolution", p.resolution, c.resolutions);
  }
  if (c.qualities && p.quality !== undefined && p.quality !== "" && !c.qualities.includes(p.quality)) {
    return unsupportedValue(m.displayName, "quality", p.quality, c.qualities);
  }
  if (p.imageRefCount > 0 && !c.supportsImageReference) return `${m.displayName} does not accept reference images.`;
  const max = imageMaxImages(m);
  if (p.numImages < 1 || p.numImages > max) {
    return `${m.displayName} supports 1…${max} image${max === 1 ? "" : "s"} per request (got ${p.numImages}).`;
  }
  return undefined;
}

export function parseWxH(s: string): [number, number] | undefined {
  const parts = s.toLowerCase().split("x");
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return undefined;
  return [Number(parts[0]), Number(parts[1])];
}

export function resolutionDisplayLabel(id: string): string {
  const wh = parseWxH(id);
  if (!wh) return id;
  const [w, h] = wh;
  if (w === h) return "Square";
  const orientation = w > h ? "Landscape" : "Portrait";
  const longEdge = Math.max(w, h);
  let tier: string;
  switch (longEdge) {
    case 3840: tier = "4K"; break;
    case 2560: tier = "2K"; break;
    case 1920: tier = "1080p"; break;
    case 1024:
    case 1536: tier = ""; break;
    default: tier = `${longEdge}p`;
  }
  return tier === "" ? orientation : `${orientation} ${tier}`;
}

function capitalized(token: string): string {
  return token.length === 0 ? token : token[0].toUpperCase() + token.slice(1).toLowerCase();
}

export function aspectRatioDisplayLabel(id: string): string {
  if (id.includes(":")) return id;
  const parts = id.split("_").filter((p) => p !== "");
  if (parts.length === 0) return id;
  if (parts.length >= 2) {
    const w = parts[parts.length - 2];
    const h = parts[parts.length - 1];
    if (/^\d+$/.test(w) && /^\d+$/.test(h)) parts.splice(parts.length - 2, 2, `${Number(w)}:${Number(h)}`);
  }
  return parts
    .map((token) => {
      const lower = token.toLowerCase();
      return ["hd", "uhd", "1k", "2k", "4k", "8k"].includes(lower) ? lower.toUpperCase() : capitalized(token);
    })
    .join(" ");
}

// MARK: - Audio

export type AudioCategory = "general" | "tts" | "music" | "sfx" | "cleanup" | "dubbing";
export type AudioInput = "text" | "audio" | "video";

export const audioCategoryOrder: readonly AudioCategory[] = ["general", "tts", "music", "sfx", "cleanup", "dubbing"];
export const audioCategoryLabel: Record<AudioCategory, string> = {
  general: "General",
  tts: "Speech",
  music: "Music",
  sfx: "Sound Effects",
  cleanup: "Voice Cleanup",
  dubbing: "Dubbing",
};

export function audioCategory(m: AudioEntry): AudioCategory {
  const c = m.uiCapabilities.category;
  return (audioCategoryOrder as readonly string[]).includes(c) ? (c as AudioCategory) : "tts";
}

export function audioInputs(m: AudioEntry): AudioInput[] {
  return (m.uiCapabilities.inputs ?? ["text"]).filter((i): i is AudioInput => i === "text" || i === "audio" || i === "video");
}

export const audioHasDurationControl = (m: AudioEntry): boolean =>
  m.uiCapabilities.durations !== undefined || m.uiCapabilities.durationRange !== undefined;
export const audioMaxReferenceImages = (m: AudioEntry): number => m.uiCapabilities.maxReferenceImages ?? 0;
export const audioMaxReferenceAudios = (m: AudioEntry): number => m.uiCapabilities.maxReferenceAudios ?? 0;
export const audioSupportsReferences = (m: AudioEntry): boolean =>
  audioMaxReferenceImages(m) > 0 || audioMaxReferenceAudios(m) > 0;
export const audioReferencesExclusive = (m: AudioEntry): boolean =>
  m.uiCapabilities.referenceImagesAndAudiosExclusive ?? false;
export const audioPromptLabel = (m: AudioEntry): string => m.uiCapabilities.promptLabel ?? "Describe the sound";
export const audioMinSeconds = (m: AudioEntry): number => m.uiCapabilities.minSeconds ?? 1;
export const audioMaxSeconds = (m: AudioEntry): number => m.uiCapabilities.maxSeconds ?? 600;
export const audioAcceptsSourceMedia = (m: AudioEntry): boolean =>
  audioInputs(m).some((i) => i === "audio" || i === "video");
export const audioUsesSourceURL = (m: AudioEntry): boolean => {
  const c = audioCategory(m);
  return c === "cleanup" || c === "dubbing";
};

export function audioAcceptsSource(m: AudioEntry, type: MediaAsset["type"]): boolean {
  if (type === "audio") return audioInputs(m).includes("audio");
  if (type === "video") return audioInputs(m).includes("video");
  return false;
}

export function languageName(code: string): string {
  if (code === "") return "Target Language";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name ? name[0].toUpperCase() + name.slice(1) : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function validateAudioSpan(m: AudioEntry, spanSeconds: number): string | undefined {
  const s = swiftRound(spanSeconds);
  if (s < audioMinSeconds(m)) return `${m.displayName} needs at least ${audioMinSeconds(m)}s of source media (selection is ${s}s).`;
  if (s > audioMaxSeconds(m)) return `${m.displayName} accepts at most ${audioMaxSeconds(m)}s of source media (selection is ${s}s).`;
  return undefined;
}

export function validateAudioParams(
  m: AudioEntry,
  p: { prompt: string; voice?: string; durationSeconds?: number; targetLanguage?: string },
): string | undefined {
  const c = m.uiCapabilities;
  const promptLen = Array.from(p.prompt.replace(/^[ \t]+|[ \t]+$/g, "")).length;
  if (audioInputs(m).includes("text") && promptLen < c.minPromptLength) {
    return `${m.displayName} requires prompt ≥ ${c.minPromptLength} characters (got ${promptLen}).`;
  }
  if (c.voices && p.voice !== undefined && p.voice !== "" && !c.voices.includes(p.voice)) {
    const shown = [...c.voices.slice(0, 6), ...(c.voices.length > 6 ? ["…"] : [])];
    return unsupportedValue(m.displayName, "voice", p.voice, shown);
  }
  if (c.durations && p.durationSeconds !== undefined && !c.durations.includes(p.durationSeconds)) {
    return unsupportedValue(m.displayName, "duration", `${p.durationSeconds}s`, c.durations.map((d) => `${d}s`));
  }
  const range = c.durationRange;
  if (range && p.durationSeconds !== undefined && !(p.durationSeconds >= range.minimum && p.durationSeconds <= range.maximum)) {
    return `${m.displayName} duration must be ${range.minimum}-${range.maximum} seconds.`;
  }
  if (c.targetLanguages) {
    if (p.targetLanguage === undefined || p.targetLanguage === "") return "Choose a target language.";
    if (!c.targetLanguages.includes(p.targetLanguage)) {
      return unsupportedValue(m.displayName, "target language", p.targetLanguage, c.targetLanguages);
    }
  }
  return undefined;
}

// MARK: - Upscale

/** The contract's options are plain strings; labels are derived from them. */
export function upscaleOptionLabel(settingKey: string, value: string): string {
  if (settingKey === "targetFPS") return value === "source" ? "Original FPS" : `${value} FPS`;
  return value;
}

export function upscaleTargetLongEdge(value: string): number {
  return value === "1080p" ? 1920 : 3840;
}

export function upscaleDefaultSettings(m: UpscaleEntry): UpscaleSettings {
  const caps = m.uiCapabilities;
  return {
    selections: Object.fromEntries((caps.selectSettings ?? []).map((s) => [s.key, s.defaultValue])),
    numbers: {},
    toggles: Object.fromEntries((caps.toggleSettings ?? []).map((s) => [s.key, s.defaultValue])),
  };
}

export function upscaleAvailableOptions(
  m: UpscaleEntry,
  setting: UpscaleSelectSetting,
  source: MediaAsset | undefined,
): string[] {
  if (!source) return setting.options;
  switch (setting.key) {
    case "targetResolution": {
      const { sourceWidth: width, sourceHeight: height } = source;
      if (width === undefined || height === undefined) return setting.options;
      const sourceEdge = Math.max(width, height);
      let maximum: string | undefined;
      for (const o of setting.options) {
        if (maximum === undefined || upscaleTargetLongEdge(o) > upscaleTargetLongEdge(maximum)) maximum = o;
      }
      const maxFactor = m.uiCapabilities.maximumUpscaleFactor;
      return setting.options.filter((o) => {
        const factor = Math.max(1, upscaleTargetLongEdge(o) / sourceEdge);
        const withinLimit = maxFactor === undefined || factor <= maxFactor;
        return withinLimit && (upscaleTargetLongEdge(o) >= sourceEdge || o === maximum);
      });
    }
    case "targetFPS": {
      const fps = source.sourceFPS;
      if (fps === undefined || !(fps > 0)) return setting.options;
      if (fps > 60) return setting.options.filter((o) => o === "60");
      const preservesSource = setting.options.includes("source");
      return setting.options.filter((o) => o === "source" || (Number(o) || 0) >= fps + (preservesSource ? 0.001 : 0));
    }
    default:
      return setting.options;
  }
}

export function upscaleSupports(m: UpscaleEntry, source: MediaAsset): boolean {
  const caps = m.uiCapabilities;
  if (source.type !== "video" && source.type !== "image") return false;
  if (!caps.supportedTypes.includes(source.type)) return false;
  const selects = caps.selectSettings ?? [];
  if (source.type === "video" && (source.sourceFPS ?? 0) > 60 && !selects.some((s) => s.key === "targetFPS")) return false;
  return selects.every((s) => s.key !== "targetResolution" || upscaleAvailableOptions(m, s, source).length > 0);
}

export function upscaleNormalizedSettings(m: UpscaleEntry, settings: UpscaleSettings, source: MediaAsset | undefined): UpscaleSettings {
  const normalized: UpscaleSettings = structuredClone(settings);
  for (const setting of m.uiCapabilities.selectSettings ?? []) {
    const options = upscaleAvailableOptions(m, setting, source);
    if (options.length === 0) continue;
    const selected = normalized.selections[setting.key] ?? setting.defaultValue;
    if (!options.includes(selected)) normalized.selections[setting.key] = options[options.length - 1];
  }
  return normalized;
}

export function snappedUpscaleValue(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(Math.max(value, min), max);
  if (!(step > 0)) return clamped;
  const steps = swiftRound((clamped - min) / step);
  return Math.min(Math.max(min + steps * step, min), max);
}
