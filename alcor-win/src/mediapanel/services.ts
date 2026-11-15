import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Editor } from "../editor/editor";
import { handlePanelFinderDrop } from "../editor/mutations/mediaPanel";

/** OS integration of the panel; replaceable so the dev page runs without Tauri. */
export interface MediaPanelServices {
  /** Native multi-file dialog; null when cancelled. */
  pickMediaFiles(): Promise<string[] | null>;
  pickFolder(): Promise<string | null>;
  pickRelinkFile(assetName: string): Promise<string | null>;
  revealInExplorer(paths: string[]): Promise<void>;
  copyText(text: string): Promise<void>;
  importPaths(editor: Editor, paths: readonly string[], folderId: string | undefined): Promise<void>;
}

/** Extensions `clipTypeFromFileExtension` accepts. */
const mediaExtensions = [
  "mov", "mp4", "m4v", "mp3", "wav", "aac", "m4a", "aiff", "aif", "aifc", "caf", "flac",
  "png", "jpg", "jpeg", "tiff", "heic", "webp", "json", "lottie", "srt", "vtt",
];

function asPaths(selected: string | string[] | null): string[] | null {
  if (selected === null) return null;
  return Array.isArray(selected) ? selected : [selected];
}

export const tauriMediaPanelServices: MediaPanelServices = {
  async pickMediaFiles() {
    if (!isTauri()) return null;
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Select media files to import",
      filters: [{ name: "Media", extensions: mediaExtensions }],
    });
    return asPaths(selected);
  },
  async pickFolder() {
    if (!isTauri()) return null;
    const selected = await open({ multiple: false, directory: true, title: "Select a folder to import" });
    return asPaths(selected)?.[0] ?? null;
  },
  async pickRelinkFile(assetName) {
    if (!isTauri()) return null;
    const selected = await open({ multiple: false, directory: false, title: `Choose the source file for "${assetName}"` });
    return asPaths(selected)?.[0] ?? null;
  },
  async revealInExplorer(paths) {
    if (isTauri() && paths.length > 0) await revealItemInDir(paths);
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async importPaths(editor, paths, folderId) {
    await handlePanelFinderDrop(editor, paths, folderId);
  },
};
