import type { Editor } from "../../editor/editor";
import { timelineFor } from "../../editor/mutations/core";
import { deleteTimeline, renameTimeline } from "../../editor/mutations/timelines";
import { createFolder, deleteFolders, folders, moveAssetsToFolder, moveFoldersToFolder, moveTimelinesToFolder, renameFolder } from "../../media/folders";
import { deleteMediaAssets, renameMediaAsset } from "../../media/mediaLibrary";
import type { MediaAsset } from "../../model";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { folderPathString } from "./timelinePayload";
import { jsonString } from "./jsonFormat";
import { ToolError, argString, argStringArray, isRecord, requireString, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Organize.swift. Folders use paths ("Hero shots/Takes"), not ids. Paths resolve
// case-insensitively; creating missing segments.

const caseInsensitiveEqual = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const nameCompare = new Intl.Collator(undefined, { sensitivity: "accent" });

// MARK: - Folder path helpers (shared by organize_media, get_media, import, generate)

export function allFolderPaths(editor: Editor): string[] {
  return folders(editor)
    .flatMap((f) => {
      const p = folderPathString(editor, f.id);
      return p === undefined ? [] : [p];
    })
    .sort((a, b) => nameCompare.compare(a, b));
}

function folderListForError(editor: Editor): string {
  const paths = allFolderPaths(editor);
  return paths.length === 0 ? "(none yet)" : paths.join(", ");
}

function folderSegments(path: string): string[] {
  // Swift `split(separator:)` drops empty subsequences, then each segment is trimmed.
  const segments = path.split("/").filter((s) => s !== "").map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s === "")) {
    throw new ToolError(`Invalid folder path '${path}'. Use segment names joined by '/', e.g. 'B-roll/Sunset'.`);
  }
  return segments;
}

function childFolder(editor: Editor, name: string, parent: string | undefined, path: string): string | undefined {
  const matches = folders(editor).filter((f) => f.parentFolderId === parent && caseInsensitiveEqual(f.name, name));
  if (matches.length > 1) {
    const exact = matches.find((f) => f.name === name);
    if (exact) return exact.id;
    throw new ToolError(`Folder path '${path}' is ambiguous at '${name}' (${matches.length} matches). Rename one of the duplicates first.`);
  }
  return matches[0]?.id;
}

function resolveFolderSegments(editor: Editor, path: string): string | undefined {
  let parent: string | undefined;
  for (const segment of folderSegments(path)) {
    const next = childFolder(editor, segment, parent, path);
    if (next === undefined) return undefined;
    parent = next;
  }
  return parent;
}

/** Strict resolve; throws with the current folder list when the path doesn't match. */
export function folderIdAtPath(editor: Editor, path: string): string {
  const id = resolveFolderSegments(editor, path);
  if (id === undefined) throw new ToolError(`Folder not found: '${path}'. Folders: ${folderListForError(editor)}`);
  return id;
}

/** Resolves path, creating missing folders. Returns id and created paths. */
export function resolveOrCreateFolder(editor: Editor, path: string): { id: string; created: string[] } {
  const segments = folderSegments(path);
  let parent: string | undefined;
  const walked: string[] = [];
  const created: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    const existing = childFolder(editor, segment, parent, path);
    if (existing !== undefined) {
      parent = existing;
    } else {
      parent = createFolder(editor, segment, parent);
      created.push(walked.join("/"));
    }
  }
  return { id: parent as string, created };
}

/** Gets 'folder' arg as a path, creating as needed. Defaults to last reference asset's folder. */
export function resolveFolder(editor: Editor, args: ToolArgs, fallbackReferences: readonly MediaAsset[] = []): string | undefined {
  const path = argString(args, "folder");
  if (path !== undefined) return resolveOrCreateFolder(editor, path).id;
  return fallbackReferences[fallbackReferences.length - 1]?.folderId;
}

// MARK: - organize_media

type LibraryItem = { kind: "asset"; id: string } | { kind: "timeline"; id: string } | { kind: "folder"; id: string; path: string };

interface OrganizeMove {
  items: LibraryItem[];
  intoPath?: string;
}

interface OrganizeRename {
  item: LibraryItem;
  name: string;
}

function libraryItem(editor: Editor, ref: string, path: string): LibraryItem {
  if (editor.mediaAssets.some((a) => a.id === ref)) return { kind: "asset", id: ref };
  if (timelineFor(editor, ref)) return { kind: "timeline", id: ref };
  let id: string | undefined;
  try {
    id = resolveFolderSegments(editor, ref);
  } catch {
    id = undefined;
  }
  if (id !== undefined) return { kind: "folder", id, path: ref };
  throw new ToolError(`${path}: '${ref}' is not an asset id, timeline id, or folder path. Folders: ${folderListForError(editor)}`);
}

function organizeEntries(args: ToolArgs, key: string): Record<string, unknown>[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError(`'${key}' must be a non-empty array`);
  return raw.map((entry, idx) => {
    if (!isRecord(entry)) throw new ToolError(`${key}[${idx}] must be an object`);
    return entry;
  });
}

function parseMoves(editor: Editor, args: ToolArgs): OrganizeMove[] {
  return (organizeEntries(args, "moves") ?? []).map((entry, idx) => {
    const path = `moves[${idx}]`;
    validateUnknownKeys(entry, ["items", "into"], path);
    const refs = argStringArray(entry, "items");
    if (refs.length === 0) throw new ToolError(`${path}: items is required`);
    const items = refs.map((ref) => libraryItem(editor, ref, path));
    const intoPath = argString(entry, "into");
    // Cycle check by path, at parse time — before any folder gets created.
    if (intoPath !== undefined) {
      const intoSegments = folderSegments(intoPath).map((s) => s.toLowerCase());
      for (const item of items) {
        if (item.kind !== "folder") continue;
        const current = (folderPathString(editor, item.id) ?? item.path)
          .split("/")
          .filter((s) => s !== "")
          .map((s) => s.trim().toLowerCase());
        if (current.every((seg, i) => intoSegments[i] === seg)) {
          throw new ToolError(`Can't move folder '${item.path}' into itself or its own subfolder.`);
        }
      }
    }
    return { items, ...(intoPath !== undefined ? { intoPath } : {}) };
  });
}

function parseRenames(editor: Editor, args: ToolArgs): OrganizeRename[] {
  return (organizeEntries(args, "renames") ?? []).map((entry, idx) => {
    const path = `renames[${idx}]`;
    validateUnknownKeys(entry, ["item", "name"], path);
    const ref = requireString(entry, "item");
    const name = requireString(entry, "name");
    return { item: libraryItem(editor, ref, path), name };
  });
}

function totalClipCount(editor: Editor): number {
  return editor.timelines.reduce((sum, t) => sum + t.tracks.reduce((s, tr) => s + tr.clips.length, 0), 0);
}

export function organizeMedia({ editor }: ToolContext, args: ToolArgs): ToolResult {
  validateUnknownKeys(args, ["createFolders", "moves", "renames", "deletes"], "organize_media");

  const createPaths = argStringArray(args, "createFolders");
  const moves = parseMoves(editor, args);
  const renames = parseRenames(editor, args);
  const deletes = argStringArray(args, "deletes").map((ref) => libraryItem(editor, ref, "deletes"));
  if (createPaths.length === 0 && moves.length === 0 && renames.length === 0 && deletes.length === 0) {
    throw new ToolError("Nothing to do — pass at least one of createFolders, moves, renames, deletes.");
  }

  const assetIds = new Set<string>();
  const timelineIds = new Set<string>();
  const folderIds = new Set<string>();
  for (const item of deletes) {
    if (item.kind === "asset") assetIds.add(item.id);
    else if (item.kind === "timeline") timelineIds.add(item.id);
    else folderIds.add(item.id);
  }
  if (!(timelineIds.size < editor.timelines.length)) throw new ToolError("Can't delete every timeline — the project needs at least one.");
  // Validate every folder path (syntax + ambiguity) before mutating anything.
  for (const path of [...createPaths, ...moves.flatMap((m) => (m.intoPath === undefined ? [] : [m.intoPath]))]) {
    resolveFolderSegments(editor, path);
  }

  const createdFolders: string[] = [];
  let movedCount = 0;
  let clipsRemoved = 0;
  const warnings: string[] = [];
  const snapshot = timelineSnapshot(editor);
  const activeBefore = editor.doc.activeTimelineId;

  editor.perform("Organize Media", () => {
    for (const path of createPaths) createdFolders.push(...resolveOrCreateFolder(editor, path).created);

    for (const move of moves) {
      let destination: string | undefined;
      if (move.intoPath !== undefined) {
        const resolved = resolveOrCreateFolder(editor, move.intoPath);
        destination = resolved.id;
        createdFolders.push(...resolved.created);
      }
      const assets = new Set<string>();
      const timelines = new Set<string>();
      const folderSet = new Set<string>();
      for (const item of move.items) {
        if (item.kind === "asset") assets.add(item.id);
        else if (item.kind === "timeline") timelines.add(item.id);
        else folderSet.add(item.id);
      }
      moveAssetsToFolder(editor, assets, destination);
      moveTimelinesToFolder(editor, timelines, destination);
      moveFoldersToFolder(editor, folderSet, destination);
      movedCount += move.items.length;
    }

    for (const rename of renames) {
      if (rename.item.kind === "asset") renameMediaAsset(editor, rename.item.id, rename.name);
      else if (rename.item.kind === "timeline") renameTimeline(editor, rename.item.id, rename.name);
      else renameFolder(editor, rename.item.id, rename.name);
    }

    // Assets and folders first so the clip-count diff excludes deleted timelines' own clips.
    const clipsBefore = totalClipCount(editor);
    if (assetIds.size > 0) deleteMediaAssets(editor, assetIds);
    if (folderIds.size > 0) deleteFolders(editor, folderIds);
    clipsRemoved = clipsBefore - totalClipCount(editor);
    for (const id of timelineIds) deleteTimeline(editor, id);
  });

  if (timelineIds.size > 0) {
    const nestRefs = editor.timelines.flatMap((t) => t.tracks).flatMap((tr) => tr.clips).filter((c) => timelineIds.has(c.mediaRef)).length;
    if (nestRefs > 0) warnings.push(`${nestRefs} nest clip(s) still reference deleted timeline(s) and will render black.`);
  }

  const payload: Record<string, unknown> = {};
  if (createdFolders.length > 0) payload.createdFolders = createdFolders;
  if (movedCount > 0) payload.moved = movedCount;
  if (renames.length > 0) payload.renamed = renames.length;
  if (deletes.length > 0) {
    const deleted: Record<string, number> = {};
    if (assetIds.size > 0) deleted.assets = assetIds.size;
    if (folderIds.size > 0) deleted.folders = folderIds.size;
    if (timelineIds.size > 0) deleted.timelines = timelineIds.size;
    payload.deleted = deleted;
  }
  if (clipsRemoved > 0) payload.clipsRemoved = clipsRemoved;
  if (warnings.length > 0) payload.warnings = warnings;
  if (editor.doc.activeTimelineId !== activeBefore) {
    payload.notes = ["Active timeline changed — re-read get_timeline."];
    return ok(jsonString(payload));
  }
  return mutationResult(editor, snapshot, { extra: payload });
}
