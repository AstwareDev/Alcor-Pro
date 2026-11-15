// Dedicated worker running the Silero VAD v5 ONNX model through onnxruntime-web (WASM, single thread). onnxruntime is
// imported lazily on `init`, so nothing is loaded until voice activity is first needed.
// Model I/O (v5): input [1, 64 context + 512 samples], state [2, 1, 128], sr int64 scalar -> output [1, 1], stateN.
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { createSession, loadOrt } from "../ml/ortRuntime";

export type WorkerRequest =
  | { type: "init"; model: ArrayBuffer }
  | { type: "begin" }
  | { type: "push"; samples: Float32Array }
  | { type: "finish" };

export type WorkerReply =
  | { type: "ready"; inputNames: string[]; outputNames: string[] }
  | { type: "probs"; probs: Float32Array }
  | { type: "error"; message: string };

const chunkSize = 512;
const contextSize = 64;
const stateSize = 2 * 1 * 128;

interface Scope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as Scope;

interface Runtime {
  ort: typeof import("onnxruntime-web");
  session: InferenceSession;
}

let runtime: Runtime | undefined;
let state = new Float32Array(stateSize);
let context = new Float32Array(contextSize);
let carry = new Float32Array(0);

function resetState(): void {
  state = new Float32Array(stateSize);
  context = new Float32Array(contextSize);
  carry = new Float32Array(0);
}

async function init(model: ArrayBuffer): Promise<WorkerReply> {
  const ort = await loadOrt();
  const session = await createSession(model);
  runtime = { ort, session };
  resetState();
  return { type: "ready", inputNames: [...session.inputNames], outputNames: [...session.outputNames] };
}

async function runChunk(rt: Runtime, chunk: Float32Array): Promise<number> {
  const input = new Float32Array(contextSize + chunkSize);
  input.set(context, 0);
  input.set(chunk, contextSize);
  context = input.slice(chunkSize); // last 64 samples of (context + chunk)
  const { Tensor: T } = rt.ort;
  const feeds: Record<string, Tensor> = {
    input: new T("float32", input, [1, contextSize + chunkSize]),
    state: new T("float32", state, [2, 1, 128]),
    sr: new T("int64", BigInt64Array.from([16000n]), []),
  };
  const out = await rt.session.run(feeds);
  state = Float32Array.from(out.stateN.data as Float32Array);
  return (out.output.data as Float32Array)[0];
}

async function process(samples: Float32Array, flush: boolean): Promise<Float32Array> {
  if (!runtime) throw new Error("Silero VAD worker is not initialised.");
  const all = new Float32Array(carry.length + samples.length);
  all.set(carry, 0);
  all.set(samples, carry.length);
  const full = Math.trunc(all.length / chunkSize);
  const total = full + (flush && all.length % chunkSize > 0 ? 1 : 0);
  const probs = new Float32Array(total);
  for (let i = 0; i < full; i++) probs[i] = await runChunk(runtime, all.subarray(i * chunkSize, (i + 1) * chunkSize));
  const rest = all.subarray(full * chunkSize);
  if (flush) {
    if (rest.length > 0) {
      const padded = new Float32Array(chunkSize); // zero padded like the Swift last chunk
      padded.set(rest, 0);
      probs[full] = await runChunk(runtime, padded);
    }
    carry = new Float32Array(0);
  } else {
    carry = rest.slice();
  }
  return probs;
}

scope.onmessage = (e) => {
  const msg = e.data;
  const reply = async (): Promise<WorkerReply> => {
    switch (msg.type) {
      case "init":
        return init(msg.model);
      case "begin":
        resetState();
        return { type: "probs", probs: new Float32Array(0) };
      case "push":
        return { type: "probs", probs: await process(msg.samples, false) };
      case "finish":
        return { type: "probs", probs: await process(new Float32Array(0), true) };
    }
  };
  reply().then(
    (r) => scope.postMessage(r, r.type === "probs" ? [r.probs.buffer] : []),
    (err: unknown) => scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );
};
