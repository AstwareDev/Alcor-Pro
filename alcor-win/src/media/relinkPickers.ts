import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Native "choose the source file" dialog; null when cancelled or outside Tauri. */
export async function pickRelinkSourceFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ multiple: false, directory: false, title: "Choose the source file for this clip" });
  return typeof selected === "string" ? selected : null;
}

/** Native "choose the folder that holds your media" dialog; null when cancelled or outside Tauri. */
export async function pickRelinkSourceFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ multiple: false, directory: true, title: "Choose the folder that holds your media" });
  return typeof selected === "string" ? selected : null;
}
