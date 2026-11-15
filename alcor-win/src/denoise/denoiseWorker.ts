// Dedicated worker running DeepFilterNet3 (encoder, ERB decoder, DF decoder ONNX graphs) through onnxruntime-web
// (WASM). The runtime is imported lazily on `init`. Planar audio arrives at the source rate, is resampled to 48 kHz here,
// enhanced channel by channel and returned as 48 kHz planes.
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { createSession, loadOrt } from "../ml/ortRuntime";
import { StreamResampler } from "../ml/resample";
import { serveWorker, type WorkerScope } from "../ml/workerChannel";
import { dfnSampleRate, dfnNbDf, dfnNbErb } from "./dfnDsp";
import { enhanceChannel, type DfnFrameModels } from "./dfnPipeline";

export type DenoiseRequest =
  | { type: "init"; enc: ArrayBuffer; erbDec: ArrayBuffer; dfDec: ArrayBuffer }
  | { type: "begin"; sampleRate: number; channels: number }
  | { type: "push"; planes: Float32Array[] }
  | { type: "run" };

export type DenoiseReply = { type: "ok" } | { type: "planes"; planes: Float32Array[] };

interface Sessions {
  enc: InferenceSession;
  erbDec: InferenceSession;
  dfDec: InferenceSession;
}

let sessions: Sessions | undefined;
let resamplers: (StreamResampler | undefined)[] = [];
let channels: Float32Array[][] = [];

const models: DfnFrameModels = {
  async run(featErb, featSpec, frames) {
    const ort = await loadOrt();
    const s = sessions as Sessions;
    const enc = await s.enc.run({
      feat_erb: new ort.Tensor("float32", featErb, [1, 1, frames, dfnNbErb]),
      feat_spec: new ort.Tensor("float32", featSpec, [1, 2, frames, dfnNbDf]),
    });
    const [dec, df] = await Promise.all([
      s.erbDec.run({ emb: enc.emb as Tensor, e3: enc.e3 as Tensor, e2: enc.e2 as Tensor, e1: enc.e1 as Tensor, e0: enc.e0 as Tensor }),
      s.dfDec.run({ emb: enc.emb as Tensor, c0: enc.c0 as Tensor }),
    ]);
    return { gains: (dec.m as Tensor).data as Float32Array, coefs: (df.coefs as Tensor).data as Float32Array };
  },
};

serveWorker<DenoiseRequest, DenoiseReply>(self as unknown as WorkerScope<DenoiseRequest, DenoiseReply>, async (m, progress) => {
  switch (m.type) {
    case "init":
      sessions = { enc: await createSession(m.enc), erbDec: await createSession(m.erbDec), dfDec: await createSession(m.dfDec) };
      return { reply: { type: "ok" } };
    case "begin":
      resamplers = Array.from({ length: m.channels }, () => (m.sampleRate === dfnSampleRate ? undefined : new StreamResampler(m.sampleRate, dfnSampleRate)));
      channels = Array.from({ length: m.channels }, () => []);
      return { reply: { type: "ok" } };
    case "push":
      m.planes.forEach((plane, c) => {
        const r = resamplers[c];
        (channels[c] as Float32Array[]).push(r ? r.push(plane) : plane);
      });
      return { reply: { type: "ok" } };
    case "run": {
      if (!sessions) throw new Error("Speech enhancement model is not loaded.");
      const planes: Float32Array[] = [];
      for (let c = 0; c < channels.length; c++) {
        const r = resamplers[c];
        const blocks = channels[c] as Float32Array[];
        if (r) blocks.push(r.flush());
        const total = blocks.reduce((n, b) => n + b.length, 0);
        const dry = new Float32Array(total);
        let at = 0;
        for (const b of blocks) {
          dry.set(b, at);
          at += b.length;
        }
        channels[c] = [];
        planes.push(await enhanceChannel(dry, models, { onProgress: (f) => progress((c + f) / channels.length) }));
      }
      return { reply: { type: "planes", planes }, transfer: planes.map((p) => p.buffer) };
    }
  }
});
