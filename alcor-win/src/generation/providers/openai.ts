import type { HttpAuth, HttpBody, Part } from "../../platform/backend";
import {
  ProviderError, contentTypeOf, decodeRef, downloadTo, encodeRef, errorFromStatus, fileName, isRecord, send, sendJson, sizeForAspect, str,
  tempOutputPath, writeBase64Temp,
} from "./common";
import type { Transcript, TranscribeOptions, TranscriptWord } from "./transcription";
import type { AudioParams, CatalogEntry, GenerationParams, ImageParams, JobHandle, JobState, Provider } from "./types";

// Docs: https://developers.openai.com/api/reference/resources/images/methods/generate (+ /edit),
// .../audio/subresources/speech/methods/create, .../audio/subresources/transcriptions/methods/create

const auth: HttpAuth = { secret: "openai", header: "Authorization", prefix: "Bearer " };
const API = "https://api.openai.com";
const docsImages = "https://developers.openai.com/api/reference/resources/images/methods/generate";
const docsSpeech = "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create";

/** Built-in voices listed in the speech reference. */
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"];
const TTS_MAX_CHARS = 4096;

const imageEntry = (id: string, displayName: string, description: string, aspectRatios: string[], resolutions?: string[]): CatalogEntry => ({
  id: `openai/${id}`, providerId: "openai", displayName, providerIconKey: "openai", providerName: "OpenAI", description,
  responseShape: "images", docsUrl: docsImages, kind: "image",
  uiCapabilities: { aspectRatios, ...(resolutions ? { resolutions } : {}), qualities: ["low", "medium", "high"], supportsImageReference: true, maxImages: 10 },
});

const ttsEntry = (id: string, displayName: string, instructions: boolean): CatalogEntry => ({
  id: `openai/${id}`, providerId: "openai", displayName, providerIconKey: "openai", providerName: "OpenAI",
  description: "Text to speech with built-in voices.", responseShape: "audio", docsUrl: docsSpeech, kind: "audio",
  uiCapabilities: {
    category: "tts", voices: VOICES, defaultVoice: "alloy", supportsLyrics: false, supportsInstrumental: false,
    supportsStyleInstructions: instructions, minPromptLength: 1, inputs: ["text"], promptLabel: "Text to speak",
  },
});

export const openAICatalog: readonly CatalogEntry[] = [
  imageEntry("gpt-image-2", "GPT Image 2", "OpenAI image generation and editing from references.", ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"], ["1K", "2K"]),
  imageEntry("gpt-image-1.5", "GPT Image 1.5", "OpenAI image generation and editing (fixed sizes).", ["1:1", "3:2", "2:3"]),
  ttsEntry("gpt-4o-mini-tts", "GPT-4o mini TTS", true),
  ttsEntry("tts-1", "OpenAI TTS", false),
];

const FIXED_SIZES: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
const PIXELS: Record<string, number> = { "1K": 1024 * 1024, "2K": 2048 * 2048 };

export function imageSize(modelId: string, aspect: string, resolution?: string): string {
  if (modelId === "gpt-image-2") {
    const { width, height } = sizeForAspect(aspect, PIXELS[resolution ?? "1K"] ?? PIXELS["1K"] ?? 1048576, 16);
    return `${width}x${height}`;
  }
  const fixed = FIXED_SIZES[aspect];
  if (!fixed) throw new ProviderError("invalid_input", `${modelId} supports only 1:1, 3:2 and 2:3.`);
  return fixed;
}

export interface OpenAIRequest {
  url: string;
  body: HttpBody;
  kind: "images" | "speech";
}

function textPart(name: string, value: string): Part {
  return { name, value: { kind: "text", value } };
}

export function buildOpenAIRequest(model: CatalogEntry, params: GenerationParams): OpenAIRequest {
  const id = model.id.replace(/^openai\//, "");
  if (model.kind === "image") {
    if (params.kind !== "image") throw new ProviderError("invalid_input", "Expected image parameters.");
    return buildImage(id, params);
  }
  if (params.kind !== "audio") throw new ProviderError("invalid_input", "Expected audio parameters.");
  return buildSpeech(id, params);
}

function buildImage(id: string, p: ImageParams): OpenAIRequest {
  const size = imageSize(id, p.aspectRatio, p.resolution);
  const n = Math.min(10, Math.max(1, p.numImages));
  if (p.images.length === 0) {
    const value: Record<string, unknown> = { model: id, prompt: p.prompt, size, n, output_format: "png" };
    if (p.quality) value.quality = p.quality;
    return { kind: "images", url: `${API}/v1/images/generations`, body: { kind: "json", value } };
  }
  const parts: Part[] = [textPart("model", id), textPart("prompt", p.prompt), textPart("size", size), textPart("n", String(n)), textPart("output_format", "png")];
  if (p.quality) parts.push(textPart("quality", p.quality));
  for (const ref of p.images.slice(0, 16)) {
    parts.push({ name: "image[]", filename: fileName(ref.path), contentType: contentTypeOf(ref), value: { kind: "file", path: ref.path } });
  }
  return { kind: "images", url: `${API}/v1/images/edits`, body: { kind: "multipart", parts } };
}

function buildSpeech(id: string, p: AudioParams): OpenAIRequest {
  if (p.prompt.length > TTS_MAX_CHARS) throw new ProviderError("invalid_input", `OpenAI speech accepts at most ${TTS_MAX_CHARS} characters of text.`);
  const value: Record<string, unknown> = { model: id, input: p.prompt, voice: p.voice ?? "alloy", response_format: "mp3" };
  if (id !== "tts-1" && p.styleInstructions?.trim()) value.instructions = p.styleInstructions.trim();
  return { kind: "speech", url: `${API}/v1/audio/speech`, body: { kind: "json", value } };
}

/** `data[].b64_json` from an ImagesResponse. */
export function parseImageResponse(body: unknown): string[] {
  const data = isRecord(body) ? body.data : undefined;
  const out = Array.isArray(data) ? data.flatMap((d) => (isRecord(d) && typeof d.b64_json === "string" ? [d.b64_json] : [])) : [];
  if (!out.length) throw new ProviderError("provider_error", "OpenAI returned no image data.");
  return out;
}

type Ref = { paths: string[] };

async function submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  const req = buildOpenAIRequest(model, params);
  const paths: string[] = [];
  if (req.kind === "speech") {
    paths.push(await downloadTo("OpenAI", { url: req.url, method: "POST", auth, body: req.body, timeoutMs: 5 * 60_000 }, await tempOutputPath("mp3"), signal));
  } else {
    const res = await sendJson<unknown>("OpenAI", { url: req.url, method: "POST", auth, body: req.body, timeoutMs: 10 * 60_000 }, signal);
    for (const b64 of parseImageResponse(res)) paths.push(await writeBase64Temp(b64, "png"));
  }
  const ref: Ref = { paths };
  return { providerId: "openai", modelId: model.id, ref: encodeRef(ref) };
}

async function status(job: JobHandle): Promise<JobState> {
  return { status: "succeeded", outputs: decodeRef<Ref>(job).paths.map((path) => ({ path })) };
}

/** whisper-1 with `verbose_json` is the documented route to word timestamps (`timestamp_granularities[]=word`). */
export function parseWhisper(body: unknown): Transcript {
  if (!isRecord(body) || typeof body.text !== "string") throw new ProviderError("provider_error", "OpenAI returned an unexpected transcript.");
  const words: TranscriptWord[] = [];
  for (const w of Array.isArray(body.words) ? body.words : []) {
    if (isRecord(w) && typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number") {
      words.push({ text: w.word, start: w.start, end: w.end });
    }
  }
  const language = str(body.language);
  return { text: body.text, words, ...(language ? { language } : {}) };
}

export async function transcribe(path: string, options: TranscribeOptions = {}, signal?: AbortSignal): Promise<Transcript> {
  const parts: Part[] = [
    { name: "file", filename: fileName(path), value: { kind: "file", path } },
    textPart("model", "whisper-1"),
    textPart("response_format", "verbose_json"),
    textPart("timestamp_granularities[]", "word"),
  ];
  if (options.language) parts.push(textPart("language", options.language));
  const res = await send("OpenAI", { url: `${API}/v1/audio/transcriptions`, method: "POST", auth, body: { kind: "multipart", parts }, timeoutMs: 30 * 60_000 }, signal);
  if (res.status < 200 || res.status >= 300) throw errorFromStatus("OpenAI", res.status, res.bodyText, res.headers);
  try {
    return parseWhisper(JSON.parse(res.bodyText));
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("provider_error", "OpenAI returned an invalid transcript.");
  }
}

async function checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await sendJson<unknown>("OpenAI", { url: `${API}/v1/models`, auth }, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Key check failed." };
  }
}

export const openAIProvider: Provider = {
  id: "openai",
  displayName: "OpenAI",
  secretName: "openai",
  keyUrl: "https://platform.openai.com/api-keys",
  catalog: openAICatalog,
  checkKey,
  submit,
  status,
};
