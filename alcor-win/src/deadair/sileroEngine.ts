// Main-thread side of the Silero VAD worker: one shared worker, runs serialised (Silero state is per stream, and the
// Swift `ModelBox` actor serialises model use the same way). The worker, and onnxruntime inside it, are created on
// the first `begin`.
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { binarizeSpeech, chunkCountForSamples, type VadEngine, type VadRun, type VoiceAnalysis } from "./voiceActivity";
import { ensureSileroModel, tauriModelSource, type ModelSource } from "./sileroModel";
import type { WorkerReply, WorkerRequest } from "./sileroWorker";

class WorkerChannel {
  private readonly worker: Worker;
  private waiter: { resolve: (r: WorkerReply) => void; reject: (e: Error) => void } | undefined;
  inputNames: string[] = [];
  outputNames: string[] = [];

  constructor() {
    this.worker = new Worker(new URL("./sileroWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const w = this.waiter;
      this.waiter = undefined;
      if (e.data.type === "error") w?.reject(new Error(e.data.message));
      else w?.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      const w = this.waiter;
      this.waiter = undefined;
      w?.reject(new Error(e.message || "Silero VAD worker failed."));
    };
  }

  request(message: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerReply> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.worker.postMessage(message, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export interface SileroEngineOptions {
  source?: ModelSource;
}

export function createSileroEngine(options: SileroEngineOptions = {}): VadEngine & { channel(): WorkerChannel | undefined; dispose(): void } {
  const source = options.source ?? tauriModelSource;
  const gate = new AsyncSemaphore(1);
  let channel: WorkerChannel | undefined;
  let ready: Promise<WorkerChannel> | undefined;

  const open = async (): Promise<WorkerChannel> => {
    const path = await ensureSileroModel(source);
    const bytes = await (await source.io()).readAll(path);
    const ch = new WorkerChannel();
    const model = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    try {
      const reply = await ch.request({ type: "init", model }, [model]);
      if (reply.type === "ready") {
        ch.inputNames = reply.inputNames;
        ch.outputNames = reply.outputNames;
      }
    } catch (e) {
      ch.terminate();
      throw e;
    }
    channel = ch;
    return ch;
  };

  return {
    channel: () => channel,
    dispose() {
      channel?.terminate();
      channel = undefined;
      ready = undefined;
    },
    async begin(signal): Promise<VadRun> {
      await gate.wait(signal);
      try {
        ready ??= open().catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        const ch = await ready;
        throwIfAborted(signal);
        await ch.request({ type: "begin" });
        const probabilities: Float32Array[] = [];
        let sampleCount = 0;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          gate.signal();
        };
        const collect = (reply: WorkerReply): void => {
          if (reply.type === "probs" && reply.probs.length > 0) probabilities.push(reply.probs);
        };
        return {
          release,
          async push(samples) {
            try {
              throwIfAborted(signal);
              sampleCount += samples.length;
              collect(await ch.request({ type: "push", samples }, [samples.buffer]));
            } catch (e) {
              release();
              throw e;
            }
          },
          async finish(): Promise<VoiceAnalysis> {
            try {
              collect(await ch.request({ type: "finish" }));
              const total = probabilities.reduce((n, p) => n + p.length, 0);
              const all = new Float32Array(total);
              let at = 0;
              for (const p of probabilities) {
                all.set(p, at);
                at += p.length;
              }
              return { chunkCount: chunkCountForSamples(sampleCount), segments: binarizeSpeech(all) };
            } finally {
              release();
            }
          },
        };
      } catch (e) {
        gate.signal();
        throw e;
      }
    },
  };
}

let shared: ReturnType<typeof createSileroEngine> | undefined;

/** The app-wide engine (model + worker are created on first use). */
export function sharedSileroEngine(): VadEngine {
  shared ??= createSileroEngine();
  return shared;
}
