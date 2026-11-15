// Session-scoped denoise bake state (EditorViewModel.denoiseInFlight / denoiseFailed / denoiseBaked and
// EditorViewModel+AudioEnhance.swift), keyed by mediaRef, plus the registry of baked wet files the mixers read.
import { createEffect, createRoot, createSignal, on, untrack } from "solid-js";
import type { Editor } from "../editor/editor";
import { clipDenoiseAmount, clipHasDenoiseEnabled, type Clip } from "../model";
import { sharedAudioEnhancer, type AudioEnhancer } from "./audioEnhancer";
import { isWetMediaRef, dryMediaRef } from "./denoiseMix";

type RefSet = ReadonlySet<string>;

function refSetSignal(): [() => RefSet, (update: (s: Set<string>) => void) => void] {
  const [get, set] = createSignal<RefSet>(new Set());
  return [get, (update) => set((prev) => {
    const next = new Set(prev);
    update(next);
    return next;
  })];
}

const [denoiseInFlightSet, updateInFlight] = refSetSignal();
const [denoiseFailedSet, updateFailed] = refSetSignal();
const [denoiseBakedSet, updateBaked] = refSetSignal();
const wetPaths = new Map<string, string>();
const starting = new Set<string>();

export const denoiseInFlight = denoiseInFlightSet;
export const denoiseFailed = denoiseFailedSet;
export const denoiseBaked = denoiseBakedSet;

/** Media refs that currently have a baked wet file (the `wetMediaRefs` option of the frame graph). */
export const wetMediaRefs = denoiseBakedSet;

export function wetPathFor(mediaRef: string): string | undefined {
  return wetPaths.get(dryMediaRef(mediaRef));
}

export { isWetMediaRef };

/** `denoiseFailed.remove` (called when denoise is enabled again). */
export function clearDenoiseFailure(mediaRef: string): void {
  updateFailed((s) => s.delete(mediaRef));
}

/** Relink: the source changed, forget everything known about it. */
export function forgetDenoise(mediaRef: string): void {
  updateFailed((s) => s.delete(mediaRef));
  updateBaked((s) => s.delete(mediaRef));
  wetPaths.delete(mediaRef);
}

/** `resetAnalysisSessionState` (after Settings clears disk caches). */
export function resetDenoiseSessionState(editor: Editor, enhancer: AudioEnhancer = sharedAudioEnhancer()): void {
  updateBaked((s) => s.clear());
  updateFailed((s) => s.clear());
  wetPaths.clear();
  enhancePendingDenoises(editor, enhancer);
}

export function enhancePendingDenoises(editor: Editor, enhancer: AudioEnhancer = sharedAudioEnhancer()): void {
  for (const track of editor.timeline.tracks) for (const clip of track.clips) if (clipHasDenoiseEnabled(clip)) enhanceAudioIfNeeded(editor, clip, enhancer);
}

/** Starts a background bake for the clip's source when it needs one. Resolves when the attempt finished (tests await it). */
export function enhanceAudioIfNeeded(editor: Editor, clip: Clip, enhancer: AudioEnhancer = sharedAudioEnhancer()): Promise<void> {
  const mediaRef = clip.mediaRef;
  const url = editor.mediaAsset(mediaRef)?.url;
  if (
    !clipHasDenoiseEnabled(clip) || !(clipDenoiseAmount(clip) > 0) || untrack(denoiseBakedSet).has(mediaRef) ||
    untrack(denoiseInFlightSet).has(mediaRef) || untrack(denoiseFailedSet).has(mediaRef) || starting.has(mediaRef) || url === undefined
  ) return Promise.resolve();
  starting.add(mediaRef);
  return (async () => {
    try {
      const cached = await enhancer.cachedDenoisedPath(url, mediaRef).catch(() => undefined);
      if (cached) {
        wetPaths.set(mediaRef, cached);
        updateBaked((s) => s.add(mediaRef));
        return;
      }
      updateInFlight((s) => s.add(mediaRef));
      try {
        wetPaths.set(mediaRef, await enhancer.denoisedAudio(url, mediaRef));
        updateBaked((s) => s.add(mediaRef));
      } catch (e) {
        console.error(`denoise bake failed mediaRef=${mediaRef}:`, e);
        updateFailed((s) => s.add(mediaRef));
      } finally {
        updateInFlight((s) => s.delete(mediaRef));
      }
    } finally {
      starting.delete(mediaRef);
    }
  })();
}

/** Bakes every denoise-enabled clip of `editor` before export; failures fall back to the original audio. */
export async function bakeDenoisesForExport(
  editor: Editor,
  clips: readonly Clip[],
  signal?: AbortSignal,
  enhancer: AudioEnhancer = sharedAudioEnhancer(),
): Promise<void> {
  for (const clip of clips) {
    if (!clipHasDenoiseEnabled(clip) || !(clipDenoiseAmount(clip) > 0)) continue;
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    const url = editor.mediaAsset(clip.mediaRef)?.url;
    if (url === undefined || editor.ui.missingMediaRefs.has(clip.mediaRef)) continue;
    try {
      wetPaths.set(clip.mediaRef, await enhancer.denoisedAudio(url, clip.mediaRef, signal));
      updateBaked((s) => s.add(clip.mediaRef));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      console.error(`denoise bake failed — exporting original audio. mediaRef=${clip.mediaRef}:`, e);
    }
  }
}

/** Keeps pending denoises baking as the document changes (`notifyTimelineChanged` + project open). Returns the disposer. */
export function watchDenoise(editor: Editor, enhancer: AudioEnhancer = sharedAudioEnhancer()): () => void {
  return createRoot((dispose) => {
    createEffect(on(() => editor.store.revision, () => enhancePendingDenoises(editor, enhancer)));
    return dispose;
  });
}
