import {
  asObject, DecodingError, decodeBool, decodeDouble, decodeRecord, decodeString, getDouble, getEnum, getInt, getString,
  getWith, optArray, optBool, optDouble, optInt, optString, optWith,
} from "../util/jsonDecode";
import { clipTypes, type ClipType } from "./clipType";
import { decodeMediaFolder, type MediaFolder } from "./mediaFolder";

/*
 * `Date` fields are persisted by Swift's default JSONEncoder as seconds since 2001-01-01 UTC
 * (timeIntervalSinceReferenceDate). They are kept as that raw number here so the JSON round-trips unchanged.
 */
export type SwiftDate = number;

const swiftReferenceDateUnixSeconds = 978307200;

export function swiftDateNow(): SwiftDate {
  return Date.now() / 1000 - swiftReferenceDateUnixSeconds;
}

export function swiftDateToJsDate(d: SwiftDate): Date {
  return new Date((d + swiftReferenceDateUnixSeconds) * 1000);
}

export function jsDateToSwiftDate(d: Date): SwiftDate {
  return d.getTime() / 1000 - swiftReferenceDateUnixSeconds;
}

/** Synthesized enum Codable: `{"external":{"absolutePath":..}}` or `{"project":{"relativePath":..}}`. */
export type MediaSource =
  | { external: { absolutePath: string } }
  | { project: { relativePath: string } };

export function makeExternalSource(absolutePath: string): MediaSource {
  return { external: { absolutePath } };
}

export function makeProjectSource(relativePath: string): MediaSource {
  return { project: { relativePath } };
}

export function decodeMediaSource(json: unknown): MediaSource {
  const c = asObject(json, "MediaSource");
  const keys = ["external", "project"].filter((k) => Object.prototype.hasOwnProperty.call(c, k));
  if (keys.length !== 1) throw new DecodingError("MediaSource: expected exactly one case key");
  if (keys[0] === "external") {
    return { external: { absolutePath: getString(asObject(c["external"], "external"), "absolutePath") } };
  }
  return { project: { relativePath: getString(asObject(c["project"], "project"), "relativePath") } };
}

export interface UpscaleSettings {
  selections: Record<string, string>;
  numbers: Record<string, number>;
  toggles: Record<string, boolean>;
}

export function makeUpscaleSettings(p: Partial<UpscaleSettings> = {}): UpscaleSettings {
  return { selections: p.selections ?? {}, numbers: p.numbers ?? {}, toggles: p.toggles ?? {} };
}

export function decodeUpscaleSettings(json: unknown): UpscaleSettings {
  const c = asObject(json, "UpscaleSettings");
  return {
    selections: getWith(c, "selections", (v) => decodeRecord(v, decodeString, "selections")),
    numbers: getWith(c, "numbers", (v) => decodeRecord(v, decodeDouble, "numbers")),
    toggles: getWith(c, "toggles", (v) => decodeRecord(v, decodeBool, "toggles")),
  };
}

export interface MediaImportInput {
  sourceURL?: string;
  sourcePath?: string;
  createdAt?: SwiftDate;
}

export function decodeMediaImportInput(json: unknown): MediaImportInput {
  const c = asObject(json, "MediaImportInput");
  return stripUndefined({
    sourceURL: optString(c, "sourceURL"),
    sourcePath: optString(c, "sourcePath"),
    createdAt: optDouble(c, "createdAt"),
  });
}

export interface GenerationInput {
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  upscaleSettings?: UpscaleSettings;
  upscaleSourceWidth?: number;
  upscaleSourceHeight?: number;
  upscaleSourceFPS?: number;
  quality?: string;
  imageURLs?: string[];
  /** Image-only */
  numImages?: number;
  /** Audio-only */
  voice?: string;
  lyrics?: string;
  styleInstructions?: string;
  instrumental?: boolean;
  targetLanguage?: string;
  multilingual?: boolean;
  audioInput?: string;
  /** Video-only */
  generateAudio?: boolean;
  draft?: boolean;
  usesSourceVideo?: boolean;
  referenceImageURLs?: string[];
  referenceVideoURLs?: string[];
  referenceAudioURLs?: string[];
  /** Asset IDs for the references. */
  imageURLAssetIds?: string[];
  referenceImageAssetIds?: string[];
  referenceVideoAssetIds?: string[];
  referenceAudioAssetIds?: string[];
  createdAt?: SwiftDate;
  backendJobId?: string;
  outputIndex?: number;
  resultURLs?: string[];
  costCredits?: number;
  refundedCredits?: number;
}

export function makeGenerationInput(
  p: Partial<GenerationInput> & { prompt: string; model: string; duration: number; aspectRatio: string },
): GenerationInput {
  return stripUndefined({ ...p });
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function decodeGenerationInput(json: unknown): GenerationInput {
  const c = asObject(json, "GenerationInput");
  const strings = (k: string): string[] | undefined => optArray(c, k, (e) => decodeString(e, k));
  return stripUndefined({
    prompt: getString(c, "prompt"),
    model: getString(c, "model"),
    duration: getInt(c, "duration"),
    aspectRatio: getString(c, "aspectRatio"),
    resolution: optString(c, "resolution"),
    upscaleSettings: optWith(c, "upscaleSettings", decodeUpscaleSettings),
    upscaleSourceWidth: optInt(c, "upscaleSourceWidth"),
    upscaleSourceHeight: optInt(c, "upscaleSourceHeight"),
    upscaleSourceFPS: optDouble(c, "upscaleSourceFPS"),
    quality: optString(c, "quality"),
    imageURLs: strings("imageURLs"),
    numImages: optInt(c, "numImages"),
    voice: optString(c, "voice"),
    lyrics: optString(c, "lyrics"),
    styleInstructions: optString(c, "styleInstructions"),
    instrumental: optBool(c, "instrumental"),
    targetLanguage: optString(c, "targetLanguage"),
    multilingual: optBool(c, "multilingual"),
    audioInput: optString(c, "audioInput"),
    generateAudio: optBool(c, "generateAudio"),
    draft: optBool(c, "draft"),
    usesSourceVideo: optBool(c, "usesSourceVideo"),
    referenceImageURLs: strings("referenceImageURLs"),
    referenceVideoURLs: strings("referenceVideoURLs"),
    referenceAudioURLs: strings("referenceAudioURLs"),
    imageURLAssetIds: strings("imageURLAssetIds"),
    referenceImageAssetIds: strings("referenceImageAssetIds"),
    referenceVideoAssetIds: strings("referenceVideoAssetIds"),
    referenceAudioAssetIds: strings("referenceAudioAssetIds"),
    createdAt: optDouble(c, "createdAt"),
    backendJobId: optString(c, "backendJobId"),
    outputIndex: optInt(c, "outputIndex"),
    resultURLs: strings("resultURLs"),
    costCredits: optInt(c, "costCredits"),
    refundedCredits: optInt(c, "refundedCredits"),
  });
}

export interface MediaManifestEntry {
  id: string;
  name: string;
  type: ClipType;
  source: MediaSource;
  duration: number;
  generationInput?: GenerationInput;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFPS?: number;
  hasAudio?: boolean;
  folderId?: string;
  cachedRemoteURL?: string;
  cachedRemoteURLExpiresAt?: SwiftDate;
  generationStatus?: string;
  importInput?: MediaImportInput;
}

export function makeMediaManifestEntry(
  p: Partial<MediaManifestEntry> & { id: string; name: string; type: ClipType; source: MediaSource; duration: number },
): MediaManifestEntry {
  return stripUndefined({ ...p });
}

export function decodeMediaManifestEntry(json: unknown): MediaManifestEntry {
  const c = asObject(json, "MediaManifestEntry");
  return stripUndefined({
    id: getString(c, "id"),
    name: getString(c, "name"),
    type: getEnum(c, "type", clipTypes),
    source: getWith(c, "source", decodeMediaSource),
    duration: getDouble(c, "duration"),
    generationInput: optWith(c, "generationInput", decodeGenerationInput),
    sourceWidth: optInt(c, "sourceWidth"),
    sourceHeight: optInt(c, "sourceHeight"),
    sourceFPS: optDouble(c, "sourceFPS"),
    hasAudio: optBool(c, "hasAudio"),
    folderId: optString(c, "folderId"),
    cachedRemoteURL: optString(c, "cachedRemoteURL"),
    cachedRemoteURLExpiresAt: optDouble(c, "cachedRemoteURLExpiresAt"),
    generationStatus: optString(c, "generationStatus"),
    importInput: optWith(c, "importInput", decodeMediaImportInput),
  });
}

export interface MediaManifest {
  version: number;
  entries: MediaManifestEntry[];
  folders: MediaFolder[];
}

/** `MediaManifest()` — a fresh manifest is version 2; a decoded one without `version` is 1. */
export function makeMediaManifest(p: Partial<MediaManifest> = {}): MediaManifest {
  return { version: p.version ?? 2, entries: p.entries ?? [], folders: p.folders ?? [] };
}

export function decodeMediaManifest(json: unknown): MediaManifest {
  const c = asObject(json, "MediaManifest");
  return {
    version: optInt(c, "version") ?? 1,
    entries: optArray(c, "entries", decodeMediaManifestEntry) ?? [],
    folders: optArray(c, "folders", decodeMediaFolder) ?? [],
  };
}
