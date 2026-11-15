import { createMutable } from "solid-js/store";
import {
  mediaAssetIsGenerating, mediaAssetIsRecoveringGeneration, mediaAssetToManifestEntry, mediaResolverExpectedPathMapFor,
  mediaResolverMissingAssetIds, type MediaAsset, type MediaManifestEntry,
} from "../model";
import type { Editor } from "../editor/editor";
import { snapshot } from "../util/snapshot";
import { yieldToUi } from "./concurrency";
import { mediaIo } from "./io";
import { makeProjectPackageCoordinator, type ProjectPackageCoordinator } from "./projectPackageCoordinator";

/** Per-editor state that Swift keeps as stored properties of EditorViewModel but the `Editor` class does not have. */
interface LibraryState {
  coordinator: ProjectPackageCoordinator;
  /** Serialises Finder imports (`mediaImportTail`). */
  importTail: Promise<unknown> | undefined;
  importSequence: number;
  /** Present-but-unpreparable media (`unprocessableMediaRefs`). Reassign, never mutate in place. */
  reactive: { unprocessableMediaRefs: Set<string> };
  pendingManifestMetadata: Set<string>;
  pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
  missingRefreshToken: number;
}

const states = new WeakMap<Editor, LibraryState>();

export function libraryState(editor: Editor): LibraryState {
  let state = states.get(editor);
  if (!state) {
    state = {
      coordinator: makeProjectPackageCoordinator(),
      importTail: undefined,
      importSequence: 0,
      reactive: createMutable({ unprocessableMediaRefs: new Set<string>() }),
      pendingManifestMetadata: new Set(),
      pendingFlushTimer: undefined,
      missingRefreshToken: 0,
    };
    states.set(editor, state);
  }
  return state;
}

export function projectPackageCoordinator(editor: Editor): ProjectPackageCoordinator {
  return libraryState(editor).coordinator;
}

export function unprocessableMediaRefs(editor: Editor): ReadonlySet<string> {
  return libraryState(editor).reactive.unprocessableMediaRefs;
}

export function setUnprocessableMediaRef(editor: Editor, assetId: string, unprocessable: boolean): void {
  const state = libraryState(editor).reactive;
  if (state.unprocessableMediaRefs.has(assetId) === unprocessable) return;
  const next = new Set(state.unprocessableMediaRefs);
  if (unprocessable) next.add(assetId);
  else next.delete(assetId);
  state.unprocessableMediaRefs = next;
}

export function setMissingMediaRef(editor: Editor, assetId: string, missing: boolean): void {
  if (editor.ui.missingMediaRefs.has(assetId) === missing) return;
  const next = new Set(editor.ui.missingMediaRefs);
  if (missing) next.add(assetId);
  else next.delete(assetId);
  editor.ui.missingMediaRefs = next;
}

export function clearOfflineMediaRef(editor: Editor, assetId: string): void {
  if (!editor.ui.offlineMediaRefs.has(assetId)) return;
  const next = new Set(editor.ui.offlineMediaRefs);
  next.delete(assetId);
  editor.ui.offlineMediaRefs = next;
}

/** Missing on disk or present-but-unloadable (no permission, ejected volume). */
export function isMediaOffline(editor: Editor, mediaRef: string): boolean {
  return (
    editor.ui.offlineMediaRefs.has(mediaRef) ||
    unprocessableMediaRefs(editor).has(mediaRef) ||
    editor.ui.missingMediaRefs.has(mediaRef)
  );
}

/** Present-but-unpreparable (e.g. failed to encode). */
export function isMediaUnprocessable(editor: Editor, mediaRef: string): boolean {
  return unprocessableMediaRefs(editor).has(mediaRef) && !editor.ui.missingMediaRefs.has(mediaRef);
}

// ---- manifest sync ----

export function manifestEntryFor(editor: Editor, asset: MediaAsset): MediaManifestEntry {
  const entry = mediaAssetToManifestEntry(snapshot(asset), editor.projectPath ?? undefined);
  // The manifest must not alias objects owned by the asset (one object, one place in the tree).
  if (entry.generationInput !== undefined) entry.generationInput = structuredClone(entry.generationInput);
  if (entry.importInput !== undefined) entry.importInput = structuredClone(entry.importInput);
  return entry;
}

/** Upserts manifest entries from live assets. Not undoable (metadata hydration). */
export function updateManifestMetadata(editor: Editor, assets: readonly MediaAsset[]): void {
  if (assets.length === 0) return;
  editor.withoutRegistration(() => {
    const entries = editor.doc.mediaManifest.entries;
    const indices = new Map<string, number>();
    entries.forEach((entry, i) => indices.set(entry.id, i));
    for (const asset of assets) {
      const entry = manifestEntryFor(editor, asset);
      const index = indices.get(asset.id);
      if (index !== undefined) entries[index] = entry;
      else {
        indices.set(asset.id, entries.length);
        entries.push(entry);
      }
    }
  });
}

const pendingFlushDelayMs = 20;
const pendingFlushThreshold = 64;

/** Coalesces manifest refreshes of many assets finalised in quick succession. */
export function queueManifestMetadataUpdate(editor: Editor, assetId: string): void {
  const state = libraryState(editor);
  state.pendingManifestMetadata.add(assetId);
  if (state.pendingManifestMetadata.size >= pendingFlushThreshold) flushPendingManifestMetadataUpdates(editor);
  else if (state.pendingFlushTimer === undefined) {
    state.pendingFlushTimer = setTimeout(() => {
      state.pendingFlushTimer = undefined;
      flushPendingManifestMetadataUpdates(editor);
    }, pendingFlushDelayMs);
  }
}

/** Writes the latest live state of every queued asset; assets deleted meanwhile are skipped. */
export function flushPendingManifestMetadataUpdates(editor: Editor): void {
  const state = libraryState(editor);
  if (state.pendingFlushTimer !== undefined) {
    clearTimeout(state.pendingFlushTimer);
    state.pendingFlushTimer = undefined;
  }
  if (state.pendingManifestMetadata.size === 0) return;
  const ids = state.pendingManifestMetadata;
  state.pendingManifestMetadata = new Set();
  updateManifestMetadata(editor, editor.mediaAssets.filter((a) => ids.has(a.id)));
}

/** Writes `folderId` to both the asset and its manifest entry; must run inside `perform`/`withoutRegistration`. */
export function setAssetFolderId(editor: Editor, assetId: string, folderId: string | undefined): void {
  const doc = editor.doc;
  const asset = doc.mediaAssets.find((a) => a.id === assetId);
  if (asset) {
    if (folderId === undefined) delete asset.folderId;
    else asset.folderId = folderId;
  }
  const entry = doc.mediaManifest.entries.find((e) => e.id === assetId);
  if (entry) {
    if (folderId === undefined) delete entry.folderId;
    else entry.folderId = folderId;
  }
}

/**
 * Removes every clip referencing `assetIds` from every timeline and prunes emptied tracks of touched timelines.
 * Must run inside `perform`. Returns the removed clip ids.
 */
export function removeClipsReferencingAssets(editor: Editor, assetIds: ReadonlySet<string>): Set<string> {
  const removed = new Set<string>();
  for (const timeline of editor.doc.timelines) {
    let touched = false;
    for (const track of timeline.tracks) {
      let hit = false;
      for (const clip of track.clips) {
        if (assetIds.has(clip.mediaRef)) {
          removed.add(clip.id);
          hit = true;
        }
      }
      if (!hit) continue;
      track.clips = track.clips.filter((c) => !assetIds.has(c.mediaRef));
      touched = true;
    }
    if (touched) timeline.tracks = timeline.tracks.filter((t) => t.clips.length > 0);
  }
  if (removed.size > 0) {
    editor.ui.selectedClipIds = new Set([...editor.ui.selectedClipIds].filter((id) => !removed.has(id)));
  }
  return removed;
}

// ---- missing-media detection ----

const statChunk = 16;

/** Asset ids whose backing file is missing, from a snapshot of manifest entries; stats in bounded async chunks. Undefined if superseded. */
export async function findMissingAssetIds(
  entries: readonly MediaManifestEntry[],
  projectPath: string | undefined,
  isCurrent: () => boolean = () => true,
): Promise<Set<string> | undefined> {
  const io = await mediaIo();
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = mediaResolverExpectedPathMapFor([entry], projectPath).get(entry.id);
    if (path !== undefined) paths.add(path);
  }
  const existing = new Set<string>();
  const list = [...paths];
  for (let i = 0; i < list.length; i += statChunk) {
    const chunk = list.slice(i, i + statChunk);
    const stats = await Promise.all(chunk.map((p) => io.stat(p).catch(() => null)));
    stats.forEach((s, j) => {
      if (s) existing.add(chunk[j]);
    });
    if (!isCurrent()) return undefined;
    await yieldToUi();
  }
  return mediaResolverMissingAssetIds(entries, projectPath, (p) => existing.has(p));
}

/** Recomputes `ui.missingMediaRefs` off the critical path; a newer call supersedes an older one. */
export async function refreshMissingMediaCache(editor: Editor): Promise<void> {
  const state = libraryState(editor);
  state.missingRefreshToken += 1;
  const token = state.missingRefreshToken;
  const entries = editor.doc.mediaManifest.entries;
  const missing = await findMissingAssetIds(entries, editor.projectPath ?? undefined, () => token === state.missingRefreshToken);
  if (missing === undefined || token !== state.missingRefreshToken) return;
  const recovering = new Set(
    editor.mediaAssets.filter((a) => mediaAssetIsGenerating(a) || mediaAssetIsRecoveringGeneration(a)).map((a) => a.id),
  );
  const resolved = new Set([...missing].filter((id) => !recovering.has(id)));
  const current = editor.ui.missingMediaRefs;
  if (current.size !== resolved.size || [...resolved].some((id) => !current.has(id))) {
    editor.ui.missingMediaRefs = resolved;
  }
}
