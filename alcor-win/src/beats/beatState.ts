import { createSignal } from "solid-js";
import { BeatStore } from "./beatStore";

/** App-wide beat analyses by mediaRef (the Swift `mediaVisualCache.beats`). */
export const beatStore = new BeatStore();

const markKey = "markBeats";

function readMarkBeats(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(markKey);
    return v === null || v === undefined ? true : v === "true";
  } catch {
    return true;
  }
}

const [markBeatsSignal, setMarkBeatsSignal] = createSignal(readMarkBeats());

/** `EditorViewModel.markBeats` (persisted, default on). */
export const markBeats = markBeatsSignal;

export function setMarkBeats(value: boolean): void {
  setMarkBeatsSignal(value);
  try {
    globalThis.localStorage?.setItem(markKey, String(value));
  } catch {
    // persistence is best effort, like UserDefaults
  }
}

const listeners = new Set<() => void>();

beatStore.onBeatsReady = () => {
  for (const l of listeners) l();
};

/** Redraw hook for the timeline canvas; returns the unsubscribe function. */
export function onBeatsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
