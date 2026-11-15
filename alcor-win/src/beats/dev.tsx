// Browser-only check of the ML pipelines: `?dev=beats`. Downloads the verified models (Hugging Face, sha256-checked, held in
// memory), runs Beat This! on a generated 120 BPM click track and DeepFilterNet3 on a noisy voiced-like signal.
import { createSignal, For } from "solid-js";
import { createBeatEngine } from "./beatEngine";
import { createDenoiseEngine } from "../denoise/denoiseEngine";
import { beatThisModel, deepFilterNet3Model } from "../ml/modelCatalog";
import { ensureModel, modelStatus, type ModelSource } from "../ml/modelStore";
import { wavHeader, interleaveFloat32 } from "../ml/wav";
import type { MediaIo } from "../media/io";

const files = new Map<string, Uint8Array>();
const io: MediaIo = {
  async stat(path) {
    const f = files.get(path);
    return f ? { name: path, path, isDir: false, size: f.length, modifiedMs: 0 } : null;
  },
  async list() { return []; },
  async writeBytes(path, bytes) { files.set(path, bytes); },
  async readHead(path, length) { return (files.get(path) ?? new Uint8Array(0)).subarray(0, length); },
  async readAll(path) {
    const f = files.get(path);
    if (!f) throw new Error(`missing ${path}`);
    return f;
  },
  async copy(from, to) { files.set(to, files.get(from) ?? new Uint8Array(0)); },
  async rename(from, to) {
    files.set(to, files.get(from) ?? new Uint8Array(0));
    files.delete(from);
  },
  async mkdir() {},
  async remove(path) { files.delete(path); },
  async cacheDir() { return "/cache"; },
  async tempDir() { return "/tmp"; },
};

const browserSource: ModelSource = {
  io: async () => io,
  modelsRoot: async () => "/models",
  async download(url, dest, onProgress) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
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
    files.set(dest, all);
  },
};

function wavUrl(samples: Float32Array, sampleRate: number): string {
  const bytes = interleaveFloat32([samples], 0, samples.length);
  return URL.createObjectURL(new Blob([wavHeader(samples.length, 1, sampleRate) as BlobPart, bytes as BlobPart], { type: "audio/wav" }));
}

/** 120 BPM clicks, accented downbeats every 4 beats: the signal BeatDetectorTests.swift uses. */
function clickTrack(seconds: number, sampleRate: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const x = new Float32Array(n);
  let index = 0;
  for (let t = 0; t < seconds; t += 0.5, index++) {
    const start = Math.round(t * sampleRate);
    const down = index % 4 === 0;
    const freq = down ? 1500 : 1000;
    const amp = down ? 1 : 0.6;
    for (let i = 0; i < Math.round(0.05 * sampleRate) && start + i < n; i++) {
      x[start + i] = (x[start + i] as number) + amp * Math.exp(-i / (0.01 * sampleRate)) * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return x.map((v) => (v / peak) * 0.9);
}

const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (v: number): number => 20 * Math.log10(Math.max(v, 1e-9));

export default function BeatsDev() {
  const [log, setLog] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const say = (line: string): void => {
    setLog((l) => [...l, line]);
  };
  const beatStatus = modelStatus(beatThisModel);
  const dfnStatus = modelStatus(deepFilterNet3Model);

  const run = async (name: string, work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    const t0 = performance.now();
    try {
      await work();
      say(`${name}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      say(`${name}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = () => run("download", async () => {
    await ensureModel(beatThisModel, browserSource);
    say(`beat models verified (${beatThisModel.files.map((f) => `${f.fileName} sha256 ok`).join(", ")})`);
    await ensureModel(deepFilterNet3Model, browserSource);
    say(`denoise models verified (${deepFilterNet3Model.files.map((f) => `${f.fileName} sha256 ok`).join(", ")})`);
  });

  const runBeats = () => run("beats", async () => {
    const engine = createBeatEngine(browserSource);
    const seconds = 35;
    const url = wavUrl(clickTrack(seconds, 44100), 44100);
    const analysis = await engine.detect(url, undefined, (f) => say(`  beats progress ${(f * 100).toFixed(0)}%`));
    engine.dispose();
    const truth: number[] = [];
    for (let t = 0.5; t <= seconds - 0.5; t += 0.5) truth.push(t);
    let worst = 0;
    for (const gt of truth) worst = Math.max(worst, Math.min(...analysis.beats.map((b) => Math.abs(b - gt))));
    say(`beats: ${analysis.beats.length} beats (truth ${truth.length + 1}), downbeats ${analysis.downbeats.length}, bpm ${analysis.bpm.toFixed(2)}, worst beat error ${(worst * 1000).toFixed(0)} ms`);
    say(`  first beats: ${analysis.beats.slice(0, 8).map((b) => b.toFixed(2)).join(", ")}`);
    say(`  first downbeats: ${analysis.downbeats.slice(0, 5).map((b) => b.toFixed(2)).join(", ")}`);
  });

  const runDenoise = () => run("denoise", async () => {
    const sr = 44100;
    const seconds = 6;
    const n = sr * seconds;
    const clean = new Float32Array(n);
    const noisy = new Float32Array(n);
    let seed = 12345;
    const rand = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const voiced: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const on = t % 1 < 0.6;
      voiced.push(on);
      const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
      const env = on ? Math.min(1, (t % 1) / 0.05) * Math.min(1, (0.6 - (t % 1)) / 0.05) : 0;
      clean[i] = 0.25 * v * env;
      noisy[i] = (clean[i] as number) + 0.06 * rand();
    }
    const engine = createDenoiseEngine(browserSource);
    const out = await engine.enhance(wavUrl(noisy, sr), undefined, (f) => say(`  denoise progress ${(f * 100).toFixed(0)}%`));
    engine.dispose();
    const plane = out.planes[0] as Float32Array;
    say(`denoise: output ${plane.length} samples at ${out.sampleRate} Hz (input ${n} at ${sr} Hz, expected ${Math.round((n * out.sampleRate) / sr)})`);
    // Compare in the 48 kHz domain at gap (noise only) and voiced stretches, away from transitions.
    const at = (s: number): number => Math.round(s * out.sampleRate);
    let gapIn = 0;
    let gapOut = 0;
    let k = 0;
    for (let sec = 0; sec < seconds; sec++) {
      gapIn += rms(noisy, Math.round((sec + 0.7) * sr), Math.round((sec + 0.95) * sr)) ** 2;
      gapOut += rms(plane, at(sec + 0.7), at(sec + 0.95)) ** 2;
      k++;
    }
    say(`denoise: noise-only gaps ${db(Math.sqrt(gapIn / k)).toFixed(1)} dBFS -> ${db(Math.sqrt(gapOut / k)).toFixed(1)} dBFS (${(db(Math.sqrt(gapIn / k)) - db(Math.sqrt(gapOut / k))).toFixed(1)} dB reduction)`);
    // Voiced SNR against the clean reference, resampled by index (both are time-aligned).
    let errIn = 0;
    let errOut = 0;
    let sig = 0;
    for (let i = Math.round(0.2 * sr); i < n - sr; i++) {
      if (!voiced[i] || !voiced[i - 4000] || !voiced[Math.min(n - 1, i + 4000)]) continue;
      const j = Math.min(plane.length - 1, Math.round((i * out.sampleRate) / sr));
      const c = clean[i] as number;
      sig += c * c;
      errIn += ((noisy[i] as number) - c) ** 2;
      errOut += ((plane[j] as number) - c) ** 2;
    }
    say(`denoise: voiced SNR ${(10 * Math.log10(sig / errIn)).toFixed(1)} dB -> ${(10 * Math.log10(sig / errOut)).toFixed(1)} dB (synthetic harmonic signal; DeepFilterNet is trained for speech)`);
  });

  const pct = (s: { receivedBytes: number; totalBytes: number }): string => `${((100 * s.receivedBytes) / s.totalBytes).toFixed(0)}%`;
  return (
    <div style={{ padding: "16px", color: "var(--text-primary)", "font-size": "13px", "font-family": "monospace" }}>
      <div style={{ display: "flex", gap: "8px", "margin-bottom": "12px" }}>
        <button disabled={busy()} onClick={downloadAll}>Download + verify models</button>
        <button disabled={busy()} onClick={runBeats}>Run beats (click track)</button>
        <button disabled={busy()} onClick={runDenoise}>Run denoise (noisy tone)</button>
      </div>
      <div id="status">beat model: {beatStatus().phase} {pct(beatStatus())} | denoise model: {dfnStatus().phase} {pct(dfnStatus())}</div>
      <pre id="log"><For each={log()}>{(line) => <div>{line}</div>}</For></pre>
    </div>
  );
}
