// Browser-only check of on-device transcription: `?dev=transcription`. Downloads the verified Whisper model (held in
// memory), transcribes an audio URL served by the dev server (default `/dev-speech.wav`, put any file in `public/`) in the
// real worker and prints speed and the first words with their timestamps.
import { createSignal, For } from "solid-js";
import type { MediaIo } from "../media/io";
import { whisperModel } from "../ml/modelCatalog";
import { ensureModel, modelStatus, type ModelSource } from "../ml/modelStore";
import { createLocalTranscriber } from "./localTranscription";

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
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(bytes.length, bytes.length);
    files.set(dest, bytes);
  },
};

export default function TranscriptionDev() {
  const [log, setLog] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [url, setUrl] = createSignal("/dev-speech.wav");
  const [seconds, setSeconds] = createSignal("");
  const say = (line: string): void => {
    setLog((l) => [...l, line]);
  };
  const status = modelStatus(whisperModel);

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

  const download = () => run("download", async () => {
    await ensureModel(whisperModel, browserSource);
    say(`model verified (${whisperModel.files.map((f) => `${f.fileName} sha256 ok`).join(", ")})`);
  });

  const transcribe = () => run("transcribe", async () => {
    const engine = createLocalTranscriber(browserSource);
    let last = -1;
    const t0 = performance.now();
    const duration = Number(seconds());
    const transcript = await engine.transcribe(url(), {
      ...(duration > 0 ? { durationSeconds: duration } : {}),
      onProgress: (f) => {
        const pct = Math.floor(f * 100);
        if (pct !== last && pct % 10 === 0) say(`  progress ${pct}% after ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        last = pct;
      },
    });
    engine.dispose();
    const end = transcript.words[transcript.words.length - 1]?.end ?? 0;
    say(`${transcript.words.length} words, language ${transcript.language ?? "?"}, last word ends at ${end.toFixed(1)} s`);
    say(transcript.words.slice(0, 30).map((w) => `${w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(" "));
  });

  return (
    <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "8px", "font-family": "var(--font-mono)", color: "var(--text-primary)" }}>
      <div>Model: {status().phase} {status().receivedBytes}/{status().totalBytes}</div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button disabled={busy()} onClick={() => void download()}>Download model</button>
        <input value={url()} onInput={(e) => setUrl(e.currentTarget.value)} size={30} aria-label="Audio URL" />
        <input value={seconds()} onInput={(e) => setSeconds(e.currentTarget.value)} placeholder="duration s" size={10} aria-label="Duration" />
        <button disabled={busy()} onClick={() => void transcribe()}>Transcribe</button>
      </div>
      <For each={log()}>{(l) => <div>{l}</div>}</For>
    </div>
  );
}
