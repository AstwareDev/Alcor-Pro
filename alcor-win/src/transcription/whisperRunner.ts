// Whisper inference on onnxruntime-web: encoder, greedy decoder with a key/value cache, and word timing from the
// decoder's cross-attention. Runs inside the worker; takes the ort namespace so tests and benchmarks can pass their own.
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { rowStartTimes, timedWords, whisperFrameSeconds, type TimedWord } from "./whisperAlign";
import { WhisperMel, whisperSampleRate } from "./whisperMel";
import { isRepeating, splitWords, tokenBytesFromVocab, whisperTextTokenLimit, whisperTokens } from "./whisperTokens";

type Ort = typeof import("onnxruntime-web");

export interface WhisperAssets {
  encoder: ArrayBuffer;
  decoder: ArrayBuffer;
  /** vocab.json */
  vocab: ArrayBuffer;
  /** generation_config.json */
  generation: ArrayBuffer;
  /** config.json */
  config: ArrayBuffer;
}

export interface WindowResult {
  /** ISO 639-1 code used for the window. */
  language: string;
  /** Probability that the window holds no speech. */
  noSpeechProb: number;
  avgLogprob: number;
  /** Seconds from the start of the window. */
  words: TimedWord[];
}

interface GenerationConfig {
  alignment_heads: [number, number][];
  suppress_tokens: number[];
  begin_suppress_tokens: number[];
  lang_to_id: Record<string, number>;
}

interface ModelConfig {
  d_model: number;
  decoder_layers: number;
  decoder_attention_heads: number;
}

const maxNewTokens = 224;
const maxInitialTimestamp = 50;
const encoderFrames = 1500;
const silentRms = 1e-4;
const cacheNames = (layers: number): string[] =>
  Array.from({ length: layers }, (_, i) => [`${i}.decoder.key`, `${i}.decoder.value`, `${i}.encoder.key`, `${i}.encoder.value`]).flat();

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class WhisperRunner {
  private readonly mel = new WhisperMel();
  private readonly tokenBytes: Uint8Array[];
  private readonly languages: { code: string; id: number }[];
  private readonly suppressed = new Set<number>();
  private readonly names: string[];
  private scratch: Float32Array | undefined;

  private constructor(
    private readonly ort: Ort,
    private readonly encoder: InferenceSession,
    private readonly decoder: InferenceSession,
    private readonly gen: GenerationConfig,
    private readonly config: ModelConfig,
    vocab: Record<string, number>,
  ) {
    this.tokenBytes = tokenBytesFromVocab(vocab);
    this.languages = Object.entries(gen.lang_to_id).map(([tag, id]) => ({ code: tag.slice(2, -2), id }));
    for (const id of gen.suppress_tokens) this.suppressed.add(id);
    this.names = cacheNames(config.decoder_layers);
  }

  static async create(ort: Ort, assets: WhisperAssets, sessionOptions: InferenceSession.SessionOptions): Promise<WhisperRunner> {
    const text = (b: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(b));
    const [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(new Uint8Array(assets.encoder), sessionOptions),
      ort.InferenceSession.create(new Uint8Array(assets.decoder), sessionOptions),
    ]);
    return new WhisperRunner(ort, encoder, decoder, text(assets.generation) as GenerationConfig, text(assets.config) as ModelConfig, text(assets.vocab) as Record<string, number>);
  }

  private tensor(data: Float32Array, dims: number[]): Tensor {
    return new this.ort.Tensor("float32", data, dims);
  }

  /** One decoder pass; `past` is the key/value cache of the previous passes (none on the first). */
  private runDecoder(ids: number[], hidden: Tensor, past: Map<string, Tensor> | undefined): Promise<Record<string, Tensor>> {
    const heads = this.config.decoder_attention_heads;
    const headDim = this.config.d_model / heads;
    const feeds: Record<string, Tensor> = {
      input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      encoder_hidden_states: hidden,
      use_cache_branch: new this.ort.Tensor("bool", [past !== undefined], [1]),
    };
    for (const n of this.names) feeds[`past_key_values.${n}`] = past?.get(n) ?? this.tensor(new Float32Array(0), [1, heads, 0, headDim]);
    return this.decoder.run(feeds) as Promise<Record<string, Tensor>>;
  }

  /** The cache after a pass; with a cache the cross-attention key/values come back empty, so the first ones are kept. */
  private nextCache(out: Record<string, Tensor>, past: Map<string, Tensor> | undefined): Map<string, Tensor> {
    const next = new Map<string, Tensor>();
    for (const n of this.names) next.set(n, past !== undefined && n.includes("encoder") ? (past.get(n) as Tensor) : (out[`present.${n}`] as Tensor));
    return next;
  }

  /** Transcribes up to 30 s of 16 kHz mono audio. */
  async transcribeWindow(samples: Float32Array, language?: string): Promise<WindowResult> {
    const fallback = language ?? "en";
    if (samples.length < whisperSampleRate / 10 || rms(samples) < silentRms) {
      return { language: fallback, noSpeechProb: 1, avgLogprob: 0, words: [] };
    }
    const features = this.mel.compute(samples);
    const enc = await this.encoder.run({ input_features: this.tensor(features, [1, 80, 3000]) });
    const hidden = enc.last_hidden_state as Tensor;

    const lang = this.languages.find((l) => l.code === language) ?? (await this.detectLanguage(hidden));
    const prompt = [whisperTokens.sot, (lang as { id: number }).id, whisperTokens.transcribe];
    const code = (lang as { code: string }).code;

    const alignHeads = this.gen.alignment_heads;
    const rows: Float32Array[][] = alignHeads.map(() => []);
    const frames = Math.min(encoderFrames, Math.max(1, Math.ceil(samples.length / 320)));
    const collect = (out: Record<string, Tensor>): void => {
      alignHeads.forEach(([layer, head], h) => {
        const t = out[`cross_attentions.${layer}`] as Tensor;
        const lq = t.dims[2] as number;
        const keys = t.dims[3] as number;
        const base = (head * lq + lq - 1) * keys;
        (rows[h] as Float32Array[]).push((t.data as Float32Array).slice(base, base + frames));
      });
    };

    // Generated tokens are text and timestamp tokens: with the timestamps Whisper stays on track (without them it drifts or stops early).
    const tokens: number[] = [];
    let logprobSum = 0;
    let noSpeechProb = 0;
    let past: Map<string, Tensor> | undefined;
    let input = prompt;
    for (let step = 0; ; step++) {
      const out = await this.runDecoder(input, hidden, past);
      collect(out); // the last query row: the final prompt token on step 0 (it predicts the first token), then each token
      const logits = out.logits as Tensor;
      const vocab = logits.dims[2] as number;
      const data = logits.data as Float32Array;
      if (step === 0) noSpeechProb = softmaxAt(data, 0, vocab, whisperTokens.noSpeech);
      const pick = this.pick(data, ((logits.dims[1] as number) - 1) * vocab, vocab, tokens);
      logprobSum += pick.logprob;
      if (pick.id === whisperTokens.eot) break;
      tokens.push(pick.id);
      past = this.nextCache(out, past);
      if (tokens.length >= maxNewTokens || isRepeating(tokens)) {
        collect(await this.runDecoder([pick.id], hidden, past)); // the last token needs its own row too
        break;
      }
      input = [pick.id];
    }

    const text: number[] = [];
    const rowOf: number[] = [];
    tokens.forEach((id, i) => {
      if (id < whisperTextTokenLimit) {
        text.push(id);
        rowOf.push(i);
      }
    });
    if (text.length === 0) return { language: code, noSpeechProb, avgLogprob: 0, words: [] };
    const avgLogprob = logprobSum / (tokens.length + 1);
    const rowCount = tokens.length + 1;
    const matrices = rows.map((r) => {
      const m = new Float32Array(rowCount * frames);
      r.slice(0, rowCount).forEach((row, i) => m.set(row, i * frames));
      return m;
    });
    const starts = rowStartTimes(matrices, rowCount, frames);
    let at = 0;
    const spans = splitWords(text, this.tokenBytes, code).map((w) => {
      const from = rowOf[at] as number;
      at += w.tokens;
      return { text: w.text, from, to: (rowOf[at - 1] as number) + 1 };
    });
    const words = timedWords(spans, starts);
    // The last word of a segment ends where the model says the segment ends, not where the next word starts.
    spans.forEach((span, i) => {
      const closing = tokens[span.to];
      const w = words[i] as TimedWord;
      if (closing !== undefined && closing >= whisperTokens.timestampBegin) {
        w.end = Math.min(w.end, Math.max((closing - whisperTokens.timestampBegin) * whisperFrameSeconds, w.start + whisperFrameSeconds));
      }
    });
    return { language: code, noSpeechProb, avgLogprob, words };
  }

  private async detectLanguage(hidden: Tensor): Promise<{ code: string; id: number }> {
    const data = ((await this.runDecoder([whisperTokens.sot], hidden, undefined)).logits as Tensor).data as Float32Array;
    let best = this.languages[0] as { code: string; id: number };
    for (const l of this.languages) if ((data[l.id] as number) > (data[best.id] as number)) best = l;
    return best;
  }

  /** Greedy choice with the reference's suppression and timestamp rules (`ApplyTimestampRules`). */
  private pick(logits: Float32Array, offset: number, vocab: number, generated: readonly number[]): { id: number; logprob: number } {
    const row = (this.scratch ??= new Float32Array(vocab));
    row.set(logits.subarray(offset, offset + vocab));
    const stamp = whisperTokens.timestampBegin;
    row.fill(-Infinity, whisperTokens.eot + 1, stamp); // sot, languages, tasks, no-speech, no-timestamps
    for (const id of this.suppressed) row[id] = -Infinity;
    const last = generated[generated.length - 1];
    if (last === undefined) {
      for (const id of this.gen.begin_suppress_tokens) row[id] = -Infinity;
      row.fill(-Infinity, 0, stamp); // the first token is a timestamp, at most a second in
      row.fill(-Infinity, stamp + maxInitialTimestamp + 1);
    } else {
      const lastWasStamp = last >= stamp;
      const penultimateWasStamp = generated.length < 2 || (generated[generated.length - 2] as number) >= stamp;
      // Timestamps come in pairs (end of one segment, start of the next), except right before the end of text.
      if (lastWasStamp) {
        if (penultimateWasStamp) row.fill(-Infinity, stamp);
        else row.fill(-Infinity, 0, whisperTokens.eot);
      }
      let latest = -1;
      for (const id of generated) if (id >= stamp) latest = id;
      if (latest >= 0) row.fill(-Infinity, stamp, lastWasStamp && !penultimateWasStamp ? latest : latest + 1);
    }
    if (logSumExp(row, stamp, vocab) > maxOf(row, 0, stamp)) row.fill(-Infinity, 0, stamp); // timestamps outweigh any text token
    const z = logSumExp(row, 0, vocab);
    let best = 0;
    for (let i = 1; i < vocab; i++) if ((row[i] as number) > (row[best] as number)) best = i;
    return { id: best, logprob: (row[best] as number) - z };
  }
}

function maxOf(a: Float32Array, from: number, to: number): number {
  let max = -Infinity;
  for (let i = from; i < to; i++) if ((a[i] as number) > max) max = a[i] as number;
  return max;
}

function logSumExp(a: Float32Array, from: number, to: number): number {
  const max = maxOf(a, from, to);
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (let i = from; i < to; i++) sum += Math.exp((a[i] as number) - max);
  return max + Math.log(sum);
}

function softmaxAt(logits: Float32Array, offset: number, vocab: number, id: number): number {
  let max = -Infinity;
  for (let i = 0; i < vocab; i++) max = Math.max(max, logits[offset + i] as number);
  let sum = 0;
  for (let i = 0; i < vocab; i++) sum += Math.exp((logits[offset + i] as number) - max);
  return Math.exp((logits[offset + id] as number) - max) / sum;
}
