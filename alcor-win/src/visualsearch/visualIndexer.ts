// Port of Search/Indexing/VisualIndexer.swift: indexes one asset (sampled frames -> embeddings -> EmbeddingStore).
// Idempotent per (file, model, sampler). Frame decoding and idling are injected so tests run without media.
import { throwIfAborted } from "../media/concurrency";
import { embeddingKey, type EmbeddingStore } from "./embeddingStore";
import type { SampledFrame } from "./frameSampler";
import { buildRows, samplerVersion } from "./shots";
import type { EmbedderSpec, VisualEmbedder } from "./visualEmbedder";

export interface IndexerDeps {
  store: EmbeddingStore;
  frames(path: string, duration: number, size: number, signal?: AbortSignal): AsyncIterable<SampledFrame>;
  still(path: string, size: number, signal?: AbortSignal): Promise<Uint8ClampedArray | undefined>;
  /** Resolves once the editor is idle (not playing, not exporting). */
  idle(signal?: AbortSignal): Promise<void>;
}

export async function needsIndex(path: string, spec: EmbedderSpec, store: EmbeddingStore): Promise<boolean> {
  const key = await embeddingKey(path);
  if (key === undefined) return false;
  return !(await store.isCurrent(key, { model: spec.model, modelVersion: spec.version, samplerVersion }));
}

async function save(
  deps: IndexerDeps, key: string, spec: EmbedderSpec, rows: ReturnType<typeof buildRows>, vectors: Float32Array[],
): Promise<void> {
  const flat = new Float32Array(rows.length * spec.embeddingDim);
  vectors.forEach((v, i) => flat.set(v, i * spec.embeddingDim));
  await deps.store.save(
    { model: spec.model, modelVersion: spec.version, samplerVersion, dim: spec.embeddingDim, count: rows.length },
    rows, flat, key,
  );
}

export async function indexVideo(
  deps: IndexerDeps, embedder: VisualEmbedder, path: string, duration: number,
  signal?: AbortSignal, progress?: (fraction: number) => void,
): Promise<void> {
  const key = await embeddingKey(path);
  if (key === undefined || !(await needsIndex(path, embedder.spec, deps.store))) return;
  const frames: { time: number; isNewShot: boolean }[] = [];
  const vectors: Float32Array[] = [];
  for await (const frame of deps.frames(path, duration, embedder.spec.imageSize, signal)) {
    throwIfAborted(signal);
    await deps.idle(signal);
    vectors.push(await embedder.encodeImage(frame.pixels));
    frames.push({ time: frame.time, isNewShot: frame.isNewShot });
    if (duration > 0) progress?.(Math.min(frame.time / duration, 1));
  }
  throwIfAborted(signal);
  await save(deps, key, embedder.spec, buildRows(frames, duration), vectors);
}

/** Stills skip the sampler: one embedding, zero-length shot range. */
export async function indexImage(deps: IndexerDeps, embedder: VisualEmbedder, path: string, signal?: AbortSignal): Promise<void> {
  const key = await embeddingKey(path);
  if (key === undefined || !(await needsIndex(path, embedder.spec, deps.store))) return;
  await deps.idle(signal);
  const pixels = await deps.still(path, embedder.spec.imageSize, signal);
  const vectors = pixels ? [await embedder.encodeImage(pixels)] : [];
  throwIfAborted(signal);
  await save(deps, key, embedder.spec, pixels ? [{ time: 0, shotStart: 0, shotEnd: 0 }] : [], vectors);
}
