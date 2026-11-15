import { makeMediaFolder, type MediaAsset, type MediaFolder } from "../model";
import type { Editor } from "../editor/editor";
import {
  makeMediaFolderIndex, mediaFolderIndexFolder, mediaFolderIndexIdsIncludingDescendants, mediaFolderIndexIsDescendant,
  mediaFolderIndexPath,
} from "./folderIndex";
import {
  flushPendingManifestMetadataUpdates, removeClipsReferencingAssets, setAssetFolderId,
} from "./libraryCore";
import { mediaHooks } from "./mediaHooks";

// ---- reads ----

export function folders(editor: Editor): readonly MediaFolder[] {
  return editor.doc.mediaManifest.folders;
}

export function folder(editor: Editor, id: string): MediaFolder | undefined {
  return editor.doc.mediaManifest.folders.find((f) => f.id === id);
}

const nameCompare = new Intl.Collator(undefined, { sensitivity: "accent" });

/** Immediate children, sorted like `localizedCaseInsensitiveCompare`. */
export function subfolders(editor: Editor, parentFolderId: string | undefined): MediaFolder[] {
  return editor.doc.mediaManifest.folders
    .filter((f) => f.parentFolderId === parentFolderId)
    .sort((a, b) => nameCompare.compare(a.name, b.name));
}

export function assetsIn(editor: Editor, folderId: string | undefined): MediaAsset[] {
  return editor.mediaAssets.filter((a) => a.folderId === folderId);
}

export function folderPath(editor: Editor, folderId: string | undefined): MediaFolder[] {
  return mediaFolderIndexPath(makeMediaFolderIndex(editor.doc.mediaManifest.folders), folderId);
}

export function folderIdsIncludingDescendants(editor: Editor, ids: ReadonlySet<string>): Set<string> {
  return mediaFolderIndexIdsIncludingDescendants(makeMediaFolderIndex(editor.doc.mediaManifest.folders), ids);
}

// ---- mutations ----

/** Undoable ("New Folder"). Returns the new folder's id. */
export function createFolder(editor: Editor, name: string, parentFolderId?: string): string {
  const created = makeMediaFolder({ name, parentFolderId });
  editor.perform("New Folder", () => {
    editor.doc.mediaManifest.folders.push(created);
  });
  return created.id;
}

/** Undoable ("Rename Folder"); unknown ids and unchanged names do nothing. */
export function renameFolder(editor: Editor, id: string, name: string): void {
  editor.perform("Rename Folder", () => {
    const target = editor.doc.mediaManifest.folders.find((f) => f.id === id);
    if (!target || target.name === name) return;
    target.name = name;
  });
}

/**
 * Undoable ("Delete Folder"): deletes the folders and all descendants, the assets inside them and every clip
 * referencing those assets. Timelines are reparented to the root, never deleted.
 */
export function deleteFolders(editor: Editor, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  flushPendingManifestMetadataUpdates(editor);
  const allFolderIds = mediaFolderIndexIdsIncludingDescendants(makeMediaFolderIndex(editor.doc.mediaManifest.folders), ids);
  if (!editor.doc.mediaManifest.folders.some((f) => allFolderIds.has(f.id))) return;

  const assetIdsToDelete = new Set(
    editor.mediaAssets.filter((a) => a.folderId !== undefined && allFolderIds.has(a.folderId)).map((a) => a.id),
  );
  let removedClips = false;
  editor.perform("Delete Folder", () => {
    removedClips = removeClipsReferencingAssets(editor, assetIdsToDelete).size > 0;
    for (const timeline of editor.doc.timelines) {
      if (timeline.folderId !== undefined && allFolderIds.has(timeline.folderId)) delete timeline.folderId;
    }
    const doc = editor.doc;
    doc.mediaAssets = doc.mediaAssets.filter((a) => !assetIdsToDelete.has(a.id));
    doc.mediaManifest.entries = doc.mediaManifest.entries.filter((e) => !assetIdsToDelete.has(e.id));
    doc.mediaManifest.folders = doc.mediaManifest.folders.filter((f) => !allFolderIds.has(f.id));
  });
  editor.ui.selectedFolderIds = new Set([...editor.ui.selectedFolderIds].filter((id) => !allFolderIds.has(id)));
  editor.ui.selectedMediaAssetIds = new Set(
    [...editor.ui.selectedMediaAssetIds].filter((id) => !assetIdsToDelete.has(id)),
  );
  if (assetIdsToDelete.size > 0) mediaHooks.closeAssetPreviewTabs?.(assetIdsToDelete);
  if (removedClips) mediaHooks.timelineChanged?.();
}

/** Undoable ("Move to Folder"). Timelines already in `folderId` are skipped. */
export function moveTimelinesToFolder(editor: Editor, timelineIds: ReadonlySet<string>, folderId: string | undefined): void {
  if (timelineIds.size === 0) return;
  editor.perform("Move to Folder", () => {
    for (const timeline of editor.doc.timelines) {
      if (!timelineIds.has(timeline.id) || timeline.folderId === folderId) continue;
      if (folderId === undefined) delete timeline.folderId;
      else timeline.folderId = folderId;
    }
  });
}

/** Undoable ("Move to Folder"): updates both the assets and their manifest entries. */
export function moveAssetsToFolder(editor: Editor, assetIds: ReadonlySet<string>, folderId: string | undefined): void {
  if (assetIds.size === 0) return;
  editor.perform("Move to Folder", () => {
    for (const id of assetIds) {
      const asset = editor.doc.mediaAssets.find((a) => a.id === id);
      if (!asset || asset.folderId === folderId) continue;
      setAssetFolderId(editor, id, folderId);
    }
  });
}

/** Undoable ("Move Folder"). Moves into a folder's own subtree, or onto itself, are ignored. */
export function moveFoldersToFolder(editor: Editor, folderIds: ReadonlySet<string>, parentFolderId: string | undefined): void {
  if (folderIds.size === 0) return;
  editor.perform("Move Folder", () => {
    const index = makeMediaFolderIndex(editor.doc.mediaManifest.folders);
    for (const id of folderIds) {
      const existing = mediaFolderIndexFolder(index, id);
      if (!existing || existing.parentFolderId === parentFolderId) continue;
      if (parentFolderId !== undefined && mediaFolderIndexIsDescendant(index, parentFolderId, id)) continue;
      if (id === parentFolderId) continue;
      const target = editor.doc.mediaManifest.folders.find((f) => f.id === id);
      if (!target) continue;
      if (parentFolderId === undefined) delete target.parentFolderId;
      else target.parentFolderId = parentFolderId;
    }
  });
}
