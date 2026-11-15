// Port of EditorViewModel+MediaPanel and the panel-drop parts of +MediaLibrary: selection model across
// folders / timelines / assets, keyboard navigation, folder creation, mixed delete, drop and paste routing.
import { createSignal } from "solid-js";
import type { MediaAsset } from "../../model";
import { decodeMediaDrag } from "../../mediapanel/dragPayload";
import {
  createFolder, deleteFolders, deleteMediaAssets, folder, folderIdsIncludingDescendants, importFinderItems,
  importPastedImageData, mediaPanelFolderIdFromKey, mediaPanelFolderKey, mediaPanelTimelineIdFromKey,
  mediaPanelTimelineKey, moveAssetsToFolder, moveFoldersToFolder, moveTimelinesToFolder, type ImportFinderOptions, type MediaImportSummary,
} from "../../media/library";
import type { Editor } from "../editor";
import { cannotDeleteLastTimelineMessage, deleteTimeline, timelineFor } from "./timelines";

export type MediaPanelSelectionMode = "replacing" | "toggling" | "range" | "extendingRange";

/** Windows maps Ctrl to the Swift Command modifier. */
export function mediaPanelSelectionMode(mods: { ctrl: boolean; shift: boolean }): MediaPanelSelectionMode {
  if (mods.ctrl && mods.shift) return "extendingRange";
  if (mods.ctrl) return "toggling";
  if (mods.shift) return "range";
  return "replacing";
}

export type MediaSelectionDirection = "left" | "right" | "up" | "down";

/** Seams to features outside the panel (source preview tabs). */
export interface MediaPanelHooks {
  /** `selectMediaAsset` (replacing selection) / `openPreviewTab` (extending). */
  previewAsset?: (editor: Editor, asset: MediaAsset, replacingSelection: boolean) => void;
}

export const mediaPanelHooks: MediaPanelHooks = {};

interface PanelState {
  orderedIds: string[];
  columnCount: number;
  anchor: string | null;
  scrollTarget: ReturnType<typeof createSignal<string | null>>;
}

const states = new WeakMap<Editor, PanelState>();

function panelState(editor: Editor): PanelState {
  let state = states.get(editor);
  if (!state) {
    state = { orderedIds: [], columnCount: 1, anchor: null, scrollTarget: createSignal<string | null>(null) };
    states.set(editor, state);
  }
  return state;
}

// ---- grid state published by the view ----

/** `publishGridState`: the visible items in display order and the column count used by arrow navigation. */
export function setMediaPanelLayout(editor: Editor, orderedIds: readonly string[], columnCount: number): void {
  const state = panelState(editor);
  if (state.orderedIds.length !== orderedIds.length || state.orderedIds.some((id, i) => id !== orderedIds[i])) {
    state.orderedIds = [...orderedIds];
  }
  state.columnCount = Math.max(1, columnCount);
}

export function mediaPanelOrderedItemIds(editor: Editor): readonly string[] {
  return panelState(editor).orderedIds;
}

export function mediaPanelColumnCount(editor: Editor): number {
  return panelState(editor).columnCount;
}

export function mediaPanelSelectionAnchor(editor: Editor): string | null {
  return panelState(editor).anchor;
}

/** Reactive: the key the view should scroll into view, or null. */
export function mediaPanelScrollTarget(editor: Editor): string | null {
  return panelState(editor).scrollTarget[0]();
}

export function requestMediaPanelScroll(editor: Editor, key: string): void {
  panelState(editor).scrollTarget[1](key);
}

export function clearMediaPanelScrollTarget(editor: Editor): void {
  panelState(editor).scrollTarget[1](null);
}

// ---- keys ----

function isValidMediaPanelItemKey(editor: Editor, key: string): boolean {
  const folderId = mediaPanelFolderIdFromKey(key);
  if (folderId !== undefined) return folder(editor, folderId) !== undefined;
  const timelineId = mediaPanelTimelineIdFromKey(key);
  if (timelineId !== undefined) return timelineFor(editor, timelineId) !== undefined;
  return editor.mediaAsset(key) !== undefined;
}

/** Asset ids as-is; folders and timelines prefixed (`MediaPanelItemKey`). */
export function mediaPanelSelectedKeys(editor: Editor): Set<string> {
  const keys = new Set(editor.ui.selectedMediaAssetIds);
  for (const id of editor.ui.selectedFolderIds) keys.add(mediaPanelFolderKey(id));
  for (const id of editor.ui.selectedTimelineIds) keys.add(mediaPanelTimelineKey(id));
  return keys;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Splits keys into the three selection sets (dropping stale keys) and stores the anchor. */
export function applyMediaPanelSelection(editor: Editor, keys: ReadonlySet<string>, anchor: string | null): void {
  const assetIds = new Set<string>();
  const folderIds = new Set<string>();
  const timelineIds = new Set<string>();
  for (const key of keys) {
    const folderId = mediaPanelFolderIdFromKey(key);
    const timelineId = mediaPanelTimelineIdFromKey(key);
    if (folderId !== undefined) {
      if (folder(editor, folderId)) folderIds.add(folderId);
    } else if (timelineId !== undefined) {
      if (timelineFor(editor, timelineId)) timelineIds.add(timelineId);
    } else if (editor.mediaAsset(key)) {
      assetIds.add(key);
    }
  }
  if (!sameSet(editor.ui.selectedMediaAssetIds, assetIds)) editor.ui.selectedMediaAssetIds = assetIds;
  if (!sameSet(editor.ui.selectedFolderIds, folderIds)) editor.ui.selectedFolderIds = folderIds;
  if (!sameSet(editor.ui.selectedTimelineIds, timelineIds)) editor.ui.selectedTimelineIds = timelineIds;
  panelState(editor).anchor = anchor;
}

function selectionRange(editor: Editor, key: string): Set<string> | undefined {
  const state = panelState(editor);
  const { anchor, orderedIds } = state;
  if (anchor === null || !isValidMediaPanelItemKey(editor, anchor)) return undefined;
  const a = orderedIds.indexOf(anchor);
  const b = orderedIds.indexOf(key);
  if (a < 0 || b < 0) return undefined;
  return new Set(orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1));
}

/** Click / Ctrl-click / Shift-click semantics (`selectMediaPanelItem(_:mode:)`). */
export function selectMediaPanelItem(editor: Editor, key: string, mode: MediaPanelSelectionMode = "replacing"): void {
  if (!isValidMediaPanelItemKey(editor, key)) return;
  let selection = mediaPanelSelectedKeys(editor);
  let anchor = panelState(editor).anchor;
  switch (mode) {
    case "replacing":
      selection = new Set([key]);
      anchor = key;
      break;
    case "toggling":
      if (selection.has(key)) selection.delete(key);
      else selection.add(key);
      anchor = key;
      break;
    case "range":
    case "extendingRange": {
      const range = selectionRange(editor, key);
      if (range) {
        if (mode === "range") selection = range;
        else for (const k of range) selection.add(k);
      } else {
        selection = new Set([key]);
        anchor = key;
      }
      break;
    }
  }
  applyMediaPanelSelection(editor, selection, anchor);
  const asset = editor.mediaAsset(key);
  if (asset) mediaPanelHooks.previewAsset?.(editor, asset, mode === "replacing");
}

/** Keyboard navigation: replaces the selection and requests a scroll. */
export function selectMediaPanelItemAndReveal(editor: Editor, key: string): void {
  if (!isValidMediaPanelItemKey(editor, key)) return;
  requestMediaPanelScroll(editor, key);
  selectMediaPanelItem(editor, key, "replacing");
}

const directionStep: Record<MediaSelectionDirection, (columns: number) => number> = {
  left: () => -1,
  right: () => 1,
  up: (c) => -c,
  down: (c) => c,
};

/** Arrow keys: steps from the last selected item in display order, clamped; nothing selected starts at an end. */
export function moveMediaSelection(editor: Editor, direction: MediaSelectionDirection): void {
  const state = panelState(editor);
  const ordered = state.orderedIds;
  if (ordered.length === 0) return;
  const selected = mediaPanelSelectedKeys(editor);
  let anchorIndex = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (selected.has(ordered[i])) {
      anchorIndex = i;
      break;
    }
  }
  let next: string;
  if (anchorIndex >= 0) {
    const raw = anchorIndex + directionStep[direction](Math.max(1, state.columnCount));
    const target = Math.max(0, Math.min(ordered.length - 1, raw));
    if (target === anchorIndex) return;
    next = ordered[target];
  } else {
    next = direction === "left" || direction === "up" ? ordered[ordered.length - 1] : ordered[0];
  }
  selectMediaPanelItemAndReveal(editor, next);
}

export function selectAllMediaPanelItems(editor: Editor): void {
  const ordered = panelState(editor).orderedIds;
  applyMediaPanelSelection(editor, new Set(ordered), ordered.find((k) => isValidMediaPanelItemKey(editor, k)) ?? null);
}

export function clearMediaPanelSelection(editor: Editor): void {
  applyMediaPanelSelection(editor, new Set(), null);
}

/** After a marquee: re-anchor on the first selected item in display order if the anchor left the selection. */
export function pruneMediaPanelSelectionAnchor(editor: Editor): void {
  const selection = mediaPanelSelectedKeys(editor);
  const state = panelState(editor);
  if (state.anchor !== null && selection.has(state.anchor)) return;
  state.anchor = state.orderedIds.find((k) => selection.has(k)) ?? null;
}

// ---- mutations ----

/** Undoable ("New Folder"): creates, selects and reveals the folder. Returns its id. */
export function createMediaPanelFolder(editor: Editor, parentFolderId: string | undefined): string {
  return editor.perform("New Folder", () => {
    const id = createFolder(editor, "New Folder", parentFolderId);
    selectMediaPanelItemAndReveal(editor, mediaPanelFolderKey(id));
    return id;
  });
}

function deleteActionName(folderCount: number, assetCount: number, timelineCount: number): string {
  if (folderCount + assetCount + timelineCount !== 1) return "Delete Media Items";
  if (folderCount === 1) return "Delete Folder";
  if (timelineCount === 1) return "Delete Timeline";
  return "Delete Media";
}

/**
 * Deletes the selected folders, assets and timelines as one undo step. A `contextKey` outside the selection
 * becomes the selection first. At least one timeline always remains (refused ones raise a toast).
 */
export function deleteMediaPanelItems(editor: Editor, contextKey?: string): void {
  if (contextKey !== undefined && isValidMediaPanelItemKey(editor, contextKey) && !mediaPanelSelectedKeys(editor).has(contextKey)) {
    applyMediaPanelSelection(editor, new Set([contextKey]), contextKey);
  }
  const folderIds = new Set([...editor.ui.selectedFolderIds].filter((id) => folder(editor, id) !== undefined));
  const deletedFolderIds = folderIdsIncludingDescendants(editor, folderIds);
  const assetIds = new Set(
    [...editor.ui.selectedMediaAssetIds].filter((id) => {
      const asset = editor.mediaAsset(id);
      return asset !== undefined && (asset.folderId === undefined || !deletedFolderIds.has(asset.folderId));
    }),
  );
  const selectedTimelines = editor.doc.timelines.filter((t) => editor.ui.selectedTimelineIds.has(t.id));
  const timelineIds = selectedTimelines.slice(0, Math.max(0, editor.doc.timelines.length - 1)).map((t) => t.id);
  if (selectedTimelines.length > timelineIds.length) editor.refuseWithToast(cannotDeleteLastTimelineMessage);

  if (folderIds.size + assetIds.size + timelineIds.length === 0) return;
  editor.perform(deleteActionName(folderIds.size, assetIds.size, timelineIds.length), () => {
    if (folderIds.size > 0) deleteFolders(editor, folderIds);
    if (assetIds.size > 0) deleteMediaAssets(editor, assetIds);
    for (const id of timelineIds) deleteTimeline(editor, id);
  });
  pruneMediaPanelSelectionAnchor(editor);
}

// ---- drops and paste ----

/** Finder / Explorer drop and the Import dialog: mirrors folders, one "Import Media" undo step. */
export async function handlePanelFinderDrop(
  editor: Editor,
  paths: readonly string[],
  destFolderId: string | undefined,
  options?: ImportFinderOptions,
): Promise<MediaImportSummary | undefined> {
  if (paths.length === 0) return undefined;
  try {
    return await importFinderItems(editor, paths, destFolderId, options);
  } catch (error) {
    editor.refuseWithToast(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export interface ClipboardMedia {
  paths: readonly string[];
  /** Raw image bytes in preference order (png before tiff). */
  images: readonly { extension: string; data: Uint8Array }[];
}

/** File paths win over raw image bytes (Explorer items carry a bitmap preview next to the path). */
export async function handleClipboardPaste(
  editor: Editor,
  clipboard: ClipboardMedia,
  destFolderId: string | undefined,
  options?: ImportFinderOptions,
): Promise<void> {
  if (clipboard.paths.length > 0) {
    await handlePanelFinderDrop(editor, clipboard.paths, destFolderId, options);
    return;
  }
  for (const image of clipboard.images) {
    const asset = await importPastedImageData(editor, image.data, image.extension);
    if (!asset) continue;
    if (destFolderId !== undefined) moveAssetsToFolder(editor, new Set([asset.id]), destFolderId);
    return;
  }
}

/** Routes an in-panel drag payload onto a folder (undefined = Library root). Unknown ids are ignored. */
export function resolveTextDrop(editor: Editor, text: string, destFolderId: string | undefined): void {
  const payload = decodeMediaDrag(text);
  const assetIds = new Set(payload.assets.map((a) => a.id).filter((id) => editor.mediaAsset(id) !== undefined));
  const folderIds = new Set(payload.folderIds);
  const timelineIds = new Set(payload.timelineIds.filter((id) => timelineFor(editor, id) !== undefined));
  if (assetIds.size > 0) moveAssetsToFolder(editor, assetIds, destFolderId);
  if (folderIds.size > 0) moveFoldersToFolder(editor, folderIds, destFolderId);
  if (timelineIds.size > 0) moveTimelinesToFolder(editor, timelineIds, destFolderId);
}
