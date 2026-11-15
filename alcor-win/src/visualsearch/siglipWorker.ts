// Dedicated worker running the SigLIP vision and text towers through onnxruntime-web (WASM, single thread). onnxruntime is
// imported lazily on `init`. Both towers emit a 768-d `pooler_output`; the vector is L2-normalised here.
import type { InferenceSession } from "onnxruntime-web";
import { createSession, loadOrt } from "../ml/ortRuntime";
import { serveWorker, type WorkerScope } from "../ml/workerChannel";

export type SiglipRequest =
  | { type: "init"; vision: ArrayBuffer; text: ArrayBuffer }
  /** RGBA, `size` x `size`, already squash-resized. */
  | { type: "image"; pixels: Uint8ClampedArray; size: number }
  | { type: "text"; ids: Int32Array };

export type SiglipReply = { type: "ok" } | { type: "embedding"; vector: Float32Array };

let vision: InferenceSession | undefined;
let text: InferenceSession | undefined;

function normalized(data: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] as number) ** 2;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] as number) / norm;
  return out;
}

/** RGBA bytes to planar float32, scaled to [-1, 1] (mean 0.5, std 0.5). */
function toPlanar(pixels: Uint8ClampedArray, size: number): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (pixels[i * 4] as number) / 127.5 - 1;
    out[plane + i] = (pixels[i * 4 + 1] as number) / 127.5 - 1;
    out[2 * plane + i] = (pixels[i * 4 + 2] as number) / 127.5 - 1;
  }
  return out;
}

serveWorker<SiglipRequest, SiglipReply>(self as unknown as WorkerScope<SiglipRequest, SiglipReply>, async (m) => {
  const ort = await loadOrt();
  switch (m.type) {
    case "init":
      vision = await createSession(m.vision);
      text = await createSession(m.text);
      return { reply: { type: "ok" } };
    case "image": {
      if (!vision) throw new Error("SigLIP worker is not initialised.");
      const out = await vision.run({ pixel_values: new ort.Tensor("float32", toPlanar(m.pixels, m.size), [1, 3, m.size, m.size]) });
      const vector = normalized((out.pooler_output as InstanceType<typeof ort.Tensor>).data as Float32Array);
      return { reply: { type: "embedding", vector }, transfer: [vector.buffer] };
    }
    case "text": {
      if (!text) throw new Error("SigLIP worker is not initialised.");
      const ids = BigInt64Array.from(Array.from(m.ids, (id) => BigInt(id)));
      const out = await text.run({ input_ids: new ort.Tensor("int64", ids, [1, m.ids.length]) });
      const vector = normalized((out.pooler_output as InstanceType<typeof ort.Tensor>).data as Float32Array);
      return { reply: { type: "embedding", vector }, transfer: [vector.buffer] };
    }
  }
});
