// Port of TimelineView+BeatsMenu.swift and the beat items of TimelineView.menu(for:).
import type { Editor } from "../editor/editor";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { beatStore, markBeats, setMarkBeats } from "./beatState";

export function detectBeatsToast(analysis: { bpm: number; beats: readonly number[]; downbeats: readonly number[] }): { message: string; kind: "info" } {
  if (analysis.beats.length === 0 && analysis.downbeats.length === 0) return { message: "No beats detected.", kind: "info" };
  const count = Math.max(analysis.beats.length, analysis.downbeats.length);
  return {
    message: analysis.bpm > 0 ? `Detected ${count} beats at ${Math.round(analysis.bpm)} BPM.` : `Detected ${count} beats.`,
    kind: "info",
  };
}

/** `performDetectBeats`: forces a redetect when beats already exist, turns marking on, toasts the outcome. */
export async function performDetectBeats(editor: Editor, mediaRef: string): Promise<void> {
  const asset = editor.mediaAsset(mediaRef);
  if (!asset) return;
  const force = beatStore.analysis(mediaRef) !== undefined;
  setMarkBeats(true);
  try {
    const analysis = await beatStore.detect(asset, force);
    const toast = detectBeatsToast(analysis);
    editor.showToast(toast.message, toast.kind);
  } catch {
    editor.showToast("Beat detection failed. Check that the media file is reachable, then retry.", "error");
  }
}

/** Menu items for a clip's media, or none when the clip has no analyzable audio. */
export function beatMenuItems(editor: Editor, clipId: string): ContextMenuItem[] {
  const clip = editor.clipFor(clipId);
  if (!clip || clip.sourceClipType === "sequence") return [];
  const asset = editor.mediaAsset(clip.mediaRef);
  if (!asset || !(asset.type === "audio" || (asset.type === "video" && asset.hasAudio))) return [];
  const hasBeats = beatStore.analysis(clip.mediaRef) !== undefined;
  const items: ContextMenuItem[] = [
    { kind: "item", label: hasBeats ? "Redetect Beats" : "Detect Beats", onSelect: () => void performDetectBeats(editor, clip.mediaRef) },
  ];
  if (hasBeats) items.push({ kind: "item", label: "Mark Beats", checked: markBeats(), onSelect: () => setMarkBeats(!markBeats()) });
  return items;
}

/** `clipMenuSectionProviders` entry for the editor: register with `clipMenuSectionProviders.push(beatClipMenuProvider(editor))`. */
export function beatClipMenuProvider(editor: Editor): (clipId: string) => ContextMenuItem[] {
  return (clipId) => beatMenuItems(editor, clipId);
}
