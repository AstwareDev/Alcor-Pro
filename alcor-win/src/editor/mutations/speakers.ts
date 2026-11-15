import type { SpeakerRegistryEntry } from "../../model/projectFile";
import type { Editor } from "../editor";

/** Port of EditorViewModel+Speakers (rename / colour / remove). Registry edits are not undoable, like the Swift. */
export const speakerPalette: readonly string[] = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#40c8e0", "#ffd60a", "#5e5ce6"];

export function speakerCssColor(rgba: readonly number[]): string {
  if (rgba.length !== 4) return speakerPalette[0] as string;
  return `rgb(${rgba.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, c as number)) * 255)).join(" ")} / ${rgba[3]})`;
}

export function speakerHex(rgba: readonly number[]): string {
  const c = rgba.length === 4 ? rgba : [0.04, 0.52, 1, 1];
  return `#${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v as number)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgba(hex: string): number[] | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return undefined;
  return [parseInt(m[1] as string, 16) / 255, parseInt(m[2] as string, 16) / 255, parseInt(m[3] as string, 16) / 255, 1];
}

function update(editor: Editor, id: number, change: (entry: SpeakerRegistryEntry) => void): boolean {
  if (!editor.doc.speakerRegistry.some((s) => s.id === id)) return false;
  editor.withoutRegistration(() => {
    const entry = editor.doc.speakerRegistry.find((s) => s.id === id);
    if (entry) change(entry);
  });
  return true;
}

export function renameSpeaker(editor: Editor, id: number, name: string): boolean {
  return update(editor, id, (s) => {
    s.name = name;
  });
}

export function setSpeakerColor(editor: Editor, id: number, rgba: number[]): boolean {
  return update(editor, id, (s) => {
    s.color = rgba;
  });
}

/** Deletes the label; Identify recreates it if the voice is still present. */
export function removeSpeaker(editor: Editor, id: number): boolean {
  if (!editor.doc.speakerRegistry.some((s) => s.id === id)) return false;
  editor.withoutRegistration(() => {
    editor.doc.speakerRegistry = editor.doc.speakerRegistry.filter((s) => s.id !== id);
  });
  return true;
}
