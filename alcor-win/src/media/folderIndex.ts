import type { MediaFolder } from "../model";

/** Cached lookup tables for folder path and descendant traversal (`MediaFolderIndex`). */
export interface MediaFolderIndex {
  byId: Map<string, MediaFolder>;
  childrenByParent: Map<string | undefined, MediaFolder[]>;
}

export function makeMediaFolderIndex(folders: readonly MediaFolder[]): MediaFolderIndex {
  const byId = new Map<string, MediaFolder>();
  const childrenByParent = new Map<string | undefined, MediaFolder[]>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
    const siblings = childrenByParent.get(folder.parentFolderId);
    if (siblings) siblings.push(folder);
    else childrenByParent.set(folder.parentFolderId, [folder]);
  }
  return { byId, childrenByParent };
}

export function mediaFolderIndexFolder(index: MediaFolderIndex, id: string): MediaFolder | undefined {
  return index.byId.get(id);
}

/** Root-to-target chain; terminates on cyclic parents. */
export function mediaFolderIndexPath(index: MediaFolderIndex, folderId: string | undefined): MediaFolder[] {
  const path: MediaFolder[] = [];
  const visited = new Set<string>();
  let current = folderId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const folder = index.byId.get(current);
    if (!folder) break;
    path.push(folder);
    current = folder.parentFolderId;
  }
  return path.reverse();
}

export function mediaFolderIndexIsDescendant(index: MediaFolderIndex, folderId: string, ancestorId: string): boolean {
  const visited = new Set<string>();
  let current: string | undefined = folderId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    if (current === ancestorId) return true;
    current = index.byId.get(current)?.parentFolderId;
  }
  return false;
}

export function mediaFolderIndexIdsIncludingDescendants(index: MediaFolderIndex, ids: ReadonlySet<string>): Set<string> {
  const all = new Set(ids);
  for (const id of ids) collectDescendantIds(index, id, all);
  return all;
}

function collectDescendantIds(index: MediaFolderIndex, folderId: string, ids: Set<string>): void {
  for (const child of index.childrenByParent.get(folderId) ?? []) {
    if (ids.has(child.id)) continue;
    ids.add(child.id);
    collectDescendantIds(index, child.id, ids);
  }
}
