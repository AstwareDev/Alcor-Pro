// Browser-only page: `?dev=deadair`. Downloads the Silero VAD model (fake in-memory file system, real network + sha256
// check), runs the ONNX worker over generated test signals and prints the detected regions.
import { createSignal, Show } from "solid-js";
import { makeFakeIo } from "../media/fakeIo";
import { createSileroEngine } from "./sileroEngine";
import { ensureSileroModel, sileroModel, sileroModelStatus, type ModelSource } from "./sileroModel";
import { analysisMask, vadChunkDuration, vadSampleRate, type SpeechSpan } from "./voiceActivity";

const io = makeFakeIo();
const source: ModelSource = {
  io: () => Promise.resolve(io),
  modelsRoot: () => Promise.resolve("/appData/models"),
  async download(url, dest, onProgress) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || null;
    const parts: Uint8Array[] = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const all = new Uint8Array(received);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    await io.writeBytes(dest, all);
  },
};

/** Voiced-speech-like burst: 120 Hz glottal harmonics shaped by formants, 4 Hz syllabic modulation. */
function speechLike(seconds: number, f0 = 120): Float32Array {
  const n = Math.round(seconds * vadSampleRate);
  const out = new Float32Array(n);
  const formants = [700, 1200, 2600];
  for (let i = 0; i < n; i++) {
    const t = i / vadSampleRate;
    let v = 0;
    for (let h = 1; h * f0 < 4000; h++) {
      const f = h * f0;
      let gain = 0;
      for (const fm of formants) gain += Math.exp(-(((f - fm) / 150) ** 2));
      v += gain * Math.sin(2 * Math.PI * f * t) / h;
    }
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = 0.25 * v * syllable;
  }
  return out;
}

function tone(seconds: number, hz: number): Float32Array {
  const n = Math.round(seconds * vadSampleRate);
  return Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / vadSampleRate));
}

function noise(seconds: number, level: number): Float32Array {
  const n = Math.round(seconds * vadSampleRate);
  return Float32Array.from({ length: n }, () => (Math.random() * 2 - 1) * level);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const fmt = (spans: SpeechSpan[]): string => (spans.length === 0 ? "(none)" : spans.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}s`).join(", "));

export default function DeadAirDev() {
  const [log, setLog] = createSignal<string[]>([]);
  const print = (line: string): void => {
    setLog((l) => [...l, line]);
  };
  const [running, setRunning] = createSignal(false);

  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      const t0 = performance.now();
      const path = await ensureSileroModel(source);
      print(`model ready at ${path} (${((performance.now() - t0) / 1000).toFixed(1)}s incl. download + sha256 ${sileroModel.sha256.slice(0, 12)}...)`);
      const engine = createSileroEngine({ source });
      const cases: [string, Float32Array, string][] = [
        ["silence+noise only (12s)", noise(12, 0.002), "expect none"],
        ["pure 440 Hz tone 2-5s, 7-10s", concat([noise(2, 0.002), tone(3, 440), noise(2, 0.002), tone(3, 440), noise(2, 0.002)]), "tones are not speech; expect none"],
        ["speech-like bursts 2-5s, 7-10s", concat([noise(2, 0.002), speechLike(3), noise(2, 0.002), speechLike(3, 180), noise(2, 0.002)]), "bursts at 2-5, 7-10 if the synthetic counts as speech"],
      ];
      for (const [name, samples, note] of cases) {
        const t1 = performance.now();
        const run = await engine.begin();
        for (let off = 0; off < samples.length; off += vadSampleRate) await run.push(samples.slice(off, off + vadSampleRate));
        const analysis = await run.finish();
        run.release();
        const ms = performance.now() - t1;
        const mask = analysisMask(analysis);
        print(`${name}: ${analysis.chunkCount} cells (${vadChunkDuration * 1000} ms), speech cells ${mask.filter(Boolean).length}, regions ${fmt(analysis.segments)}  [${note}] in ${ms.toFixed(0)} ms for ${(samples.length / vadSampleRate).toFixed(0)} s audio`);
      }
      const ch = engine.channel();
      print(`model inputs: ${ch?.inputNames.join(", ")}; outputs: ${ch?.outputNames.join(", ")}`);
      engine.dispose();
    } catch (e) {
      print(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const status = sileroModelStatus;
  return (
    <div style={{ padding: "16px", "font-family": "monospace", color: "var(--text-primary, #ddd)" }}>
      <h3>Dead air / Silero VAD (onnxruntime-web)</h3>
      <button id="run" disabled={running()} onClick={() => void run()}>Download model + run VAD</button>
      <div id="status">model: {status().phase} {status().receivedBytes}/{status().totalBytes}</div>
      <Show when={status().phase === "downloading"}>
        <progress value={status().receivedBytes} max={status().totalBytes} />
      </Show>
      <pre id="log">{log().join("\n")}</pre>
    </div>
  );
}
