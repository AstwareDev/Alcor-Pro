import type { Clip } from "../model";
import { clipTimelineFrame } from "../model";
import { abortError, throwIfAborted } from "../media/concurrency";
import { sharedBeatDetector } from "./beatDetector";
import type { BeatAnalysis, BeatAnalysisCacheEntry } from "./beatInference";

/** Stores beats for each mediaRef. Avoids doing the same detection twice. (Port of BeatStore.swift.) */

/** Only what the store reads from a `MediaAsset`; `url` is re-read after every await so relinks are picked up. */
export interface BeatAsset {
  readonly id: string;
  readonly url: string;
}

export type CachedAnalysisLoader = (sourcePath: string, mediaRef: string) => Promise<BeatAnalysisCacheEntry | undefined>;
export type FileTagLoader = (sourcePath: string) => Promise<string>;
export type AnalysisRunner = (sourcePath: string, mediaRef: string, force: boolean, signal: AbortSignal) => Promise<BeatAnalysis>;

export interface BeatStoreLoaders {
  cachedAnalysisLoader: CachedAnalysisLoader;
  fileTagLoader: FileTagLoader;
  analysisRunner: AnalysisRunner;
}

const standardized = (path: string): string => path.replaceAll("\\", "/");

interface Running<T> {
  id: number;
  promise: Promise<T>;
  controller: AbortController;
}

export class BeatStore {
  private readonly analyses = new Map<string, BeatAnalysis>();
  private readonly fileTags = new Map<string, string>();
  private readonly tasks = new Map<string, Running<BeatAnalysis>>();
  private readonly hydrationTasks = new Map<string, Running<void>>();
  private nextId = 1;
  private readonly loaders: BeatStoreLoaders;

  onBeatsReady: (() => void) | undefined;

  constructor(loaders: Partial<BeatStoreLoaders> = {}) {
    const detector = sharedBeatDetector;
    this.loaders = {
      cachedAnalysisLoader: loaders.cachedAnalysisLoader ?? ((url, ref) => detector().cachedAnalysis(url, ref)),
      fileTagLoader: loaders.fileTagLoader ?? ((url) => detector().fileTag(url)),
      analysisRunner: loaders.analysisRunner ?? ((url, ref, force, signal) => detector().analysis(url, ref, force, signal)),
    };
  }

  analysis(mediaRef: string): BeatAnalysis | undefined {
    return this.analyses.get(mediaRef);
  }

  /** Restores a prior session's analysis from the disk cache; never runs detection. */
  hydrate(asset: BeatAsset): Promise<void> | undefined {
    const key = asset.id;
    if (this.analyses.has(key) || this.tasks.has(key)) return undefined;
    const existing = this.hydrationTasks.get(key);
    if (existing) return existing.promise;
    const id = this.nextId++;
    const controller = new AbortController();
    const url = standardized(asset.url);
    const promise = (async () => {
      const entry = await this.loaders.cachedAnalysisLoader(url, key);
      if (this.hydrationTasks.get(key)?.id !== id) return;
      this.hydrationTasks.delete(key);
      if (controller.signal.aborted) return;
      if (standardized(asset.url) !== url) {
        this.hydrate(asset);
        return;
      }
      if (this.tasks.has(key) || this.analyses.has(key) || !entry) return;
      this.analyses.set(key, entry.analysis);
      this.fileTags.set(key, entry.fileTag);
      this.onBeatsReady?.();
    })();
    this.hydrationTasks.set(key, { id, promise, controller });
    return promise;
  }

  detect(asset: BeatAsset, force = false): Promise<BeatAnalysis> {
    const key = asset.id;
    const hydration = this.hydrationTasks.get(key);
    if (hydration) {
      this.hydrationTasks.delete(key);
      hydration.controller.abort();
    }
    const running = this.tasks.get(key);
    if (!force && running) return running.promise;
    running?.controller.abort();
    const id = this.nextId++;
    const controller = new AbortController();
    const promise = this.analysisForCurrentSource(asset, force, controller.signal).finally(() => {
      if (this.tasks.get(key)?.id === id) this.tasks.delete(key);
    });
    promise.catch(() => undefined);
    this.tasks.set(key, { id, promise, controller });
    return promise;
  }

  private async analysisForCurrentSource(asset: BeatAsset, force: boolean, signal: AbortSignal): Promise<BeatAnalysis> {
    const key = asset.id;
    for (;;) {
      const url = standardized(asset.url);
      const tag = await this.loaders.fileTagLoader(url);
      throwIfAborted(signal);
      if (standardized(asset.url) !== url) continue;
      const existing = this.analyses.get(key);
      if (!force && existing && this.fileTags.get(key) === tag) return existing;

      const analysis = await this.loaders.analysisRunner(url, key, force, signal);
      throwIfAborted(signal);
      if (standardized(asset.url) !== url) continue;
      this.analyses.set(key, analysis);
      this.fileTags.set(key, tag);
      this.onBeatsReady?.();
      return analysis;
    }
  }

  reset(): void {
    for (const t of this.tasks.values()) t.controller.abort();
    for (const t of this.hydrationTasks.values()) t.controller.abort();
    this.tasks.clear();
    this.hydrationTasks.clear();
    this.analyses.clear();
    this.fileTags.clear();
  }

  invalidate(mediaRef: string): void {
    this.tasks.get(mediaRef)?.controller.abort();
    this.tasks.delete(mediaRef);
    this.hydrationTasks.get(mediaRef)?.controller.abort();
    this.hydrationTasks.delete(mediaRef);
    this.analyses.delete(mediaRef);
    this.fileTags.delete(mediaRef);
  }
}

/** `EditorViewModel.beatSnapFrames(for:)`: timeline frames of every beat and downbeat inside the clip. */
export function beatSnapFrames(
  clip: Clip,
  fps: number,
  markBeats: boolean,
  analysisFor: (mediaRef: string) => BeatAnalysis | undefined,
): number[] {
  if (!markBeats || clip.sourceClipType === "sequence") return [];
  const analysis = analysisFor(clip.mediaRef);
  if (!analysis) return [];
  const frames = new Set<number>();
  for (const t of [...analysis.beats, ...analysis.downbeats]) {
    const frame = clipTimelineFrame(clip, t, fps);
    if (frame !== undefined) frames.add(frame);
  }
  return [...frames];
}

export { abortError };
