import { newId } from "../util/id";
import type { ClipType } from "./clipType";
import {
  makeExternalSource, makeProjectSource, swiftDateNow,
  type GenerationInput, type MediaImportInput, type MediaManifestEntry, type SwiftDate,
} from "./mediaManifest";

/*
 * Port of the persisted data and pure logic of MediaAsset. Not ported (AppKit / AVFoundation bound):
 * thumbnail + thumbnailMaxPixelSize, installThumbnail, loadLibraryThumbnail, loadPreviewThumbnail,
 * loadMetadata (AVURLAsset / Lottie / subtitle probing), the load-gate semaphores.
 * `url` is a filesystem path string.
 */

export type GenerationStatus =
  | { kind: "none" }
  | { kind: "preparing" }
  | { kind: "generating" }
  | { kind: "downloading" }
  | { kind: "rendering" }
  | { kind: "failed"; message: string };

const failedPrefix = "failed: ";

export function generationStatusSerialized(s: GenerationStatus): string {
  return s.kind === "failed" ? `${failedPrefix}${s.message}` : s.kind;
}

// .none/.preparing are transient and must not restore as in-progress.
export function generationStatusManifestValue(s: GenerationStatus): string | undefined {
  return s.kind === "none" || s.kind === "preparing" ? undefined : generationStatusSerialized(s);
}

export function generationStatusFromSerialized(value: string | undefined): GenerationStatus {
  switch (value) {
    case "preparing": return { kind: "preparing" };
    case "generating": return { kind: "generating" };
    case "downloading": return { kind: "downloading" };
    case "rendering": return { kind: "rendering" };
  }
  if (value !== undefined && value.startsWith(failedPrefix)) {
    return { kind: "failed", message: Array.from(value).slice(Array.from(failedPrefix).length).join("") };
  }
  return { kind: "none" };
}

export interface MediaAsset {
  id: string;
  url: string;
  type: ClipType;
  name: string;
  duration: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFPS?: number;
  hasAudio: boolean;
  generationInput?: GenerationInput;
  importInput?: MediaImportInput;
  generationStatus: GenerationStatus;
  folderId?: string;
  pendingDownloadURL?: string;
  cachedRemoteURL?: string;
  cachedRemoteURLExpiresAt?: SwiftDate;
}

export function makeMediaAsset(p: {
  id?: string;
  url: string;
  type: ClipType;
  name: string;
  duration?: number;
  generationInput?: GenerationInput;
}): MediaAsset {
  const a: MediaAsset = {
    id: p.id ?? newId(),
    url: p.url,
    type: p.type,
    name: p.name,
    duration: p.duration ?? 0,
    hasAudio: p.type === "video",
    generationStatus: { kind: "none" },
  };
  if (p.generationInput !== undefined) a.generationInput = p.generationInput;
  return a;
}

/** Returns the cached URL if it's set AND not expired; else undefined. */
export function mediaAssetFreshRemoteURL(a: MediaAsset, now: SwiftDate = swiftDateNow()): string | undefined {
  if (a.cachedRemoteURL === undefined || a.cachedRemoteURLExpiresAt === undefined) return undefined;
  return a.cachedRemoteURLExpiresAt > now ? a.cachedRemoteURL : undefined;
}

export function mediaAssetIsGenerated(a: MediaAsset): boolean {
  return a.generationInput !== undefined;
}

export function mediaAssetCanResumeGeneration(a: MediaAsset): boolean {
  const id = a.generationInput?.backendJobId;
  return id !== undefined && id !== "";
}

export function mediaAssetIsGenerating(a: MediaAsset): boolean {
  const k = a.generationStatus.kind;
  return k === "preparing" || k === "generating" || k === "downloading" || k === "rendering";
}

export function mediaAssetCanEnhanceDraft(a: MediaAsset): boolean {
  const input = a.generationInput;
  if (a.generationStatus.kind !== "none" || input === undefined) return false;
  return input.draft === true && input.backendJobId !== undefined && (input.resultURLs?.length ?? 0) >= 2;
}

/**
 * `draftEnhanceCreditsPerSecond` comes from the generation model catalog (ModelRegistry, not ported);
 * pass the looked-up video model's rate, or undefined when the model is unknown / has none.
 */
export function mediaAssetDraftEnhancementCost(a: MediaAsset, creditsPerSecond: number | undefined): number | undefined {
  const input = a.generationInput;
  if (input === undefined || input.draft !== true || creditsPerSecond === undefined || !(input.duration > 0)) return undefined;
  return Math.ceil(creditsPerSecond * input.duration);
}

export function mediaAssetResolvedDuration(a: MediaAsset): number {
  if (Number.isFinite(a.duration) && a.duration > 0) return a.duration;
  const generated = a.generationInput?.duration;
  if (generated !== undefined && generated > 0) return generated;
  return 0;
}

export function mediaAssetIsRecoveringGeneration(a: MediaAsset): boolean {
  if (!mediaAssetCanResumeGeneration(a)) return false;
  if (mediaAssetIsGenerating(a)) return true;
  if (a.generationStatus.kind === "failed") return (a.generationInput?.resultURLs?.length ?? 0) > 0;
  return false;
}

export function mediaAssetWasGenerationRefunded(a: MediaAsset): boolean {
  if (a.generationStatus.kind !== "failed") return false;
  return (a.generationInput?.refundedCredits ?? 0) > 0;
}

export function mediaAssetGeneratingLabel(a: MediaAsset): string {
  switch (a.generationStatus.kind) {
    case "preparing": return "Preparing…";
    case "downloading": return "Downloading…";
    case "rendering": return "Rendering…";
    default: return "Generating…";
  }
}

/** Reconstruct from a manifest entry + resolved path. */
export function mediaAssetFromManifestEntry(entry: MediaManifestEntry, resolvedPath: string): MediaAsset {
  const a = makeMediaAsset({
    id: entry.id,
    url: resolvedPath,
    type: entry.type,
    name: entry.name,
    duration: entry.duration,
    generationInput: entry.generationInput,
  });
  if (entry.sourceWidth !== undefined) a.sourceWidth = entry.sourceWidth;
  if (entry.sourceHeight !== undefined) a.sourceHeight = entry.sourceHeight;
  if (entry.sourceFPS !== undefined) a.sourceFPS = entry.sourceFPS;
  a.hasAudio = entry.hasAudio ?? false;
  if (entry.folderId !== undefined) a.folderId = entry.folderId;
  if (entry.cachedRemoteURL !== undefined) a.cachedRemoteURL = entry.cachedRemoteURL;
  if (entry.cachedRemoteURLExpiresAt !== undefined) a.cachedRemoteURLExpiresAt = entry.cachedRemoteURLExpiresAt;
  if (entry.importInput !== undefined) a.importInput = entry.importInput;
  const restored = generationStatusFromSerialized(entry.generationStatus);
  a.generationStatus = restored.kind === "preparing" && !mediaAssetCanResumeGeneration(a) ? { kind: "none" } : restored;
  return a;
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Produce a serializable manifest entry from this asset. `projectPath` is the project package directory. */
export function mediaAssetToManifestEntry(a: MediaAsset, projectPath: string | undefined, now: SwiftDate = swiftDateNow()): MediaManifestEntry {
  const url = normalizeSeparators(a.url);
  const project = projectPath === undefined ? undefined : normalizeSeparators(projectPath);
  const source =
    project !== undefined && url.startsWith(project)
      ? makeProjectSource(url.slice(project.length + 1))
      : makeExternalSource(a.url);
  const fresh = mediaAssetFreshRemoteURL(a, now);
  const entry: MediaManifestEntry = { id: a.id, name: a.name, type: a.type, source, duration: a.duration };
  if (a.generationInput !== undefined) entry.generationInput = a.generationInput;
  if (a.sourceWidth !== undefined) entry.sourceWidth = a.sourceWidth;
  if (a.sourceHeight !== undefined) entry.sourceHeight = a.sourceHeight;
  if (a.sourceFPS !== undefined) entry.sourceFPS = a.sourceFPS;
  entry.hasAudio = a.hasAudio;
  if (a.folderId !== undefined) entry.folderId = a.folderId;
  if (fresh !== undefined) {
    entry.cachedRemoteURL = fresh;
    if (a.cachedRemoteURLExpiresAt !== undefined) entry.cachedRemoteURLExpiresAt = a.cachedRemoteURLExpiresAt;
  }
  const status = generationStatusManifestValue(a.generationStatus);
  if (status !== undefined) entry.generationStatus = status;
  if (a.importInput !== undefined) entry.importInput = a.importInput;
  return entry;
}
