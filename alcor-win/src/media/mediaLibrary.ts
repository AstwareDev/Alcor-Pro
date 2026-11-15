import {
  Defaults, joinPath, makeMediaAsset, mediaAssetIsGenerated, mediaAssetIsGenerating, type Clip, type ClipType,
  type MediaAsset,
} from "../model";
import type { Editor } from "../editor/editor";
import { newId } from "../util/id";
import { isLottieFile, scanImportRoots, type MediaImportPlan, type PlanParent } from "./importScan";
import { mediaIo } from "./io";
import {
  clearOfflineMediaRef, flushPendingManifestMetadataUpdates, isMediaOffline, libraryState, manifestEntryFor,
  queueManifestMetadataUpdate, refreshMissingMediaCache, removeClipsReferencingAssets, setMissingMediaRef, setUnprocessableMediaRef,
  updateManifestMetadata,
} from "./libraryCore";
import { createFolder } from "./folders";
import { mediaHooks } from "./mediaHooks";
import { clipTypeForPath } from "./mediaTypes";
import { fileStem, hasDirectoryPath, lastPathComponent, normalizeSeparators, parentPath } from "./paths";
import { probeMedia, type MediaProbe } from "./probe";
import { getImageThumbnail, getPoster } from "./thumbnails";
import { getWaveform } from "./waveform";

// ---- MediaPanelItemKey ----

const folderKeyPrefix = "folder-";
const timelineKeyPrefix = "timeline-";

export function mediaPanelFolderKey(id: string): string {
  return folderKeyPrefix + id;
}

export function mediaPanelFolderIdFromKey(key: string): string | undefined {
  return key.startsWith(folderKeyPrefix) ? key.slice(folderKeyPrefix.length) : undefined;
}

export function mediaPanelTimelineKey(id: string): string {
  return timelineKeyPrefix + id;
}

export function mediaPanelTimelineIdFromKey(key: string): string | undefined {
  return key.startsWith(timelineKeyPrefix) ? key.slice(timelineKeyPrefix.length) : undefined;
}

// ---- adding assets ----

/** Appends the asset (unless its id is already present) and syncs its manifest entry. Not undoable. */
export function importMediaAsset(editor: Editor, asset: MediaAsset, options: { skipAppend?: boolean } = {}): void {
  editor.withoutRegistration(() => {
    if (!options.skipAppend && !editor.doc.mediaAssets.some((a) => a.id === asset.id)) {
      editor.doc.mediaAssets.push(asset);
    }
    updateManifestMetadata(editor, [asset]);
  });
}

export interface AddMediaOptions {
  folderId?: string;
  /** Load metadata, update the manifest and warm visuals in the background. Default true. */
  finalize?: boolean;
}

/**
 * References the file in place (external source; nothing is copied into the project).
 * Unsupported types and non-Lottie `.json`/`.lottie` files are refused with a toast.
 */
export async function addMediaAsset(editor: Editor, path: string, options: AddMediaOptions = {}): Promise<MediaAsset | undefined> {
  const type = clipTypeForPath(path);
  const name = lastPathComponent(path);
  if (type === undefined) {
    editor.showToast(`Can't import "${name}" — unsupported file type.`, "error");
    return undefined;
  }
  if (type === "lottie" && !(await isLottieFile(await mediaIo(), path))) {
    editor.showToast(`Can't import "${name}" — not a Lottie animation.`, "error");
    return undefined;
  }
  return addMediaAssetOfType(editor, path, type, options);
}

export function addMediaAssetOfType(editor: Editor, path: string, type: ClipType, options: AddMediaOptions = {}): MediaAsset {
  const asset = makeMediaAsset({ url: path, type, name: fileStem(path) });
  if (options.folderId !== undefined) asset.folderId = options.folderId;
  importMediaAsset(editor, asset);
  if (options.finalize ?? true) void finalizeImportedAsset(editor, asset.id);
  return asset;
}

// ---- Finder / open-panel import ----

export interface MediaImportSummary {
  assetCount: number;
  folderCount: number;
  assets: MediaAsset[];
}

export interface ImportFinderOptions {
  /** Finalise each new asset (metadata, manifest, visuals) after adding it. Default true. */
  finalize?: boolean;
  /** Record "Import Media" as one undo step. Default true; pass false when a caller's own `perform` wraps the result. */
  registerUndo?: boolean;
}

function resolveParent(parent: PlanParent, plannedFolderIds: readonly string[]): string | undefined {
  return parent.kind === "existing" ? parent.folderId : plannedFolderIds[parent.index];
}

/**
 * Creates the planned folders and assets. Must run inside `perform`/`withoutRegistration` so the whole plan is
 * one change. `probes[i]` (optional) is the pre-loaded metadata of `plan.files[i]`.
 */
export function applyMediaImportPlan(editor: Editor, plan: MediaImportPlan, probes?: ReadonlyMap<number, MediaProbe>): MediaAsset[] {
  const folderIds: string[] = [];
  for (const planned of plan.folders) {
    folderIds.push(createFolder(editor, planned.name, resolveParent(planned.parent, folderIds)));
  }
  const imported = plan.files.map((file, i) => {
    const asset = makeMediaAsset({ url: file.path, type: file.type, name: file.name });
    const folderId = resolveParent(file.parent, folderIds);
    if (folderId !== undefined) asset.folderId = folderId;
    const probe = probes?.get(i);
    if (probe) applyProbeToAsset(asset, probe);
    return asset;
  });
  if (imported.length > 0) {
    const doc = editor.doc;
    doc.mediaAssets.push(...imported);
    doc.mediaManifest.entries.push(...imported.map((a) => manifestEntryFor(editor, a)));
  }
  return imported;
}

export function showImportRejections(editor: Editor, plan: MediaImportPlan): void {
  const unsupported = plan.rejectedUnsupportedNames.at(-1);
  const lottie = plan.rejectedLottieNames.at(-1);
  if (unsupported !== undefined) editor.showToast(`Can't import "${unsupported}" — unsupported file type.`, "error");
  else if (lottie !== undefined) editor.showToast(`Can't import "${lottie}" — not a Lottie animation.`, "error");
}

/**
 * Imports files and folders (mirroring the folder tree) as one "Import Media" undo step. Imports are serialised.
 * Files are referenced in place, never copied.
 */
export async function importFinderItems(
  editor: Editor,
  paths: readonly string[],
  intoFolderId: string | undefined,
  options: ImportFinderOptions = {},
): Promise<MediaImportSummary> {
  const state = libraryState(editor);
  const previous = state.importTail;
  state.importSequence += 1;
  const sequence = state.importSequence;
  const task = (async () => {
    try {
      await previous;
    } catch {
      // a failed earlier import must not block this one
    }
    return performFinderImport(editor, paths, intoFolderId, options);
  })();
  state.importTail = task;
  try {
    return await task;
  } finally {
    if (state.importSequence === sequence) state.importTail = undefined;
  }
}

async function performFinderImport(
  editor: Editor,
  paths: readonly string[],
  intoFolderId: string | undefined,
  options: ImportFinderOptions,
): Promise<MediaImportSummary> {
  flushPendingManifestMetadataUpdates(editor);
  const plan = await scanImportRoots(
    await mediaIo(),
    paths.map((path) => ({ path, parentFolderId: intoFolderId })),
  );
  const assetsBefore = editor.mediaAssets.length;
  const foldersBefore = editor.doc.mediaManifest.folders.length;
  let assets: MediaAsset[] = [];
  const apply = () => {
    assets = applyMediaImportPlan(editor, plan);
  };
  if (options.registerUndo ?? true) editor.perform("Import Media", apply);
  else editor.withoutRegistration(apply);
  showImportRejections(editor, plan);
  const summary: MediaImportSummary = {
    assetCount: editor.mediaAssets.length - assetsBefore,
    folderCount: editor.doc.mediaManifest.folders.length - foldersBefore,
    assets,
  };
  if (summary.assetCount === 0 && summary.folderCount === 0) return summary;
  if (options.finalize ?? true) {
    for (const asset of assets) void finalizeImportedAsset(editor, asset.id, { batchManifestUpdate: true });
  }
  return summary;
}

/** Drag-hover placeholders: no disk access; folders (trailing separator) and unsupported types are skipped. */
export function dropPlaceholderAssets(paths: readonly string[]): MediaAsset[] {
  const out: MediaAsset[] = [];
  for (const path of paths) {
    if (hasDirectoryPath(path)) continue;
    const type = clipTypeForPath(path);
    if (type === undefined) continue;
    const asset = makeMediaAsset({ url: path, type, name: fileStem(path), duration: Defaults.imageDurationSeconds });
    asset.hasAudio = type === "video";
    out.push(asset);
  }
  return out;
}

// ---- copy-into-project (generated / pasted media) ----

export class FileTooLargeError extends Error {
  constructor(readonly size: number, readonly maxBytes: number) {
    super(`File is ${size} bytes; the limit is ${maxBytes}.`);
  }
}

export interface CommitStagedOptions {
  maxBytes?: number;
  /** The caller already holds a coordinator admission (`beginMutation`). */
  workAlreadyAdmitted?: boolean;
  signal?: AbortSignal;
}

async function checkSize(path: string, maxBytes: number | undefined): Promise<void> {
  if (maxBytes === undefined) return;
  const size = (await (await mediaIo()).stat(path))?.size ?? 0;
  if (size > maxBytes) throw new FileTooLargeError(size, maxBytes);
}

/**
 * Moves a staged file into `<project>/media/<filename>` (replacing any file there) and returns its path.
 * Without an open project it lands in the temp directory. The staged file is always removed.
 * Package writes are serialised against saves through the project package coordinator.
 */
export async function commitStagedProjectMedia(
  editor: Editor,
  stagedPath: string,
  filename: string,
  options: CommitStagedOptions = {},
): Promise<string> {
  const io = await mediaIo();
  const coordinator = libraryState(editor).coordinator;
  try {
    if (editor.projectPath === null) {
      const destination = joinPath(await io.tempDir(), filename);
      await checkSize(stagedPath, options.maxBytes);
      await io.mkdir(await io.tempDir());
      await io.rename(stagedPath, destination);
      return destination;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = editor.projectPath;
      if (target === null) break;
      options.signal?.throwIfAborted();
      const prepared = joinPath(parentPath(target), `.palmier-stage-${newId()}`);
      try {
        await checkSize(stagedPath, options.maxBytes);
        await io.copy(stagedPath, prepared);
        const admit = !options.workAlreadyAdmitted;
        if (admit) coordinator.beginMutation(options.signal);
        try {
          const destination = await coordinator.performMutation(async () => {
            if (editor.projectPath === null || normalizeSeparators(editor.projectPath) !== normalizeSeparators(target)) {
              return undefined;
            }
            const mediaDir = joinPath(target, "media");
            await io.mkdir(mediaDir);
            const dest = joinPath(mediaDir, filename);
            await io.rename(prepared, dest);
            return dest;
          }, options.signal);
          if (destination !== undefined) return destination;
        } finally {
          if (admit) coordinator.endMutation();
        }
      } finally {
        await io.remove(prepared).catch(() => undefined);
      }
    }
    throw new Error("The project changed while the media was being added.");
  } finally {
    await io.remove(stagedPath).catch(() => undefined);
  }
}

/** Pasted image bytes become `pasted-XXXXXXXX.<ext>` inside the project (or temp) and are imported at the root. */
export async function importPastedImageData(editor: Editor, data: Uint8Array, fileExtension = "png"): Promise<MediaAsset | undefined> {
  const filename = `pasted-${newId().slice(0, 8)}.${fileExtension}`;
  try {
    const io = await mediaIo();
    const staged = joinPath(await io.tempDir(), `palmier-stage-${newId()}.${fileExtension}`);
    await io.writeBytes(staged, data);
    const destination = await commitStagedProjectMedia(editor, staged, filename);
    return await addMediaAsset(editor, destination);
  } catch {
    return undefined;
  }
}

/** `rebaseProjectURL`: after Save As / move, repoint assets that live inside the old package. */
export function rebaseProjectPath(editor: Editor, oldPath: string, newPath: string): void {
  if (editor.projectPath === null || normalizeSeparators(editor.projectPath) !== normalizeSeparators(oldPath)) return;
  const oldPrefix = normalizeSeparators(oldPath).replace(/\/+$/, "") + "/";
  editor.withoutRegistration(() => {
    for (const asset of editor.doc.mediaAssets) {
      const path = normalizeSeparators(asset.url);
      if (path.startsWith(oldPrefix)) asset.url = joinPath(newPath, path.slice(oldPrefix.length));
    }
  });
  editor.projectPath = newPath;
  void refreshMissingMediaCache(editor);
}

// ---- rename / delete ----

/** Undoable ("Rename Asset"). */
export function renameMediaAsset(editor: Editor, id: string, name: string): void {
  editor.perform("Rename Asset", () => {
    const asset = editor.doc.mediaAssets.find((a) => a.id === id);
    if (!asset) return;
    asset.name = name;
    const entry = editor.doc.mediaManifest.entries.find((e) => e.id === id);
    if (entry) entry.name = name;
  });
}

/** Undoable ("Delete Media"): removes the assets and every clip that references them. */
export function deleteMediaAssets(editor: Editor, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  if (!editor.mediaAssets.some((a) => ids.has(a.id))) return;
  flushPendingManifestMetadataUpdates(editor);
  let removedClips = false;
  editor.perform("Delete Media", () => {
    removedClips = removeClipsReferencingAssets(editor, ids).size > 0;
    const doc = editor.doc;
    doc.mediaAssets = doc.mediaAssets.filter((a) => !ids.has(a.id));
    doc.mediaManifest.entries = doc.mediaManifest.entries.filter((e) => !ids.has(e.id));
  });
  mediaHooks.closeAssetPreviewTabs?.(ids);
  editor.ui.selectedMediaAssetIds = new Set();
  if (removedClips) mediaHooks.timelineChanged?.();
}

// ---- metadata finalisation ----

/** `MediaAsset.loadMetadata`'s field updates, applied to a mutable asset (a draft inside `perform`). */
export function applyProbeToAsset(asset: MediaAsset, probe: MediaProbe): void {
  switch (asset.type) {
    case "image":
      asset.duration = Defaults.imageDurationSeconds;
      if (probe.width !== undefined) asset.sourceWidth = probe.width;
      if (probe.height !== undefined) asset.sourceHeight = probe.height;
      return;
    case "lottie":
      if (!probe.ok) return;
      if (probe.duration !== undefined) asset.duration = probe.duration;
      if (probe.width !== undefined) asset.sourceWidth = probe.width;
      if (probe.height !== undefined) asset.sourceHeight = probe.height;
      if (probe.fps !== undefined) asset.sourceFPS = probe.fps;
      return;
    case "subtitle":
      if (probe.ok && probe.duration !== undefined) asset.duration = probe.duration;
      return;
    case "video":
      if (probe.duration === undefined) return; // the file could not be opened at all
      asset.duration = probe.duration;
      if (probe.width !== undefined) asset.sourceWidth = probe.width;
      if (probe.height !== undefined) asset.sourceHeight = probe.height;
      if (probe.fps !== undefined) asset.sourceFPS = probe.fps;
      asset.hasAudio = probe.hasAudio;
      return;
    case "audio":
      if (probe.duration !== undefined) asset.duration = probe.duration;
      return;
    default:
      return;
  }
}

export interface FinalizeOptions {
  /** Many assets are being finalised together: coalesce manifest writes and skip warming visuals. */
  batchManifestUpdate?: boolean;
}

function recordManifestMetadata(editor: Editor, asset: MediaAsset, batching: boolean): void {
  if (batching) queueManifestMetadataUpdate(editor, asset.id);
  else updateManifestMetadata(editor, [asset]);
}

/**
 * Probes the file and hydrates the asset (duration, size, fps, audio), its manifest entry and the
 * missing/unprocessable flags. Not undoable. Returns whether the media is usable.
 */
export async function finalizeImportedAsset(editor: Editor, assetId: string, options: FinalizeOptions = {}): Promise<boolean> {
  const batching = options.batchManifestUpdate ?? false;
  const started = editor.mediaAsset(assetId);
  if (!started) return false;
  const path = started.url;
  const probe = await probeMedia(path, { type: started.type });
  const current = editor.mediaAsset(assetId);
  if (!current || current.url !== path) return false;

  const exists = (await (await mediaIo()).stat(path)) !== null;
  if (!probe.ok) {
    editor.withoutRegistration(() => {
      const draft = editor.doc.mediaAssets.find((a) => a.id === assetId);
      if (!draft) return;
      applyProbeToAsset(draft, probe);
      if (mediaAssetIsGenerating(draft) || mediaAssetIsGenerated(draft) || draft.importInput !== undefined) {
        draft.generationStatus = { kind: "failed", message: "Could not read media file." };
      }
    });
    if (exists) setUnprocessableMediaRef(editor, assetId, true);
    else setMissingMediaRef(editor, assetId, true);
    const failed = editor.mediaAsset(assetId);
    if (failed) {
      recordManifestMetadata(editor, failed, batching);
      void refreshMissingMediaCache(editor);
      mediaHooks.assetFinalized?.(failed);
    }
    return false;
  }

  editor.withoutRegistration(() => {
    const draft = editor.doc.mediaAssets.find((a) => a.id === assetId);
    if (!draft) return;
    applyProbeToAsset(draft, probe);
    if (mediaAssetIsGenerating(draft)) draft.generationStatus = { kind: "none" };
  });
  const finalized = editor.mediaAsset(assetId);
  if (!finalized) return false;
  recordManifestMetadata(editor, finalized, batching);
  if (exists) {
    setMissingMediaRef(editor, assetId, false);
    clearOfflineMediaRef(editor, assetId);
    setUnprocessableMediaRef(editor, assetId, !probe.canDecode);
  }
  void refreshMissingMediaCache(editor);
  mediaHooks.scheduleSearchIndex?.(finalized);
  if (!batching) prepareMediaVisuals(finalized);
  mediaHooks.assetFinalized?.(finalized);
  return true;
}

/** After undo/redo restores assets saved before their metadata was hydrated, re-run finalisation for them. */
export function refinalizeIncompleteAssets(editor: Editor): void {
  for (const asset of editor.mediaAssets) {
    if (mediaAssetIsGenerating(asset)) continue;
    const incomplete =
      ((asset.type === "video" || asset.type === "audio") && !(asset.duration > 0)) ||
      (asset.type === "image" && (asset.sourceWidth === undefined || asset.sourceHeight === undefined));
    if (incomplete) void finalizeImportedAsset(editor, asset.id, { batchManifestUpdate: true });
  }
}

/** Warms the caches the timeline and media panel will ask for; failures are ignored (they retry on demand). */
export function prepareMediaVisuals(asset: MediaAsset): void {
  const warm = (work: Promise<unknown>) => {
    work.catch(() => undefined);
  };
  switch (asset.type) {
    case "video":
      if (asset.hasAudio) warm(getWaveform(asset.url));
      warm(getPoster(asset.url, { type: "video" }));
      return;
    case "audio":
      warm(getWaveform(asset.url));
      return;
    case "image":
      warm(getImageThumbnail(asset.url));
      return;
    default:
      return;
  }
}

// ---- reads ----

export function isClipMediaOffline(editor: Editor, clip: Clip): boolean {
  if (clip.sourceClipType === "sequence") return !editor.doc.timelines.some((t) => t.id === clip.mediaRef);
  return clip.mediaType !== "text" && isMediaOffline(editor, clip.mediaRef);
}

export function isClipMediaGenerating(editor: Editor, clip: Clip): boolean {
  if (clip.mediaType === "text") return false;
  const asset = editor.mediaAsset(clip.mediaRef);
  return asset !== undefined && mediaAssetIsGenerating(asset);
}

export function clipDisplayLabel(editor: Editor, clip: Clip): string {
  if (clip.mediaType === "text") {
    const content = clip.textContent ?? "";
    if (content === "") return "Text";
    return content.replace(/\n/g, " ").replace(/\r/g, " ");
  }
  const asset = editor.mediaAsset(clip.mediaRef);
  if (asset && mediaAssetIsGenerating(asset)) return asset.name;
  if (clip.sourceClipType === "sequence") {
    const nested = editor.doc.timelines.find((t) => t.id === clip.mediaRef);
    if (nested) return nested.name;
  }
  return editor.doc.mediaManifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? "Offline";
}
