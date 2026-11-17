// Dedicated worker running Whisper (mel frontend, encoder, decoder, word alignment) through onnxruntime-web (WASM).
// onnxruntime is imported lazily on `init`, so nothing is loaded until local transcription is first used.
import { loadOrt } from "../ml/ortRuntime";
import { serveWorker, type WorkerScope } from "../ml/workerChannel";
import { WhisperRunner, type WhisperAssets, type WindowResult } from "./whisperRunner";

export type WhisperRequest =
  | ({ type: "init" } & WhisperAssets)
  | { type: "window"; samples: Float32Array; language?: string };

export type WhisperReply = { type: "ready" } | { type: "window"; result: WindowResult };

let runner: WhisperRunner | undefined;

serveWorker<WhisperRequest, WhisperReply>(self as unknown as WorkerScope<WhisperRequest, WhisperReply>, async (m) => {
  switch (m.type) {
    case "init":
      runner = await WhisperRunner.create(await loadOrt(), m, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      return { reply: { type: "ready" } };
    case "window": {
      if (!runner) throw new Error("Whisper worker is not initialised.");
      return { reply: { type: "window", result: await runner.transcribeWindow(m.samples, m.language) } };
    }
  }
});
