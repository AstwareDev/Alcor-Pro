// Needs downloaded model files: WHISPER_DIR=<dir with encoder.onnx decoder.onnx vocab.json generation_config.json config.json>,
// WHISPER_WAV=<16 kHz mono 16-bit wav>, optional WHISPER_TEXT=<reference text>. Skipped otherwise.
import { describe, expect, it } from "vitest";
import { WhisperRunner } from "./whisperRunner";
// @ts-expect-error type error without @types/node package
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import { WindowSlicer, stitchWindows, type WindowWords } from "./whisperWindows";

const dir = process.env.WHISPER_DIR;
const wav = process.env.WHISPER_WAV;
const buf = (name: string): ArrayBuffer => {
  const b = readFileSync(`${dir}/${name}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!dir || !wav)("whisper on this machine", () => {
  it("transcribes a clip", { timeout: 3_600_000 }, async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.numThreads = 1;
    const t0 = performance.now();
    const runner = await WhisperRunner.create(
      ort,
      { encoder: buf(process.env.WHISPER_ENCODER ?? "encoder.onnx"), decoder: buf("decoder.onnx"), vocab: buf("vocab.json"), generation: buf("generation_config.json"), config: buf("config.json") },
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    );
    console.log(`load ${((performance.now() - t0) / 1000).toFixed(1)} s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    const pcm = readFileSync(wav as string);
    const i16 = new Int16Array(pcm.buffer, pcm.byteOffset + 44, (pcm.byteLength - 44) >> 1);
    const audio = Float32Array.from(i16, (v) => v / 32768);
    const slicer = new WindowSlicer();
    const windows = [...slicer.push(audio), ...slicer.finish()];
    const done: WindowWords[] = [];
    let language: string | undefined;
    let peak = 0;
    const t1 = performance.now();
    for (const w of windows) {
      const t = performance.now();
      const r = await runner.transcribeWindow(w.samples, language);
      language ??= r.language;
      peak = Math.max(peak, process.memoryUsage().rss);
      done.push({ start: w.startSample / 16000, end: (w.startSample + w.samples.length) / 16000, words: r.words });
      console.log(`window ${w.startSample / 16000}s: ${r.words.length} words, ${((performance.now() - t) / 1000).toFixed(1)} s, nospeech ${r.noSpeechProb.toFixed(2)}, lp ${r.avgLogprob.toFixed(2)}, ${r.language}`);
    }
    const sec = (performance.now() - t1) / 1000;
    const words = stitchWindows(done);
    console.log(`audio ${(audio.length / 16000).toFixed(1)} s in ${sec.toFixed(1)} s (${(audio.length / 16000 / sec).toFixed(2)}x realtime), peak rss ${(peak / 1e6).toFixed(0)} MB`);
    console.log(words.slice(0, 40).map((w) => `${w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(" "));
    if (process.env.WHISPER_OUT) writeFileSync(process.env.WHISPER_OUT, JSON.stringify(words));
    const ref = process.env.WHISPER_TEXT;
    if (ref) {
      const norm = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
      const a = norm(readFileSync(ref, "utf8"));
      const b = norm(words.map((w) => w.text).join(" "));
      const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      console.log(`WER ${((d[a.length]![b.length]! / a.length) * 100).toFixed(1)} % (${a.length} ref words, ${b.length} hyp words)`);
    }
    expect(words.length).toBeGreaterThan(0);
  });
});
