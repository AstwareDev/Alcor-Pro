// Per-editor search index and the "editor is idle" gate that keeps background indexing out of playback and export.
import { createEffect, createRoot } from "solid-js";
import { abortError } from "../media/concurrency";
import type { Editor } from "../editor/editor";
import { sharedExportQueue } from "../export/exportQueue";
import { SearchIndexCoordinator } from "./searchIndex";
import { sharedVisualModel } from "./visualEmbedder";

/** Resolves when the editor is not playing, scrubbing or exporting. Event driven: no timers while it waits. */
export function createIdleGate(editor: Editor): (signal?: AbortSignal) => Promise<void> {
  const waiters = new Set<() => void>();
  const busy = (): boolean => editor.ui.isPlaying || editor.ui.isScrubbing || sharedExportQueue.isExportActive;
  const wake = (): void => {
    if (busy()) return;
    for (const w of [...waiters]) w();
  };
  createRoot(() => {
    createEffect(() => {
      void editor.ui.isPlaying;
      void editor.ui.isScrubbing;
      wake();
    });
  });
  sharedExportQueue.subscribe(wake);
  return (signal) => {
    if (!busy()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        waiters.delete(done);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        waiters.delete(done);
        reject(abortError());
      };
      waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

const indexes = new WeakMap<Editor, SearchIndexCoordinator>();

/** The editor's search index (`editor.searchIndex` in Swift), created on first use. */
export function searchIndexFor(editor: Editor): SearchIndexCoordinator {
  let index = indexes.get(editor);
  if (!index) {
    index = new SearchIndexCoordinator({
      model: sharedVisualModel(),
      assets: () => editor.mediaAssets,
      deps: { idle: createIdleGate(editor) },
    });
    indexes.set(editor, index);
  }
  return index;
}

/** Tests substitute a coordinator built with a fake model and embedder. */
export function setSearchIndexFor(editor: Editor, index: SearchIndexCoordinator | undefined): void {
  if (index) indexes.set(editor, index);
  else indexes.delete(editor);
}
