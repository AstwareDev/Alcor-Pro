// On-device transcription: decode the audio, resample to 16 kHz mono, run Whisper over overlapping 30 s windows in a
// worker and stitch the words back into source time. The worker (and its ~0.5 GB of model memory) is dropped after a
// minute of inactivity; the model files stay on disk.
import type { Transcript, TranscribeOptions } from "../generation/providers/transcription";
import { AsyncSemaphore, throwIfAborted } from "../media/concurrency";
import { tauriModelSource } from "../deadair/sileroModel";
import { mixDown, readAudioChunks } from "../ml/audioReader";
import { whisperModel } from "../ml/modelCatalog";
import { loadModelBuffers, type ModelSource } from "../ml/modelStore";
import { StreamResampler } from "../ml/resample";
import { WorkerChannel } from "../ml/workerChannel";
import { whisperSampleRate } from "./whisperMel";
import type { WindowResult } from "./whisperRunner";
import { WindowSlicer, stitchWindows, type AudioWindow, type WindowWords } from "./whisperWindows";
import type { WhisperReply, WhisperRequest } from "./whisperWorker";

const idleMs = 60_000;

/** Whisper's own rule: a window it thinks is silence and decoded with low confidence is a hallucination. */
export function windowIsSilence(r: Pick<WindowResult, "noSpeechProb" | "avgLogprob">): boolean {
  return r.noSpeechProb > 0.6 && r.avgLogprob < -1;
}

export interface LocalTranscriber {
  transcribe(path: string, options?: TranscribeOptions, signal?: AbortSignal): Promise<Transcript>;
  dispose(): void;
}

type Channel = WorkerChannel<WhisperRequest, WhisperReply>;

export function createLocalTranscriber(source: ModelSource = tauriModelSource): LocalTranscriber {
  const gate = new AsyncSemaphore(1);
  let channel: Channel | undefined;
  let ready: Promise<Channel> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const drop = (): void => {
    clearTimeout(idle);
    channel?.terminate();
    channel = undefined;
    ready = undefined;
  };

  const open = async (): Promise<Channel> => {
    const [encoder, decoder, vocab, generation, config] = (await loadModelBuffers(whisperModel, source)) as [ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer, ArrayBuffer];
    const ch: Channel = new WorkerChannel(new Worker(new URL("./whisperWorker.ts", import.meta.url), { type: "module" }));
    try {
      await ch.request({ type: "init", encoder, decoder, vocab, generation, config }, [encoder, decoder, vocab, generation, config]);
    } catch (e) {
      ch.terminate();
      throw e;
    }
    channel = ch;
    return ch;
  };

  return {
    dispose: drop,
    async transcribe(path, options = {}, signal) {
      await gate.wait(signal);
      clearTimeout(idle);
      try {
        ready ??= open().catch((e: unknown) => {
          ready = undefined;
          throw e;
        });
        const ch = await ready;
        throwIfAborted(signal);
        // A cancelled run leaves the worker mid-window: drop it, the next call starts a fresh one.
        signal?.addEventListener("abort", drop, { once: true });
        try {
          return await run(ch, path, options, signal);
        } finally {
          signal?.removeEventListener("abort", drop);
        }
      } finally {
        idle = setTimeout(drop, idleMs);
        gate.signal();
      }
    },
  };
}

async function run(ch: Channel, path: string, options: TranscribeOptions, signal: AbortSignal | undefined): Promise<Transcript> {
  const slicer = new WindowSlicer();
  const done: WindowWords[] = [];
  let language = options.language;
  const totalSamples = options.durationSeconds !== undefined ? options.durationSeconds * whisperSampleRate : 0;

  const transcribe = async (w: AudioWindow): Promise<void> => {
    throwIfAborted(signal);
    const length = w.samples.length;
    const reply = await ch.request({ type: "window", samples: w.samples, ...(language !== undefined ? { language } : {}) }, [w.samples.buffer]);
    if (reply.type !== "window") throw new Error("Unexpected Whisper worker reply.");
    const r = reply.result;
    const silent = windowIsSilence(r);
    if (language === undefined && !silent && r.words.length > 0) language = r.language;
    const start = w.startSample / whisperSampleRate;
    done.push({ start, end: start + length / whisperSampleRate, words: silent ? [] : r.words });
    if (totalSamples > 0) options.onProgress?.(Math.min(0.99, (w.startSample + length) / totalSamples));
  };

  let resampler: StreamResampler | undefined;
  await readAudioChunks(path, 2, signal, async (chunk) => {
    const mono = mixDown(chunk.planes);
    let samples = mono;
    if (chunk.sampleRate !== whisperSampleRate) {
      resampler ??= new StreamResampler(chunk.sampleRate, whisperSampleRate);
      samples = resampler.push(mono);
    }
    for (const w of slicer.push(samples)) await transcribe(w);
  });
  if (resampler) for (const w of slicer.push(resampler.flush())) await transcribe(w);
  for (const w of slicer.finish()) await transcribe(w);

  const words = stitchWindows(done);
  options.onProgress?.(1);
  return {
    text: words.map((w) => w.text).join(" "),
    ...(language !== undefined ? { language } : {}),
    words,
  };
}

let shared: LocalTranscriber | undefined;

/** The app-wide transcriber (worker and model are created on first use). */
export function sharedLocalTranscriber(): LocalTranscriber {
  shared ??= createLocalTranscriber();
  return shared;
}
