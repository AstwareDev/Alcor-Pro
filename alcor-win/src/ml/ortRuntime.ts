// Worker-side onnxruntime-web loader shared by the beat and denoise workers. The runtime is imported lazily, so
// nothing is loaded until a model is first needed. Import this module only from worker code.
import type { InferenceSession } from "onnxruntime-web";

export type Ort = typeof import("onnxruntime-web");

let ortPromise: Promise<Ort> | undefined;

export function loadOrt(): Promise<Ort> {
  ortPromise ??= import("onnxruntime-web/wasm").then((ort) => {
    // Without cross-origin isolation there is no SharedArrayBuffer, so run single threaded.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = { wasm: new URL("../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url).href };
    return ort;
  });
  return ortPromise;
}

export async function createSession(model: ArrayBuffer): Promise<InferenceSession> {
  const ort = await loadOrt();
  return ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
}
