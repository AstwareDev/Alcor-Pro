// Port of Search/SearchIndexCoordinator.swift (visual half): a per-project indexing queue and search. Indexing runs one
// asset at a time in the background and waits for the editor to be idle (no playback, scrubbing or export). Spoken-word
// indexing is not part of this coordinator: transcripts are created by the transcription feature.
import { createSignal } from "solid-js";
import { isAbortError } from "../media/concurrency";
import type { MediaAsset } from "../model";
import { EmbeddingStore, embeddingKey, type AssetIndex } from "./embeddingStore";
import { decodeStill, sampleVideoFrames } from "./frameSampler";
import { searchIndexes, visualMatchCosineFloor, type VisualHit } from "./visualSearch";
import { indexImage, indexVideo, needsIndex, type IndexerDeps } from "./visualIndexer";
import type { VisualEmbedder, VisualSearchModel } from "./visualEmbedder";

export interface SearchIndexOptions {
  model: VisualSearchModel;
  assets: () => readonly MediaAsset[];
  store?: EmbeddingStore;
  /** Defaults to real frame decoding; tests inject fakes. */
  deps?: Partial<IndexerDeps>;
}

interface AssetSnapshot {
  id: string;
  url: string;
  type: MediaAsset["type"];
  duration: number;
  isGenerating: boolean;
}

const snapshotOf = (a: MediaAsset): AssetSnapshot => ({
  id: a.id, url: a.url, type: a.type, duration: a.duration, isGenerating: a.generationStatus.kind !== "none",
});

const sameSnapshot = (a: AssetSnapshot, b: AssetSnapshot): boolean =>
  a.id === b.id && a.url === b.url && a.type === b.type && a.duration === b.duration && a.isGenerating === b.isGenerating;

export class SearchIndexCoordinator {
  readonly model: VisualSearchModel;
  readonly store: EmbeddingStore;
  private readonly assets: () => readonly MediaAsset[];
  private readonly deps: IndexerDeps;

  private readonly totals = createSignal({ total: 0, completed: 0, fraction: 0 });
  private queue: AssetSnapshot[] = [];
  private scheduled = new Set<string>();
  private failed = new Set<string>();
  private worker: Promise<void> | undefined;
  private abort = new AbortController();
  private loaded = new Map<string, { key: string; index: AssetIndex }>();

  constructor(options: SearchIndexOptions) {
    this.model = options.model;
    this.assets = options.assets;
    this.store = options.store ?? new EmbeddingStore();
    this.deps = {
      store: this.store,
      frames: sampleVideoFrames,
      still: decodeStill,
      idle: () => Promise.resolve(),
      ...options.deps,
    };
  }

  get indexingActive(): boolean {
    const { total, completed } = this.totals[0]();
    return completed < total;
  }

  get batchTotal(): number {
    return this.totals[0]().total;
  }

  get batchCompleted(): number {
    return this.totals[0]().completed;
  }

  /** 0...1 over the whole batch, counting the asset in flight. */
  get indexingProgress(): number {
    const { total, completed, fraction } = this.totals[0]();
    return total > 0 ? Math.min(1, (completed + Math.min(Math.max(fraction, 0), 1)) / total) : 0;
  }

  /** Resolves once the queue has drained (tests, and callers that must see a finished index). */
  idle(): Promise<void> {
    return this.worker ?? Promise.resolve();
  }

  // MARK: Triggers

  /** Loads an installed model, then queues everything that needs indexing. */
  async projectOpened(): Promise<void> {
    await this.model.prepare();
    this.sweep();
  }

  /** Enqueue all current assets that need (re)indexing. */
  sweep(): void {
    if (!this.model.enabled() || !this.model.embedder()) return;
    this.failed.clear();
    for (const asset of this.assets()) this.schedule(asset);
  }

  schedule(asset: MediaAsset): void {
    if (!this.model.enabled() || !this.model.embedder()) return;
    if (asset.type !== "video" && asset.type !== "image") return;
    if (asset.generationStatus.kind !== "none" || this.scheduled.has(asset.id) || this.failed.has(asset.id)) return;
    this.queue.push(snapshotOf(asset));
    this.scheduled.add(asset.id);
    this.totals[1]((t) => ({ ...t, total: t.total + 1 }));
    this.startWorker();
  }

  private startWorker(): void {
    this.worker ??= this.run().finally(() => {
      this.worker = undefined;
      if (this.queue.length > 0) this.startWorker();
    });
  }

  /** Stops indexing and forgets queued work (project close, model change). */
  async cancel(): Promise<void> {
    const running = this.worker;
    this.abort.abort();
    this.abort = new AbortController();
    this.queue = [];
    this.scheduled.clear();
    await running;
    this.totals[1]({ total: 0, completed: 0, fraction: 0 });
  }

  /** `clearIndexGlobally`: drops every cached embedding and re-queues the project. */
  async clearIndex(): Promise<void> {
    await this.cancel();
    this.loaded.clear();
    this.failed.clear();
    await this.store.clearAll();
    this.sweep();
  }

  // MARK: Worker

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    for (let work = this.queue.shift(); work; work = this.queue.shift()) {
      if (signal.aborted) return;
      this.totals[1]((t) => ({ ...t, fraction: 0 }));
      await this.process(work, signal);
    }
    this.totals[1]({ total: 0, completed: 0, fraction: 0 });
  }

  private isCurrent(work: AssetSnapshot): boolean {
    const asset = this.assets().find((a) => a.id === work.id);
    return asset !== undefined && sameSnapshot(snapshotOf(asset), work);
  }

  private async process(work: AssetSnapshot, signal: AbortSignal): Promise<void> {
    let retry: MediaAsset | undefined;
    try {
      const embedder = this.model.embedder();
      if (!embedder || !this.model.enabled() || !this.isCurrent(work)) {
        retry = this.assets().find((a) => a.id === work.id);
        return;
      }
      if (!(await needsIndex(work.url, embedder.spec, this.store))) return;
      await this.deps.idle(signal);
      await this.indexOne(work, embedder, signal);
    } catch (e) {
      if (!isAbortError(e) && !signal.aborted) this.failed.add(work.id);
    } finally {
      this.scheduled.delete(work.id);
      if (!signal.aborted) this.totals[1]((t) => ({ ...t, completed: t.completed + 1 }));
      if (retry) this.schedule(retry);
    }
  }

  private async indexOne(work: AssetSnapshot, embedder: VisualEmbedder, signal: AbortSignal): Promise<void> {
    if (work.type === "image") await indexImage(this.deps, embedder, work.url, signal);
    else await indexVideo(this.deps, embedder, work.url, work.duration, signal, (fraction) => this.totals[1]((t) => ({ ...t, fraction })));
    this.loaded.delete(work.id);
  }

  // MARK: Query

  /** How many of the given assets already have a current index. */
  async indexedCount(assets: readonly MediaAsset[]): Promise<number> {
    const spec = this.model.embedder()?.spec;
    if (!spec) return 0;
    let count = 0;
    for (const a of assets) if (!(await needsIndex(a.url, spec, this.store))) count++;
    return count;
  }

  async search(query: string, limit = 20, within?: ReadonlySet<string>): Promise<VisualHit[]> {
    const embedder = this.model.embedder();
    const trimmed = query.trim();
    if (!embedder || this.model.state().kind !== "ready" || trimmed === "") return [];
    const candidates = this.assets().filter((a) => (a.type === "video" || a.type === "image") && (within?.has(a.id) ?? true));
    const indexes: { assetID: string; index: AssetIndex }[] = [];
    for (const asset of candidates) {
      const key = await embeddingKey(asset.url);
      if (key === undefined) continue;
      const cached = this.loaded.get(asset.id);
      if (cached?.key === key) {
        indexes.push({ assetID: asset.id, index: cached.index });
        continue;
      }
      try {
        const index = await this.store.load(key);
        this.loaded.set(asset.id, { key, index });
        indexes.push({ assetID: asset.id, index });
      } catch {
        // not indexed yet (or unreadable): skipped, like `try?`
      }
    }
    if (indexes.length === 0) return [];
    return searchIndexes(await embedder.encodeText(trimmed), indexes, { limit, minScore: visualMatchCosineFloor });
  }
}
