// Dedicated worker running Beat This! (log-mel frontend + transformer, ONNX) through onnxruntime-web (WASM). The
// runtime is imported lazily on `init`. Audio arrives as mono chunks at the source rate and is resampled to 22050 Hz here.
import type { InferenceSession } from "onnxruntime-web";
import { createSession, loadOrt } from "../ml/ortRuntime";
import { StreamResampler } from "../ml/resample";
import { serveWorker, type WorkerScope } from "../ml/workerChannel";
import { beatSampleRate, predictLogits, type ChunkLogits } from "./beatInference";

export type BeatsRequest =
  | { type: "init"; logmel: ArrayBuffer; beat: ArrayBuffer }
  | { type: "begin"; sampleRate: number }
  | { type: "push"; samples: Float32Array }
  | { type: "run" };

export type BeatsReply = { type: "ok" } | ({ type: "logits" } & ChunkLogits);

interface Sessions {
  logmel: InferenceSession;
  beat: InferenceSession;
}

let sessions: Sessions | undefined;
let resampler: StreamResampler | undefined;
let blocks: Float32Array[] = [];
let total = 0;

function append(block: Float32Array): void {
  if (block.length === 0) return;
  blocks.push(block);
  total += block.length;
}

function joined(): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

async function runChunk(chunk: Float32Array): Promise<ChunkLogits> {
  const ort = await loadOrt();
  const s = sessions as Sessions;
  const mel = await s.logmel.run({ audio: new ort.Tensor("float32", chunk, [chunk.length]) });
  const spect = mel.spect as InstanceType<typeof ort.Tensor>;
  const frames = spect.dims[0] as number;
  const out = await s.beat.run({ input_spectrogram: new ort.Tensor("float32", spect.data as Float32Array, [1, frames, 128]) });
  return {
    beat: Float32Array.from((out.beat as InstanceType<typeof ort.Tensor>).data as Float32Array),
    downbeat: Float32Array.from((out.downbeat as InstanceType<typeof ort.Tensor>).data as Float32Array),
  };
}

serveWorker<BeatsRequest, BeatsReply>(self as unknown as WorkerScope<BeatsRequest, BeatsReply>, async (m, progress) => {
  switch (m.type) {
    case "init":
      sessions = { logmel: await createSession(m.logmel), beat: await createSession(m.beat) };
      return { reply: { type: "ok" } };
    case "begin":
      resampler = m.sampleRate === beatSampleRate ? undefined : new StreamResampler(m.sampleRate, beatSampleRate);
      blocks = [];
      total = 0;
      return { reply: { type: "ok" } };
    case "push":
      append(resampler ? resampler.push(m.samples) : m.samples);
      return { reply: { type: "ok" } };
    case "run": {
      if (!sessions) throw new Error("Beat model is not loaded.");
      if (resampler) append(resampler.flush());
      const samples = joined();
      blocks = [];
      total = 0;
      const logits = await predictLogits(samples, runChunk, progress);
      return { reply: { type: "logits", ...logits }, transfer: [logits.beat.buffer, logits.downbeat.buffer] };
    }
  }
});
