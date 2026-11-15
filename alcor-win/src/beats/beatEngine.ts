// Main-thread side of the beats worker: decode with mediabunny, stream mono chunks to the worker, read logits back.
// One shared worker, runs serialised (the Swift `pipelineGate`). The worker and onnxruntime are created on first use.
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { mixDown, readAudioChunks } from "../ml/audioReader";
import { beatThisModel } from "../ml/modelCatalog";
import { loadModelBuffers, type ModelSource } from "../ml/modelStore";
import { WorkerChannel } from "../ml/workerChannel";
import { tauriModelSource } from "../deadair/sileroModel";
import { analysisFromLogits, type BeatAnalysis } from "./beatInference";
import type { BeatsReply, BeatsRequest } from "./beatsWorker";

export interface BeatEngine {
  /** Decodes `sourcePath` and runs the model. Throws NoAudioError when the media has no audio track. */
  detect(sourcePath: string, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<BeatAnalysis>;
  dispose(): void;
}

export function createBeatEngine(source: ModelSource = tauriModelSource): BeatEngine {
  const gate = new AsyncSemaphore(1);
  let channel: WorkerChannel<BeatsRequest, BeatsReply> | undefined;
  let ready: Promise<WorkerChannel<BeatsRequest, BeatsReply>> | undefined;

  const open = async (): Promise<WorkerChannel<BeatsRequest, BeatsReply>> => {
    const [logmel, beat] = await loadModelBuffers(beatThisModel, source);
    const ch = new WorkerChannel<BeatsRequest, BeatsReply>(new Worker(new URL("./beatsWorker.ts", import.meta.url), { type: "module" }));
    try {
      await ch.request({ type: "init", logmel: logmel as ArrayBuffer, beat: beat as ArrayBuffer }, [logmel as ArrayBuffer, beat as ArrayBuffer]);
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
    async detect(sourcePath, signal, onProgress) {
      await gate.wait(signal);
      try {
        ready ??= open().catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        const ch = await ready;
        throwIfAborted(signal);
        let began = false;
        let sampleCount = 0;
        const abort = (): void => {
          // A cancelled run leaves the worker mid-stream: drop it, the next call starts a fresh one.
          ch.terminate();
          if (channel === ch) {
            channel = undefined;
            ready = undefined;
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await readAudioChunks(sourcePath, 8, signal, async (chunk) => {
            if (!began) {
              began = true;
              await ch.request({ type: "begin", sampleRate: chunk.sampleRate });
            }
            const mono = mixDown(chunk.planes);
            sampleCount += mono.length;
            await ch.request({ type: "push", samples: mono }, [mono.buffer]);
          });
          if (sampleCount === 0) return { bpm: 0, beats: [], downbeats: [] };
          const reply = await ch.request({ type: "run" }, [], onProgress);
          if (reply.type !== "logits") throw new Error("Unexpected beat worker reply.");
          return analysisFromLogits(reply);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } finally {
        gate.signal();
      }
    },
  };
}

let shared: BeatEngine | undefined;

/** The app-wide engine (model + worker are created on first use). */
export function sharedBeatEngine(): BeatEngine {
  shared ??= createBeatEngine();
  return shared;
}
