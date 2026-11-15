// Main-thread side of the denoise worker (see beatEngine.ts): decode, stream planar chunks, collect 48 kHz planes.
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { readAudioChunks } from "../ml/audioReader";
import { deepFilterNet3Model } from "../ml/modelCatalog";
import { loadModelBuffers, type ModelSource } from "../ml/modelStore";
import { WorkerChannel } from "../ml/workerChannel";
import { tauriModelSource } from "../deadair/sileroModel";
import { dfnSampleRate } from "./dfnDsp";
import type { DenoiseReply, DenoiseRequest } from "./denoiseWorker";

export interface EnhancedAudio {
  /** At most two channels, like the Swift `readChannels`. */
  planes: Float32Array[];
  sampleRate: number;
}

export interface DenoiseEngine {
  /** Throws NoAudioError when the media has no audio track. */
  enhance(sourcePath: string, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<EnhancedAudio>;
  dispose(): void;
}

export function createDenoiseEngine(source: ModelSource = tauriModelSource): DenoiseEngine {
  const gate = new AsyncSemaphore(1);
  let channel: WorkerChannel<DenoiseRequest, DenoiseReply> | undefined;
  let ready: Promise<WorkerChannel<DenoiseRequest, DenoiseReply>> | undefined;

  const open = async (): Promise<WorkerChannel<DenoiseRequest, DenoiseReply>> => {
    const [enc, erbDec, dfDec] = (await loadModelBuffers(deepFilterNet3Model, source)) as [ArrayBuffer, ArrayBuffer, ArrayBuffer];
    const ch = new WorkerChannel<DenoiseRequest, DenoiseReply>(new Worker(new URL("./denoiseWorker.ts", import.meta.url), { type: "module" }));
    try {
      await ch.request({ type: "init", enc, erbDec, dfDec }, [enc, erbDec, dfDec]);
    } catch (e) {
      ch.terminate();
      throw e;
    }
    channel = ch;
    return ch;
  };

  return {
    dispose() {
      channel?.terminate();
      channel = undefined;
      ready = undefined;
    },
    async enhance(sourcePath, signal, onProgress) {
      await gate.wait(signal);
      try {
        ready ??= open().catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        const ch = await ready;
        throwIfAborted(signal);
        const abort = (): void => {
          ch.terminate();
          if (channel === ch) {
            channel = undefined;
            ready = undefined;
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          let began = false;
          let samples = 0;
          await readAudioChunks(sourcePath, 2, signal, async (chunk) => {
            if (!began) {
              began = true;
              await ch.request({ type: "begin", sampleRate: chunk.sampleRate, channels: chunk.planes.length });
            }
            samples += chunk.planes[0]?.length ?? 0;
            await ch.request({ type: "push", planes: chunk.planes }, chunk.planes.map((p) => p.buffer));
          });
          if (samples === 0) return { planes: [], sampleRate: dfnSampleRate };
          const reply = await ch.request({ type: "run" }, [], onProgress);
          if (reply.type !== "planes") throw new Error("Unexpected denoise worker reply.");
          return { planes: reply.planes, sampleRate: dfnSampleRate };
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } finally {
        gate.signal();
      }
    },
  };
}

let shared: DenoiseEngine | undefined;

/** The app-wide engine (models + worker are created on first use). */
export function sharedDenoiseEngine(): DenoiseEngine {
  shared ??= createDenoiseEngine();
  return shared;
}
