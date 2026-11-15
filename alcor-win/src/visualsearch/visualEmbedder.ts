// Port of Search/Models/VisualEmbedder.swift + VisualModelLoader.swift: the embedder contract (so indexing and search can
// be driven by a fake in tests), the SigLIP worker-backed implementation, and the app-wide model loader with its state.
import { createSignal, type Accessor } from "solid-js";
import { tauriModelSource } from "../deadair/sileroModel";
import { siglipModel } from "../ml/modelCatalog";
import { isModelInstalled, loadModelBuffers, modelStatus, type ModelSource } from "../ml/modelStore";
import { WorkerChannel } from "../ml/workerChannel";
import type { SiglipReply, SiglipRequest } from "./siglipWorker";
import { SiglipTokenizer } from "./siglipTokenizer";

export interface EmbedderSpec {
  model: string;
  version: number;
  embeddingDim: number;
  imageSize: number;
  contextLength: number;
}

export const siglipSpec: EmbedderSpec = { model: "siglip-base-patch16-256", version: 1, embeddingDim: 768, imageSize: 256, contextLength: 64 };

export interface VisualEmbedder {
  readonly spec: EmbedderSpec;
  /** RGBA pixels, `spec.imageSize` square (squash-resized, not cropped). Returns a unit vector. */
  encodeImage(pixels: Uint8ClampedArray): Promise<Float32Array>;
  /** Unit vector for a caption-style query. */
  encodeText(text: string): Promise<Float32Array>;
}

export type VisualModelState =
  | { kind: "unknown" }
  | { kind: "notInstalled" }
  | { kind: "downloading" }
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "failed"; reason: string };

/** `VisualSearchModelLoading`: what the index coordinator, the panel and the agent tool need from the model. */
export interface VisualSearchModel {
  enabled(): boolean;
  state(): VisualModelState;
  /** 0...1 while downloading. */
  downloadProgress(): number;
  embedder(): VisualEmbedder | undefined;
  /** Loads an installed model; never downloads. */
  prepare(): Promise<void>;
  /** Downloads (if needed) and loads the model. */
  download(): Promise<void>;
}

function createSiglipEmbedder(channel: WorkerChannel<SiglipRequest, SiglipReply>, tokenizer: SiglipTokenizer): VisualEmbedder {
  const vector = async (message: SiglipRequest, transfer: Transferable[] = []): Promise<Float32Array> => {
    const reply = await channel.request(message, transfer);
    if (reply.type !== "embedding") throw new Error("Unexpected SigLIP worker reply.");
    return reply.vector;
  };
  return {
    spec: siglipSpec,
    encodeImage: (pixels) => vector({ type: "image", pixels, size: siglipSpec.imageSize }, [pixels.buffer]),
    encodeText: (text) => vector({ type: "text", ids: tokenizer.tokenize(text) }),
  };
}

const enabledKey = "searchIndexEnabled";

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(enabledKey) !== "false";
  } catch {
    return true;
  }
}

export class SiglipModelLoader implements VisualSearchModel {
  private readonly stateSignal = createSignal<VisualModelState>({ kind: "unknown" });
  private readonly enabledSignal = createSignal(readEnabled());
  private readonly progress: Accessor<{ receivedBytes: number; totalBytes: number }>;
  private current: VisualEmbedder | undefined;
  private channel: WorkerChannel<SiglipRequest, SiglipReply> | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly source: ModelSource = tauriModelSource) {
    this.progress = modelStatus(siglipModel);
  }

  enabled = (): boolean => this.enabledSignal[0]();
  state = (): VisualModelState => this.stateSignal[0]();
  embedder = (): VisualEmbedder | undefined => this.current;

  downloadProgress(): number {
    const { receivedBytes, totalBytes } = this.progress();
    return totalBytes > 0 ? Math.min(receivedBytes / totalBytes, 1) : 0;
  }

  setEnabled(value: boolean): void {
    this.enabledSignal[1](value);
    try {
      globalThis.localStorage?.setItem(enabledKey, String(value));
    } catch {
      // persistence is best effort, like UserDefaults
    }
  }

  prepare(): Promise<void> {
    if (!this.enabled() || this.current) return Promise.resolve();
    return (this.loading ??= this.load(false).finally(() => (this.loading = undefined)));
  }

  download(): Promise<void> {
    if (!this.enabled() || this.current) return Promise.resolve();
    return (this.loading ??= this.load(true).finally(() => (this.loading = undefined)));
  }

  /** Frees the worker (and the models in it); the next `prepare` loads again. */
  unload(): void {
    this.channel?.terminate();
    this.channel = undefined;
    this.current = undefined;
    this.stateSignal[1]({ kind: "unknown" });
  }

  private async load(allowDownload: boolean): Promise<void> {
    const set = this.stateSignal[1];
    if (allowDownload) set({ kind: "downloading" });
    try {
      if (!allowDownload && !(await isModelInstalled(siglipModel, this.source))) {
        set({ kind: "notInstalled" });
        return;
      }
      const [vision, text, tokenizerJson] = await loadModelBuffers(siglipModel, this.source);
      set({ kind: "preparing" });
      const tokenizer = SiglipTokenizer.fromJSON(new TextDecoder().decode(tokenizerJson), siglipSpec.contextLength);
      const channel = new WorkerChannel<SiglipRequest, SiglipReply>(new Worker(new URL("./siglipWorker.ts", import.meta.url), { type: "module" }));
      try {
        await channel.request({ type: "init", vision: vision as ArrayBuffer, text: text as ArrayBuffer }, [vision as ArrayBuffer, text as ArrayBuffer]);
      } catch (e) {
        channel.terminate();
        throw e;
      }
      this.channel = channel;
      this.current = createSiglipEmbedder(channel, tokenizer);
      set({ kind: "ready" });
    } catch (e) {
      set({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

let shared: SiglipModelLoader | undefined;

/** `VisualModelLoader.shared`. */
export function sharedVisualModel(): SiglipModelLoader {
  shared ??= new SiglipModelLoader();
  return shared;
}
