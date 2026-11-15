// App-level dead-air wiring: the `markDeadAir` / `silenceRemovalSettings` state (EditorViewModel), the shared speech-mask
// store (MediaVisualCache.speech) and the production `DeadAirServices`. Voice activity (and with it onnxruntime and
// the model download) is only touched when a mask is first requested for an asset that has audio.
import { createSignal } from "solid-js";
import type { Clip, MediaAsset } from "../model";
import type { Editor } from "../editor/editor";
import { emitVisualReady } from "../media/visualEvents";
import { getWaveform, peekWaveform } from "../media/waveform";
import { setDeadAirRangesProvider } from "../timeline/view/clipRenderer";
import { DeadAirMaskCache, deadAirSourceRanges, type DeadAirServices } from "./deadAir";
import {
  defaultSilenceRemovalSettings, makeSilenceRemovalSettings, type SilenceRemovalSettings, type SourceRange,
} from "./silenceRemovalSettings";
import { SpeechMaskStore } from "./speechMaskStore";

const markKey = "markDeadAir";

function storedMarkDeadAir(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(markKey);
    return v === null || v === undefined ? true : v === "true";
  } catch {
    return true;
  }
}

const [markDeadAirSignal, setMarkDeadAirSignal] = createSignal(storedMarkDeadAir());
const [settingsSignal, setSettingsSignal] = createSignal<SilenceRemovalSettings>(defaultSilenceRemovalSettings);

/** Reactive: timeline washes are drawn on audio clips while on (default on). */
export const markDeadAir = markDeadAirSignal;
export function setMarkDeadAir(on: boolean): void {
  setMarkDeadAirSignal(on);
  try {
    globalThis.localStorage?.setItem(markKey, String(on));
  } catch {
    // persistence is best effort
  }
  emitVisualReady({ kind: "waveform", path: "" });
}

/** Current Minimum Pause / Speech Padding controls. */
export const silenceRemovalSettings = settingsSignal;
export function setMinimumSilenceDuration(seconds: number): void {
  const next = makeSilenceRemovalSettings(seconds, settingsSignal().speechPaddingSeconds);
  if (next) applySettings(next);
}
export function setSpeechPaddingDuration(seconds: number): void {
  const next = makeSilenceRemovalSettings(settingsSignal().minimumPauseSeconds, seconds);
  if (next) applySettings(next);
}
function applySettings(next: SilenceRemovalSettings): void {
  setSettingsSignal(next);
  emitVisualReady({ kind: "waveform", path: "" });
}

const maskCache = new DeadAirMaskCache();

export const speechMaskStore = new SpeechMaskStore(async (url, mediaRef) => {
  const [{ voiceActivityAnalysis }, { sharedSileroEngine }] = await Promise.all([
    import("./voiceActivityFile"),
    import("./sileroEngine"),
  ]);
  return voiceActivityAnalysis(url, mediaRef, sharedSileroEngine());
});
speechMaskStore.onMaskReady = (_ref, url) => {
  maskCache.reset();
  emitVisualReady({ kind: "waveform", path: url });
};

function hasAudio(asset: MediaAsset): boolean {
  return asset.type === "audio" || (asset.type === "video" && asset.hasAudio);
}

function samplesFor(asset: MediaAsset): Float32Array | undefined {
  const samples = peekWaveform(asset.url);
  if (!samples) void getWaveform(asset.url).catch(() => null);
  return samples;
}

export const deadAirServices: DeadAirServices = {
  maskCache,
  quietNonSpeechMask(editor, mediaRef) {
    const asset = editor.mediaAsset(mediaRef);
    if (!asset || !hasAudio(asset)) return undefined;
    speechMaskStore.generate(asset);
    return speechMaskStore.quietNonSpeechMask(mediaRef, samplesFor(asset));
  },
  deadAirMask(editor, mediaRef, settings) {
    const asset = editor.mediaAsset(mediaRef);
    if (!asset || !hasAudio(asset)) return undefined;
    speechMaskStore.generate(asset);
    return speechMaskStore.deadAirMask(mediaRef, samplesFor(asset), settings);
  },
};

/** Clears derived masks (multicam group edits, cleared caches). */
export function resetDeadAirMasks(): void {
  maskCache.reset();
}

/**
 * Starts speech analysis and waveform loading for the given media and waits for them (capped), so agent calls see
 * masks instead of "analysis still running". Failures and timeouts just leave the masks absent.
 */
export async function prepareDeadAirMasks(editor: Editor, mediaRefs: Iterable<string>, timeoutMs = 120_000): Promise<void> {
  const waits: Promise<unknown>[] = [];
  for (const ref of new Set(mediaRefs)) {
    const asset = editor.mediaAsset(ref);
    if (!asset || !hasAudio(asset)) continue;
    speechMaskStore.generate(asset);
    waits.push(getWaveform(asset.url).catch(() => null));
    waits.push(speechMaskStore.settled(ref));
  }
  if (waits.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(waits), timeout]);
  clearTimeout(timer);
}

/** Media references whose masks matter for these clips (multicam members count every mic). */
export function maskMediaRefs(editor: Editor, clips: readonly Clip[]): string[] {
  const refs: string[] = [];
  for (const clip of clips) {
    if (clip.mediaType !== "audio") continue;
    const group = clip.multicamGroupId === undefined ? undefined : editor.doc.multicamGroups.find((g) => g.id === clip.multicamGroupId);
    if (group) refs.push(...group.members.map((m) => m.mediaRef));
    else refs.push(clip.mediaRef);
  }
  return refs;
}

/** Installs the timeline wash for `editor`; returns the uninstall function. */
export function installDeadAirWash(editor: Editor): () => void {
  const provider = (clip: Clip): readonly SourceRange[] => {
    if (clip.mediaType !== "audio" || !markDeadAirSignal()) return [];
    return deadAirSourceRanges(editor, clip, settingsSignal(), deadAirServices);
  };
  setDeadAirRangesProvider(provider);
  return () => setDeadAirRangesProvider(undefined);
}
