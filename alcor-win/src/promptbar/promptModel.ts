// Pure logic of the prompt bar: modes, model filtering, option defaults and validation, cost, prompt history.
import { audioCost, imageCost, videoCost } from "../generation/costEstimator";
import type { GenerationSettings } from "../generation/quickGeneration";
import {
  aspectRatioDisplayLabel, audioCategory, audioHasDurationControl, audioInputs, imageMaxImages, isAudioEntry,
  isImageEntry, isVideoEntry, resolutionDisplayLabel, videoRequiresSourceVideo,
  type AudioEntry, type ImageEntry, type VideoEntry,
} from "../generation/modelConfig";
import type { CatalogEntry } from "../generation/providers/types";

export type PromptMode = "video" | "image" | "speech" | "sfx" | "music";
export type PromptEntry = VideoEntry | ImageEntry | AudioEntry;

export const promptModes: readonly { id: PromptMode; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "speech", label: "Speech" },
  { id: "sfx", label: "Sound effect" },
  { id: "music", label: "Music" },
];

/** The clip type a mode produces. */
export const modeClipType = (mode: PromptMode): "video" | "image" | "audio" =>
  mode === "video" ? "video" : mode === "image" ? "image" : "audio";

/** Whether a catalog entry belongs to a mode. Models that need a source clip (edit, lip sync, cleanup) are not prompt-only. */
export function entryInMode(entry: CatalogEntry, mode: PromptMode): entry is PromptEntry {
  if (mode === "video") return isVideoEntry(entry) && !videoRequiresSourceVideo(entry) && entry.uiCapabilities.supportsPrompt !== false;
  if (mode === "image") return isImageEntry(entry);
  if (!isAudioEntry(entry) || !audioInputs(entry).includes("text")) return false;
  const category = audioCategory(entry);
  return mode === "speech" ? category === "tts" : mode === "sfx" ? category === "sfx" : category === "music";
}

export interface ModeModel {
  entry: PromptEntry;
  /** False when the provider has no key: shown dimmed with an "Add key" action. */
  usable: boolean;
}

/** Enabled models of a mode, models with a key first; the catalog order is kept within each group. */
export function modelsForMode(
  mode: PromptMode,
  catalog: readonly CatalogEntry[],
  isEnabled: (id: string) => boolean,
  hasKey: (entry: CatalogEntry) => boolean,
): ModeModel[] {
  const list = catalog.filter((e) => entryInMode(e, mode) && isEnabled(e.id)).map((entry) => ({ entry: entry as PromptEntry, usable: hasKey(entry) }));
  return [...list.filter((m) => m.usable), ...list.filter((m) => !m.usable)];
}

/** Only the modes the catalog can serve. */
export function availableModes(catalog: readonly CatalogEntry[], isEnabled: (id: string) => boolean): PromptMode[] {
  return promptModes.map((m) => m.id).filter((mode) => catalog.some((e) => entryInMode(e, mode) && isEnabled(e.id)));
}

/** The remembered model if still listed, else the first usable one, else the first. */
export function pickModel(models: readonly ModeModel[], preferredId: string | undefined): ModeModel | undefined {
  return models.find((m) => m.entry.id === preferredId) ?? models.find((m) => m.usable) ?? models[0];
}

// MARK: - Options

export type OptionKey = "duration" | "aspectRatio" | "resolution" | "quality" | "numImages" | "voice";

export interface PromptOptions {
  duration: number;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  numImages: number;
  voice?: string;
  generateAudio: boolean;
}

export interface OptionChoice {
  value: string;
  label: string;
}

export interface OptionDef {
  key: OptionKey;
  label: string;
  choices: OptionChoice[];
}

const durationLabel = (n: number): string => `${n}s`;

/** Selectable audio durations: an explicit list, or a few round values inside the model's range. */
export function audioDurationChoices(m: AudioEntry): number[] {
  const c = m.uiCapabilities;
  if (c.durations) return [...c.durations];
  const r = c.durationRange;
  if (!r) return [];
  const values = new Set<number>([r.minimum, r.defaultValue, r.maximum, 5, 10, 15, 30, 60, 120, 180, 300]);
  return [...values].filter((v) => v >= r.minimum && v <= r.maximum).sort((a, b) => a - b);
}

/** The option controls a model offers, derived from its capabilities. */
export function optionDefs(entry: PromptEntry): OptionDef[] {
  const defs: OptionDef[] = [];
  const choices = (values: readonly (string | number)[], label: (v: never) => string): OptionChoice[] =>
    values.map((v) => ({ value: String(v), label: (label as (v: string | number) => string)(v) }));
  if (isVideoEntry(entry)) {
    const c = entry.uiCapabilities;
    if (c.durations.length > 1) defs.push({ key: "duration", label: "Duration", choices: choices(c.durations, durationLabel) });
    if (c.aspectRatios.length > 1) defs.push({ key: "aspectRatio", label: "Aspect", choices: choices(c.aspectRatios, aspectRatioDisplayLabel) });
    if (c.resolutions && c.resolutions.length > 1) defs.push({ key: "resolution", label: "Resolution", choices: choices(c.resolutions, resolutionDisplayLabel) });
  } else if (isImageEntry(entry)) {
    const c = entry.uiCapabilities;
    if (c.aspectRatios.length > 1) defs.push({ key: "aspectRatio", label: "Aspect", choices: choices(c.aspectRatios, aspectRatioDisplayLabel) });
    if (c.resolutions && c.resolutions.length > 1) defs.push({ key: "resolution", label: "Resolution", choices: choices(c.resolutions, resolutionDisplayLabel) });
    if (c.qualities && c.qualities.length > 1) defs.push({ key: "quality", label: "Quality", choices: choices(c.qualities, (q: string) => q.charAt(0).toUpperCase() + q.slice(1)) });
    const max = imageMaxImages(entry);
    if (max > 1) defs.push({ key: "numImages", label: "Count", choices: choices(Array.from({ length: max }, (_, i) => i + 1), (n: number) => `${n}×`) });
  } else {
    const c = entry.uiCapabilities;
    if (audioHasDurationControl(entry)) {
      const list = audioDurationChoices(entry);
      if (list.length > 1) defs.push({ key: "duration", label: "Duration", choices: choices(list, durationLabel) });
    }
    if (c.voices && c.voices.length > 1) defs.push({ key: "voice", label: "Voice", choices: choices(c.voices, (v: string) => v) });
  }
  return defs;
}

function pick(preferred: readonly string[], list: readonly string[]): string | undefined {
  return preferred.find((p) => list.includes(p)) ?? list[0];
}

/** Model defaults: shortest sensible duration, 16:9 when offered, 1080p when offered, top quality, one image. */
export function defaultOptions(entry: PromptEntry): PromptOptions {
  const out: PromptOptions = { duration: 0, aspectRatio: "", numImages: 1, generateAudio: true };
  if (isVideoEntry(entry)) {
    const c = entry.uiCapabilities;
    out.duration = c.durations.includes(5) ? 5 : c.durations[0] ?? 5;
    out.aspectRatio = pick(["16:9"], c.aspectRatios) ?? "16:9";
    if (c.resolutions && c.resolutions.length > 0) out.resolution = pick(["1080p", "720p"], c.resolutions);
  } else if (isImageEntry(entry)) {
    const c = entry.uiCapabilities;
    out.aspectRatio = pick(["1:1", "16:9"], c.aspectRatios) ?? "1:1";
    if (c.resolutions && c.resolutions.length > 0) out.resolution = c.resolutions[0];
    if (c.qualities && c.qualities.length > 0) out.quality = c.qualities[c.qualities.length - 1];
  } else {
    const c = entry.uiCapabilities;
    if (audioHasDurationControl(entry)) out.duration = c.durationRange?.defaultValue ?? audioDurationChoices(entry)[0] ?? 30;
    if (c.voices && c.voices.length > 0) out.voice = c.defaultVoice && c.voices.includes(c.defaultVoice) ? c.defaultVoice : c.voices[0];
  }
  return out;
}

/** Keeps the current values the model still accepts; everything else falls back to the model default. */
export function normalizeOptions(entry: PromptEntry, current: Partial<PromptOptions>): PromptOptions {
  const base = defaultOptions(entry);
  const out: PromptOptions = { ...base };
  for (const def of optionDefs(entry)) {
    const value = current[def.key];
    if (value === undefined) continue;
    if (def.choices.some((c) => c.value === String(value))) (out as unknown as Record<string, unknown>)[def.key] = value;
  }
  return out;
}

/** Model-level checks on the options; the prompt/reference checks live in `validateQuickGeneration`. */
export function validateOptions(entry: PromptEntry, o: PromptOptions): string | undefined {
  for (const def of optionDefs(entry)) {
    const value = o[def.key];
    if (value === undefined || !def.choices.some((c) => c.value === String(value))) return `${entry.displayName} does not support that ${def.label.toLowerCase()}.`;
  }
  return undefined;
}

/** Options as the shared generation settings (resolution only when the model has the control). */
export function toSettings(entry: PromptEntry, prompt: string, o: PromptOptions): GenerationSettings {
  return {
    prompt,
    duration: isImageEntry(entry) ? 0 : o.duration,
    aspectRatio: o.aspectRatio,
    ...(o.resolution !== undefined ? { resolution: o.resolution } : {}),
    ...(o.quality !== undefined ? { quality: o.quality } : {}),
    numImages: o.numImages,
    ...(o.voice !== undefined ? { voice: o.voice } : {}),
    generateAudio: o.generateAudio,
  };
}

/** USD estimate, or undefined when the model has no price hint. */
export function estimateCost(entry: PromptEntry, prompt: string, o: PromptOptions): number | undefined {
  if (isVideoEntry(entry)) return videoCost(entry, { durationSeconds: o.duration, resolution: o.resolution });
  if (isImageEntry(entry)) return imageCost(entry, { resolution: o.resolution, numImages: o.numImages });
  return audioCost(entry, { prompt: prompt.trim(), durationSeconds: audioHasDurationControl(entry) ? o.duration : undefined });
}

// MARK: - History

export const historyLimit = 50;
export const historyStorageKey = "promptbar.history";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Most recent first; a repeated prompt moves to the front. Blank prompts are ignored. */
export function pushHistory(history: readonly string[], prompt: string, limit = historyLimit): string[] {
  const text = prompt.trim();
  if (text === "") return [...history];
  return [text, ...history.filter((h) => h !== text)].slice(0, limit);
}

/** Position after pressing Up (older, +1) or Down (newer, -1). -1 is the live (empty) input; the result is clamped. */
export function stepHistory(length: number, index: number, direction: "older" | "newer"): number {
  if (length === 0) return -1;
  return direction === "older" ? Math.min(length - 1, index + 1) : Math.max(-1, index - 1);
}

export function loadHistory(storage: KeyValueStorage | undefined, limit = historyLimit): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(historyStorageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, limit) : [];
  } catch {
    return [];
  }
}

export function saveHistory(storage: KeyValueStorage | undefined, history: readonly string[]): void {
  try {
    storage?.setItem(historyStorageKey, JSON.stringify(history.slice(0, historyLimit)));
  } catch {
    // Storage may be full or unavailable; history is a convenience.
  }
}
