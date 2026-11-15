import { convertFileSrc } from "@tauri-apps/api/core";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Local path to an asset-protocol URL (range-request capable); returned unchanged outside Tauri. */
export function mediaUrl(path: string): string {
  return isTauriRuntime() ? convertFileSrc(path) : path;
}
