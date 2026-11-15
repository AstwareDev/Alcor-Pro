// Cached beat analysis (the static half of BeatDetector.swift): JSON sidecars named `<mediaRef>_<fileTag>_beats.json` in
// the `BeatAnalysis` disk cache, where fileTag is `DiskCache.sizeMtimeTag` of the source (busts when the file changes).
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { sizeMtimeTag } from "../media/cacheKey";
import { diskCacheDirectory } from "../media/diskCache";
import { mediaIo, type MediaIo } from "../media/io";
import { joinPath } from "../model";
import { sharedBeatEngine, type BeatEngine } from "./beatEngine";
import { decodeBeatAnalysis, type BeatAnalysis, type BeatAnalysisCacheEntry } from "./beatInference";

export const beatCacheName = "BeatAnalysis";

export function beatAnalysisFileName(mediaRef: string, fileTag: string): string {
  return `${mediaRef}_${fileTag}_beats.json`;
}

export interface BeatDetectorDeps {
  engine: () => BeatEngine;
  io: () => Promise<MediaIo>;
  cacheDirectory: () => Promise<string>;
}

export interface BeatDetector {
  /** `loadSizeMtimeTag`. */
  fileTag(sourcePath: string): Promise<string>;
  /** `BeatDetector.cachedAnalysis`: never runs detection. */
  cachedAnalysis(sourcePath: string, mediaRef: string): Promise<BeatAnalysisCacheEntry | undefined>;
  /** `BeatDetector.analysis(for:mediaRef:force:)`: cache first, then the model; writes the sidecar and drops stale ones. */
  analysis(sourcePath: string, mediaRef: string, force?: boolean, signal?: AbortSignal): Promise<BeatAnalysis>;
}

export function createBeatDetector(deps: BeatDetectorDeps): BeatDetector {
  const cacheLookupGate = new AsyncSemaphore(2);

  const fileTag = async (sourcePath: string): Promise<string> => sizeMtimeTag(await (await deps.io()).stat(sourcePath).catch(() => null));

  const cachedAnalysis = async (sourcePath: string, mediaRef: string): Promise<BeatAnalysisCacheEntry | undefined> => {
    try {
      await cacheLookupGate.wait();
    } catch {
      return undefined;
    }
    try {
      const tag = await fileTag(sourcePath);
      const path = joinPath(await deps.cacheDirectory(), beatAnalysisFileName(mediaRef, tag));
      const bytes = await (await deps.io()).readAll(path).catch(() => undefined);
      if (!bytes) return undefined;
      const analysis = decodeBeatAnalysis(new TextDecoder().decode(bytes));
      return analysis ? { analysis, fileTag: tag } : undefined;
    } finally {
      cacheLookupGate.signal();
    }
  };

  const removeStaleCaches = async (io: MediaIo, directory: string, mediaRef: string, keep: string): Promise<void> => {
    const entries = await io.list(directory).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(`${mediaRef}_`) && entry.name !== keep) await io.remove(entry.path).catch(() => undefined);
    }
  };

  return {
    fileTag,
    cachedAnalysis,
    async analysis(sourcePath, mediaRef, force = false, signal) {
      if (!force) {
        const cached = await cachedAnalysis(sourcePath, mediaRef);
        if (cached) return cached.analysis;
      }
      throwIfAborted(signal);
      const analysis = await deps.engine().detect(sourcePath, signal);
      throwIfAborted(signal);
      const io = await deps.io();
      const directory = await deps.cacheDirectory();
      const name = beatAnalysisFileName(mediaRef, await fileTag(sourcePath));
      await io.mkdir(directory).catch(() => undefined);
      await removeStaleCaches(io, directory, mediaRef, name);
      await io.writeBytes(joinPath(directory, name), new TextEncoder().encode(JSON.stringify(analysis))).catch(() => undefined);
      return analysis;
    },
  };
}

let shared: BeatDetector | undefined;

/** The app detector: shared worker engine, app cache directory. */
export function sharedBeatDetector(): BeatDetector {
  shared ??= createBeatDetector({ engine: sharedBeatEngine, io: mediaIo, cacheDirectory: () => diskCacheDirectory(beatCacheName) });
  return shared;
}
