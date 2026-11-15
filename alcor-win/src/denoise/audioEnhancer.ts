// Port of AudioEnhancer.swift: a denoised ("wet") copy of each source, baked once and cached on disk as
// `<mediaRef>_<fileTag>_wet.wav` in the `EnhancedAudio` cache (fileTag = size_mtime of the source, so replacing the
// file busts it). Stale files of the same mediaRef are removed when a new one is written.
import { sizeMtimeTag } from "../media/cacheKey";
import { diskCacheDirectory } from "../media/diskCache";
import { mediaIo, type MediaIo } from "../media/io";
import { joinPath } from "../model";
import { interleaveFloat32, wavHeader } from "../ml/wav";
import { sharedDenoiseEngine, type DenoiseEngine, type EnhancedAudio } from "./denoiseEngine";

export const enhancedAudioCacheName = "EnhancedAudio";

export class EnhanceError extends Error {
  constructor(kind: "noAudioTrack" | "writeFailed") {
    super(kind === "noAudioTrack" ? "Source has no audio track" : "Could not write enhanced audio");
    this.name = "EnhanceError";
  }
}

export function wetFileName(mediaRef: string, fileTag: string): string {
  return `${mediaRef}_${fileTag}_wet.wav`;
}

/** Streams a float WAV to `path` (the platform implementation uses the positional export-file writer). */
export type WavWriter = (path: string, audio: EnhancedAudio) => Promise<void>;

const writeBlockFrames = 1 << 18;

export const backendWavWriter: WavWriter = async (path, audio) => {
  const frames = audio.planes[0]?.length ?? 0;
  const { exportFileAbort, exportFileFinish, exportFileOpen, exportFileWrite } = await import("../platform/backend");
  const handle = await exportFileOpen(path);
  try {
    const header = wavHeader(frames, audio.planes.length, audio.sampleRate);
    await exportFileWrite(handle, 0, header);
    let offset = header.length;
    for (let at = 0; at < frames; at += writeBlockFrames) {
      const bytes = interleaveFloat32(audio.planes, at, Math.min(writeBlockFrames, frames - at));
      await exportFileWrite(handle, offset, bytes);
      offset += bytes.length;
    }
    await exportFileFinish(handle);
  } catch (e) {
    await exportFileAbort(handle).catch(() => undefined);
    throw e;
  }
};

export interface AudioEnhancerDeps {
  engine: () => DenoiseEngine;
  io: () => Promise<MediaIo>;
  cacheDirectory: () => Promise<string>;
  writeWav: WavWriter;
}

export interface AudioEnhancer {
  /** `cachedDenoisedURL`: the baked wet file if it exists. */
  cachedDenoisedPath(sourcePath: string, mediaRef: string): Promise<string | undefined>;
  /** `denoisedAudio(for:mediaRef:)`: returns the cached wet file, baking it first when needed. */
  denoisedAudio(sourcePath: string, mediaRef: string, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<string>;
}

export function createAudioEnhancer(deps: AudioEnhancerDeps): AudioEnhancer {
  const denoisedPath = async (sourcePath: string, mediaRef: string): Promise<string> => {
    const io = await deps.io();
    const tag = sizeMtimeTag(await io.stat(sourcePath).catch(() => null));
    return joinPath(await deps.cacheDirectory(), wetFileName(mediaRef, tag));
  };
  const exists = async (path: string): Promise<boolean> => (await (await deps.io()).stat(path).catch(() => null)) !== null;

  const cachedDenoisedPath = async (sourcePath: string, mediaRef: string): Promise<string | undefined> => {
    const path = await denoisedPath(sourcePath, mediaRef);
    return (await exists(path)) ? path : undefined;
  };

  return {
    cachedDenoisedPath,
    async denoisedAudio(sourcePath, mediaRef, signal, onProgress) {
      const output = await denoisedPath(sourcePath, mediaRef);
      if (await exists(output)) return output;
      let audio: EnhancedAudio;
      try {
        audio = await deps.engine().enhance(sourcePath, signal, onProgress);
      } catch (e) {
        if (e instanceof Error && e.name === "NoAudioError") throw new EnhanceError("noAudioTrack");
        throw e;
      }
      const frames = audio.planes[0]?.length ?? 0;
      if (frames === 0 || !audio.planes.every((p) => p.length === frames)) throw new EnhanceError(frames === 0 ? "noAudioTrack" : "writeFailed");
      const io = await deps.io();
      const directory = await deps.cacheDirectory();
      await io.mkdir(directory).catch(() => undefined);
      const name = wetFileName(mediaRef, sizeMtimeTag(await io.stat(sourcePath).catch(() => null)));
      for (const entry of await io.list(directory).catch(() => [])) {
        if (entry.name.startsWith(`${mediaRef}_`) && entry.name !== name) await io.remove(entry.path).catch(() => undefined);
      }
      const staging = joinPath(directory, `.writing-${crypto.randomUUID()}.wav`);
      try {
        await deps.writeWav(staging, audio);
        await io.rename(staging, output);
      } catch (e) {
        await io.remove(staging).catch(() => undefined);
        throw e instanceof EnhanceError ? e : new EnhanceError("writeFailed");
      }
      return output;
    },
  };
}

let shared: AudioEnhancer | undefined;

export function sharedAudioEnhancer(): AudioEnhancer {
  shared ??= createAudioEnhancer({
    engine: sharedDenoiseEngine,
    io: mediaIo,
    cacheDirectory: () => diskCacheDirectory(enhancedAudioCacheName),
    writeWav: backendWavWriter,
  });
  return shared;
}
