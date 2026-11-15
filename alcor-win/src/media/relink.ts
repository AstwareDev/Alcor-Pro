import type { Editor } from "../editor/editor";
import { clipTypeTrackLabel, mediaAssetToManifestEntry } from "../model";
import { mediaIo, type FsEntry } from "./io";
import { finalizeImportedAsset } from "./mediaLibrary";
import { isMediaOffline, refreshMissingMediaCache } from "./libraryCore";
import { mediaHooks } from "./mediaHooks";
import { clipTypeForPath } from "./mediaTypes";
import { lastPathComponent } from "./paths";
import { invalidateThumbnails } from "./thumbnails";
import { invalidateWaveform } from "./waveform";

/** Repoints one asset at a new source file, then re-validates it. Refused (toast) when the media type differs. */
export function relinkAsset(editor: Editor, id: string, newPath: string): void {
  const asset = editor.mediaAsset(id);
  if (!asset) return;
  const newType = clipTypeForPath(newPath);
  if (newType !== undefined && newType !== asset.type) {
    editor.showToast(
      `Can't relink "${lastPathComponent(newPath)}". Required media type: ${clipTypeTrackLabel(asset.type)}. Selected media type: ${clipTypeTrackLabel(newType)}.`,
      "error",
    );
    return;
  }
  applyRelink(editor, id, newPath);
}

export interface RelinkSummary {
  relinked: number;
  total: number;
}

/** Matches every offline asset to a same-named file (case-insensitive) under `folder`, recursively. First match wins. */
export async function relinkOfflineAssets(editor: Editor, folder: string): Promise<RelinkSummary> {
  const offline = editor.mediaAssets.filter((a) => isMediaOffline(editor, a.id));
  if (offline.length === 0) return { relinked: 0, total: 0 };
  const index = await fileIndex(folder);
  let relinked = 0;
  for (const asset of offline) {
    const match = index.get(lastPathComponent(asset.url).toLowerCase());
    if (match === undefined) continue;
    applyRelink(editor, asset.id, match);
    relinked += 1;
  }
  return { relinked, total: offline.length };
}

/** Not undoable, like the Swift. */
function applyRelink(editor: Editor, id: string, newPath: string): void {
  const oldPath = editor.mediaAsset(id)?.url;
  editor.withoutRegistration(() => {
    const asset = editor.doc.mediaAssets.find((a) => a.id === id);
    if (!asset) return;
    asset.url = newPath;
    const entry = editor.doc.mediaManifest.entries.find((e) => e.id === id);
    if (entry) entry.source = mediaAssetToManifestEntry(asset, editor.projectPath ?? undefined).source;
  });
  if (oldPath !== undefined) {
    invalidateThumbnails(oldPath);
    invalidateWaveform(oldPath);
  }
  mediaHooks.assetRelinked?.(id);
  void finalizeImportedAsset(editor, id);
  void refreshMissingMediaCache(editor);
}

/** Lowercased filename -> path for regular files under `folder`. */
async function fileIndex(folder: string): Promise<Map<string, string>> {
  const io = await mediaIo();
  const map = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    let entries: FsEntry[];
    try {
      entries = await io.list(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDir) await walk(entry.path);
      else {
        const key = entry.name.toLowerCase();
        if (!map.has(key)) map.set(key, entry.path);
      }
    }
  };
  await walk(folder);
  return map;
}
