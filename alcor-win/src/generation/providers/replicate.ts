import type { HttpAuth } from "../../platform/backend";
import { ProviderError, decodeRef, downloadTo, encodeRef, isRecord, send, sendJson, sizeForAspect, str, tempOutputPath } from "./common";
import type { AudioParams, CatalogEntry, GenerationParams, ImageParams, JobHandle, JobOutput, JobState, Provider } from "./types";

// Docs: https://replicate.com/docs/reference/http (official-model predictions), model schemas from
// https://replicate.com/<owner>/<name>/llms.txt. Only inputs listed in those schemas are sent.

const auth: HttpAuth = { secret: "replicate", header: "Authorization", prefix: "Bearer " };
const API = "https://api.replicate.com";

export const replicateCatalog: readonly CatalogEntry[] = [
  {
    id: "replicate/black-forest-labs/flux-2-pro", providerId: "replicate", displayName: "FLUX.2 Pro (Replicate)", providerIconKey: "blackforestlabs",
    providerName: "Black Forest Labs", description: "FLUX.2 Pro text-to-image at any aspect ratio (about 1 MP).",
    responseShape: "images", docsUrl: "https://replicate.com/black-forest-labs/flux-2-pro", kind: "image",
    uiCapabilities: { aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], supportsImageReference: false, maxImages: 1 },
  },
  {
    id: "replicate/minimax/music-1.5", providerId: "replicate", displayName: "MiniMax Music 1.5 (Replicate)", providerIconKey: "minimax",
    providerName: "MiniMax", description: "Song generation from a style prompt and lyrics.",
    responseShape: "audio", docsUrl: "https://replicate.com/minimax/music-1.5", kind: "audio",
    uiCapabilities: {
      category: "music", supportsLyrics: true, supportsInstrumental: false, supportsStyleInstructions: false, minPromptLength: 1,
      promptLabel: "Describe the style", inputs: ["text"],
    },
  },
];

export interface ReplicateRequest {
  url: string;
  input: Record<string, unknown>;
}

export function buildReplicateRequest(model: CatalogEntry, params: GenerationParams): ReplicateRequest {
  const slug = model.id.replace(/^replicate\//, "");
  const url = `${API}/v1/models/${slug}/predictions`;
  switch (slug) {
    case "black-forest-labs/flux-2-pro": {
      const p: ImageParams = needKind(params, "image");
      const { width, height } = sizeForAspect(p.aspectRatio, 1024 * 1024, 16);
      return { url, input: { prompt: p.prompt, aspect_ratio: "custom", width, height, output_format: "png" } };
    }
    case "minimax/music-1.5": {
      const p: AudioParams = needKind(params, "audio");
      if (!p.lyrics?.trim()) throw new ProviderError("invalid_input", "MiniMax Music needs lyrics (it requires both a style prompt and lyrics).");
      return { url, input: { prompt: p.prompt, lyrics: p.lyrics } };
    }
  }
  throw new ProviderError("invalid_input", `Unknown Replicate model '${slug}'.`);
}

function needKind<K extends GenerationParams["kind"]>(params: GenerationParams, kind: K): Extract<GenerationParams, { kind: K }> {
  if (params.kind !== kind) throw new ProviderError("invalid_input", `Expected ${kind} parameters.`);
  return params as Extract<GenerationParams, { kind: K }>;
}

type Ref = { get: string; cancel: string };

export function parsePrediction(body: unknown): { status: "starting" | "processing" | "succeeded" | "failed" | "canceled"; output: string[]; error?: string; get?: string; cancel?: string } {
  if (!isRecord(body)) throw new ProviderError("provider_error", "Replicate returned an unexpected response.");
  const status = str(body.status);
  if (status !== "starting" && status !== "processing" && status !== "succeeded" && status !== "failed" && status !== "canceled") {
    throw new ProviderError("provider_error", `Replicate returned an unknown status '${status ?? ""}'.`);
  }
  const raw = body.output;
  const output = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const urls = isRecord(body.urls) ? body.urls : {};
  const error = str(body.error);
  const get = str(urls.get);
  const cancel = str(urls.cancel);
  return { status, output, ...(error ? { error } : {}), ...(get ? { get } : {}), ...(cancel ? { cancel } : {}) };
}

async function submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  const req = buildReplicateRequest(model, params);
  const res = parsePredictionWithId(await sendJson<unknown>("Replicate", { url: req.url, method: "POST", auth, body: { kind: "json", value: { input: req.input } } }, signal));
  const ref: Ref = { get: res.get, cancel: res.cancel };
  return { providerId: "replicate", modelId: model.id, ref: encodeRef(ref) };
}

function parsePredictionWithId(body: unknown): { get: string; cancel: string } {
  const p = parsePrediction(body);
  const id = isRecord(body) ? str(body.id) : undefined;
  if (!id) throw new ProviderError("provider_error", "Replicate did not return a prediction id.");
  return { get: p.get ?? `${API}/v1/predictions/${id}`, cancel: p.cancel ?? `${API}/v1/predictions/${id}/cancel` };
}

async function status(job: JobHandle, signal?: AbortSignal): Promise<JobState> {
  const ref = decodeRef<Ref>(job);
  const p = parsePrediction(await sendJson<unknown>("Replicate", { url: ref.get, auth }, signal));
  switch (p.status) {
    case "starting": return { status: "queued" };
    case "processing": return { status: "running" };
    case "failed": return { status: "failed", errorMessage: p.error ?? "The model reported a failure.", code: "provider_error" };
    case "canceled": return { status: "failed", errorMessage: "Cancelled.", code: "cancelled" };
    case "succeeded": {
      if (!p.output.length) return { status: "failed", errorMessage: "Replicate finished but returned no output file.", code: "provider_error" };
      const outputs: JobOutput[] = [];
      for (const url of p.output) {
        // Files served by the API host need the key; the UI downloads without one, so fetch those here.
        if (new URL(url).hostname === "api.replicate.com") {
          outputs.push({ path: await downloadTo("Replicate", { url, auth }, await tempOutputPath(extensionOf(url)), signal) });
        } else {
          outputs.push({ url });
        }
      }
      return { status: "succeeded", outputs };
    }
  }
}

function extensionOf(url: string): string {
  const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname);
  return m?.[1]?.toLowerCase() ?? "bin";
}

async function cancel(job: JobHandle): Promise<void> {
  await send("Replicate", { url: decodeRef<Ref>(job).cancel, method: "POST", auth });
}

async function checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await sendJson<unknown>("Replicate", { url: `${API}/v1/account`, auth }, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Key check failed." };
  }
}

export const replicateProvider: Provider = {
  id: "replicate",
  displayName: "Replicate",
  secretName: "replicate",
  keyUrl: "https://replicate.com/account/api-tokens",
  catalog: replicateCatalog,
  checkKey,
  submit,
  status,
  cancel,
};
