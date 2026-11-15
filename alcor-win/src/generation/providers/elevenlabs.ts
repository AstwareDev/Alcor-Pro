import type { HttpAuth, HttpBody, Part } from "../../platform/backend";
import {
  ProviderError, contentTypeOf, decodeRef, downloadTo, encodeRef, errorFromStatus, fileName, isRecord, send, sendJson, str, tempOutputPath,
} from "./common";
import type { Transcript, TranscribeOptions, TranscriptWord } from "./transcription";
import type { AudioCaps, AudioParams, CatalogEntry, GenerationParams, JobHandle, JobState, LocalReference, Provider } from "./types";

// Docs: https://elevenlabs.io/docs/api-reference/  (text-to-speech/convert, text-to-sound-effects/convert, music/compose,
// speech-to-speech/convert, dubbing/create|get, dubbing/audio/get, speech-to-text/convert, voices/search, models/list)

const auth: HttpAuth = { secret: "elevenlabs", header: "xi-api-key", prefix: "" };
const API = "https://api.elevenlabs.io";
const OUTPUT_FORMAT = "mp3_44100_128";

const docsTts = "https://elevenlabs.io/docs/api-reference/text-to-speech/convert";
const docsSfx = "https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert";
const docsMusic = "https://elevenlabs.io/docs/api-reference/music/compose";
const docsSts = "https://elevenlabs.io/docs/api-reference/speech-to-speech/convert";
const docsDub = "https://elevenlabs.io/docs/api-reference/dubbing/create";

const base = { supportsLyrics: false, supportsInstrumental: false, supportsStyleInstructions: false, minPromptLength: 1 };
const entry = (id: string, displayName: string, description: string, docsUrl: string, uiCapabilities: AudioCaps): CatalogEntry => ({
  id: `elevenlabs/${id}`, providerId: "elevenlabs", displayName, providerIconKey: "elevenlabs", providerName: "ElevenLabs", description,
  responseShape: "audio", docsUrl, kind: "audio", uiCapabilities,
});

/** ISO 639-1 codes accepted by `target_lang` (documented as ISO 639-1 or 639-3). */
const DUB_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "pl", "nl", "sv", "ru", "uk", "tr", "ar", "hi", "id", "ja", "ko", "zh"];

export const elevenLabsCatalog: readonly CatalogEntry[] = [
  entry("eleven_multilingual_v2", "ElevenLabs Multilingual v2", "Text to speech. Pick any voice from your account.", docsTts,
    { category: "tts", ...base, supportsMultilingual: true, promptLabel: "Text to speak", inputs: ["text"] }),
  entry("eleven_text_to_sound_v2", "ElevenLabs Sound Effects v2", "Sound effects from a text description.", docsSfx,
    { category: "sfx", ...base, durationRange: { minimum: 1, maximum: 30, defaultValue: 5 }, promptLabel: "Describe the sound" }),
  entry("eleven_text_to_sound_v3", "ElevenLabs Sound Effects v3", "Sound effects from a text description.", docsSfx,
    { category: "sfx", ...base, durationRange: { minimum: 1, maximum: 30, defaultValue: 5 }, promptLabel: "Describe the sound" }),
  entry("music_v1", "ElevenLabs Music", "Music from a prompt, optionally with lyrics. Needs a paid ElevenLabs plan.", docsMusic,
    { category: "music", ...base, supportsLyrics: true, supportsInstrumental: true, durationRange: { minimum: 3, maximum: 600, defaultValue: 30 }, promptLabel: "Describe the music" }),
  entry("music_v2_5", "ElevenLabs Music 2.5", "Music from a prompt, optionally with lyrics. Needs a paid ElevenLabs plan.", docsMusic,
    { category: "music", ...base, supportsLyrics: true, supportsInstrumental: true, durationRange: { minimum: 3, maximum: 600, defaultValue: 30 }, promptLabel: "Describe the music" }),
  entry("eleven_multilingual_sts_v2", "ElevenLabs Voice Changer", "Re-voice a recording with another voice.", docsSts,
    { category: "general", ...base, minPromptLength: 0, inputs: ["audio"], promptLabel: "Voice changer", maxSeconds: 300 }),
  entry("dubbing", "ElevenLabs Dubbing", "Translate and dub a video or audio file.", docsDub,
    { category: "dubbing", ...base, minPromptLength: 0, inputs: ["audio", "video"], targetLanguages: DUB_LANGUAGES, defaultTargetLanguage: "es" }),
];

export interface ElevenLabsRequest {
  kind: "sync" | "dub";
  url: string;
  body: HttpBody;
  /** Output file extension for sync requests. */
  ext: string;
}

const need = (ref: LocalReference | undefined, what: string): LocalReference => {
  if (!ref) throw new ProviderError("invalid_input", `${what} is required.`);
  return ref;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function filePart(name: string, ref: LocalReference): Part {
  return { name, filename: fileName(ref.path), contentType: contentTypeOf(ref), value: { kind: "file", path: ref.path } };
}
const textPart = (name: string, value: string): Part => ({ name, value: { kind: "text", value } });

/** Pure mapping from catalog entry + params to the HTTP request. */
export function buildElevenLabsRequest(model: CatalogEntry, params: GenerationParams): ElevenLabsRequest {
  if (params.kind !== "audio") throw new ProviderError("invalid_input", "ElevenLabs only serves audio models.");
  const p: AudioParams = params;
  const id = model.id.replace(/^elevenlabs\//, "");
  const q = `output_format=${OUTPUT_FORMAT}`;
  switch (id) {
    case "eleven_multilingual_v2":
      if (!p.voice) throw new ProviderError("invalid_input", "Choose a voice first.");
      return {
        kind: "sync", ext: "mp3", url: `${API}/v1/text-to-speech/${encodeURIComponent(p.voice)}?${q}`,
        body: { kind: "json", value: { text: p.prompt, model_id: id } },
      };
    case "eleven_text_to_sound_v2":
    case "eleven_text_to_sound_v3": {
      const value: Record<string, unknown> = { text: p.prompt, model_id: id };
      if (p.durationSeconds !== undefined) value.duration_seconds = clamp(p.durationSeconds, 0.5, 30);
      return { kind: "sync", ext: "mp3", url: `${API}/v1/sound-generation?${q}`, body: { kind: "json", value } };
    }
    case "music_v1":
    case "music_v2_5": {
      const prompt = p.lyrics?.trim() ? `${p.prompt}\n\nLyrics:\n${p.lyrics.trim()}` : p.prompt;
      const value: Record<string, unknown> = { prompt, model_id: id, force_instrumental: p.instrumental };
      if (p.durationSeconds !== undefined) value.music_length_ms = clamp(Math.round(p.durationSeconds * 1000), 3000, 600000);
      return { kind: "sync", ext: "mp3", url: `${API}/v1/music?${q}`, body: { kind: "json", value } };
    }
    case "eleven_multilingual_sts_v2":
      if (!p.voice) throw new ProviderError("invalid_input", "Choose a target voice first.");
      return {
        kind: "sync", ext: "mp3", url: `${API}/v1/voice-changer/${encodeURIComponent(p.voice)}?${q}`,
        body: { kind: "multipart", parts: [filePart("audio", need(p.source, "A source recording")), textPart("model_id", id)] },
      };
    case "dubbing": {
      const source = need(p.source ?? p.video, "A source file");
      if (!p.targetLanguage) throw new ProviderError("invalid_input", "Choose a target language.");
      return {
        kind: "dub", ext: source.type === "video" ? "mp4" : "mp3", url: `${API}/v1/dubbing`,
        body: { kind: "multipart", parts: [filePart("file", source), textPart("target_lang", p.targetLanguage)] },
      };
    }
  }
  throw new ProviderError("invalid_input", `Unknown ElevenLabs model '${id}'.`);
}

/** The Music API is paid-only (https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music); a free key gets an auth or billing refusal. */
export function explainMusicRefusal(model: CatalogEntry, e: unknown): unknown {
  const isMusic = model.id.startsWith("elevenlabs/music_");
  if (!isMusic || !(e instanceof ProviderError) || (e.code !== "auth" && e.code !== "quota")) return e;
  return new ProviderError(
    e.code,
    `ElevenLabs only allows music generation through the API on paid plans, so a free-tier key is refused. Upgrade your ElevenLabs plan, or pick another music model in the prompt bar's settings. (${e.message})`,
    e.retryAfterMs,
  );
}

type Ref = { kind: "file"; path: string } | { kind: "dub"; id: string; lang: string; ext: string };

async function submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  const req = buildElevenLabsRequest(model, params);
  if (req.kind === "sync") {
    const path = await downloadTo("ElevenLabs", { url: req.url, method: "POST", auth, body: req.body, timeoutMs: 10 * 60_000 }, await tempOutputPath(req.ext), signal)
      .catch((e: unknown) => { throw explainMusicRefusal(model, e); });
    const ref: Ref = { kind: "file", path };
    return { providerId: "elevenlabs", modelId: model.id, ref: encodeRef(ref) };
  }
  const res = await sendJson<unknown>("ElevenLabs", { url: req.url, method: "POST", auth, body: req.body, timeoutMs: 10 * 60_000 }, signal);
  const id = isRecord(res) ? str(res.dubbing_id) : undefined;
  if (!id) throw new ProviderError("provider_error", "ElevenLabs did not return a dubbing id.");
  const lang = params.kind === "audio" ? (params.targetLanguage ?? "") : "";
  const ref: Ref = { kind: "dub", id, lang, ext: req.ext };
  return { providerId: "elevenlabs", modelId: model.id, ref: encodeRef(ref) };
}

/** `status` values: "dubbed" is documented; any other non-failed value is treated as in progress. */
export function parseDubbingStatus(body: unknown): { state: "running" | "done" | "failed"; error?: string } {
  if (!isRecord(body)) throw new ProviderError("provider_error", "ElevenLabs returned an unexpected dubbing payload.");
  const error = str(body.error);
  if (error || body.status === "failed") return { state: "failed", error: error ?? "Dubbing failed." };
  return { state: body.status === "dubbed" ? "done" : "running" };
}

async function status(job: JobHandle, signal?: AbortSignal): Promise<JobState> {
  const ref = decodeRef<Ref>(job);
  if (ref.kind === "file") return { status: "succeeded", outputs: [{ path: ref.path }] };
  const st = parseDubbingStatus(await sendJson<unknown>("ElevenLabs", { url: `${API}/v1/dubbing/${encodeURIComponent(ref.id)}`, auth }, signal));
  if (st.state === "failed") return { status: "failed", errorMessage: st.error ?? "Dubbing failed.", code: "provider_error" };
  if (st.state === "running") return { status: "running" };
  const dest = await tempOutputPath(ref.ext, `dub-${ref.id}-${ref.lang}`);
  await downloadTo("ElevenLabs", { url: `${API}/v1/dubbing/${encodeURIComponent(ref.id)}/audio/${encodeURIComponent(ref.lang)}`, auth, timeoutMs: 10 * 60_000 }, dest, signal);
  return { status: "succeeded", outputs: [{ path: dest }] };
}

export async function listVoices(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qs = `page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ""}&include_total_count=false`;
    const res = await sendJson<unknown>("ElevenLabs", { url: `${API}/v2/voices?${qs}`, auth }, signal);
    if (!isRecord(res) || !Array.isArray(res.voices)) throw new ProviderError("provider_error", "ElevenLabs returned an unexpected voices payload.");
    for (const v of res.voices) {
      if (isRecord(v) && typeof v.voice_id === "string") out.push({ id: v.voice_id, name: str(v.name) ?? v.voice_id });
    }
    token = isRecord(res) && res.has_more === true ? str(res.next_page_token) : undefined;
    if (!token) break;
  }
  return out;
}

/** Normalises a Scribe response; keeps `word` items only (drops spacing and audio events). */
export function parseScribe(body: unknown): Transcript {
  if (!isRecord(body) || typeof body.text !== "string") throw new ProviderError("provider_error", "ElevenLabs returned an unexpected transcript.");
  const words: TranscriptWord[] = [];
  for (const w of Array.isArray(body.words) ? body.words : []) {
    if (!isRecord(w) || w.type !== "word" || typeof w.text !== "string" || typeof w.start !== "number" || typeof w.end !== "number") continue;
    const speaker = str(w.speaker_id);
    words.push({ text: w.text, start: w.start, end: w.end, ...(speaker ? { speakerId: speaker } : {}) });
  }
  const language = str(body.language_code);
  return { text: body.text, words, ...(language ? { language } : {}) };
}

/** Speech to text with word timestamps (captions feature). */
export async function transcribe(path: string, options: TranscribeOptions = {}, signal?: AbortSignal): Promise<Transcript> {
  const parts: Part[] = [
    textPart("model_id", "scribe_v2"),
    textPart("timestamps_granularity", "word"),
    { name: "file", filename: fileName(path), value: { kind: "file", path } },
  ];
  if (options.language) parts.push(textPart("language_code", options.language));
  if (options.diarize) parts.push(textPart("diarize", "true"));
  const res = await send("ElevenLabs", { url: `${API}/v1/speech-to-text`, method: "POST", auth, body: { kind: "multipart", parts }, timeoutMs: 30 * 60_000 }, signal);
  if (res.status < 200 || res.status >= 300) throw errorFromStatus("ElevenLabs", res.status, res.bodyText, res.headers);
  try {
    return parseScribe(JSON.parse(res.bodyText));
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("provider_error", "ElevenLabs returned an invalid transcript.");
  }
}

async function checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await sendJson<unknown>("ElevenLabs", { url: `${API}/v1/models`, auth }, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Key check failed." };
  }
}

export const elevenLabsProvider: Provider = {
  id: "elevenlabs",
  displayName: "ElevenLabs",
  secretName: "elevenlabs",
  keyUrl: "https://elevenlabs.io/app/settings/api-keys",
  catalog: elevenLabsCatalog,
  checkKey,
  submit,
  status,
  listVoices,
};
