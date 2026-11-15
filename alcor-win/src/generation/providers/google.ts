import type { HttpAuth } from "../../platform/backend";
import { mediaUrl } from "../../media/mediaUrl";
import {
  ProviderError, bytesToBase64, contentTypeOf, decodeRef, encodeRef, fileName, isRecord, sendJson, str, writeBase64Temp,
} from "./common";
import type { CatalogEntry, GenerationParams, ImageParams, JobHandle, JobState, LocalReference, Provider } from "./types";

// Docs: https://aistudio.google.com/docs/image-generation (Interactions API) and https://aistudio.google.com/api-reference/interactions-api
// Veo is not offered: the Gemini API documentation states the Veo 3.1 preview models were shut down on 2026-10-22, and the
// replacement (gemini-omni-1.2-flash) has no documented REST request shape for video yet.

const auth: HttpAuth = { secret: "google", header: "x-goog-api-key", prefix: "" };
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const docs = "https://aistudio.google.com/docs/image-generation";
const MAX_REFERENCES = 14;

const base = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"];

const entry = (id: string, displayName: string, description: string, aspectRatios: string[]): CatalogEntry => ({
  id: `google/${id}`, providerId: "google", displayName, providerIconKey: "google", providerName: "Google", description,
  responseShape: "images", docsUrl: docs, kind: "image",
  uiCapabilities: { resolutions: ["1K", "2K", "4K"], aspectRatios, supportsImageReference: true, maxImages: 1 },
});

export const googleCatalog: readonly CatalogEntry[] = [
  entry("gemini-nano-banana-2.1", "Nano Banana 2.1", "Gemini image generation and editing with up to 14 references.", [...base, "1:4", "4:1", "1:8", "8:1"]),
  entry("gemini-3-pro-image", "Nano Banana Pro (Gemini)", "Premium Gemini image model with up to 14 references.", base),
];

export type ReferenceData = { mimeType: string; base64: string };

export interface GoogleRequest {
  url: string;
  body: Record<string, unknown>;
}

/** Pure request mapping; `refs` are the already base64-encoded reference images in order. */
export function buildGoogleRequest(model: CatalogEntry, p: ImageParams, refs: ReferenceData[]): GoogleRequest {
  const id = model.id.replace(/^google\//, "");
  if (refs.length > MAX_REFERENCES) throw new ProviderError("invalid_input", `Gemini accepts at most ${MAX_REFERENCES} reference images.`);
  const responseFormat: Record<string, unknown> = { type: "image", mime_type: "image/png", aspect_ratio: p.aspectRatio };
  if (p.resolution) responseFormat.image_size = p.resolution;
  const input: unknown = refs.length
    ? [{ type: "text", text: p.prompt }, ...refs.map((r) => ({ type: "image", mime_type: r.mimeType, data: r.base64 }))]
    : p.prompt;
  return { url: ENDPOINT, body: { model: id, input, response_format: responseFormat } };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Image parts of every `model_output` step, in order. */
export function parseInteractionImages(body: unknown): { data: string; ext: string }[] {
  if (!isRecord(body)) throw new ProviderError("provider_error", "Google returned an unexpected response.");
  const status = str(body.status);
  if (status && status !== "completed") {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const first = errors.find(isRecord);
    throw new ProviderError("provider_error", `Google did not complete the request (${status}).${first && str(first.message) ? ` ${str(first.message)}` : ""}`);
  }
  const out: { data: string; ext: string }[] = [];
  for (const step of Array.isArray(body.steps) ? body.steps : []) {
    if (!isRecord(step) || step.type !== "model_output") continue;
    for (const c of Array.isArray(step.content) ? step.content : []) {
      if (isRecord(c) && c.type === "image" && typeof c.data === "string") out.push({ data: c.data, ext: EXT[str(c.mime_type) ?? ""] ?? "png" });
    }
  }
  if (!out.length) throw new ProviderError("provider_error", "Google returned no image (the prompt may have been blocked by safety filters).");
  return out;
}

async function readReference(ref: LocalReference): Promise<ReferenceData> {
  const res = await fetch(mediaUrl(ref.path));
  if (!res.ok) throw new ProviderError("invalid_input", `Could not read ${fileName(ref.path)}.`);
  return { mimeType: contentTypeOf(ref), base64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) };
}

type Ref = { paths: string[] };

async function submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  if (params.kind !== "image") throw new ProviderError("invalid_input", "Google serves image models only.");
  const refs = await Promise.all(params.images.map(readReference));
  const req = buildGoogleRequest(model, params, refs);
  const res = await sendJson<unknown>("Google", {
    url: req.url, method: "POST", auth, headers: [["Api-Revision", API_REVISION]], body: { kind: "json", value: req.body }, timeoutMs: 10 * 60_000,
  }, signal);
  const paths: string[] = [];
  for (const img of parseInteractionImages(res)) paths.push(await writeBase64Temp(img.data, img.ext));
  const ref: Ref = { paths };
  return { providerId: "google", modelId: model.id, ref: encodeRef(ref) };
}

async function status(job: JobHandle): Promise<JobState> {
  return { status: "succeeded", outputs: decodeRef<Ref>(job).paths.map((path) => ({ path })) };
}

async function checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await sendJson<unknown>("Google", { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", auth }, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Key check failed." };
  }
}

export const googleProvider: Provider = {
  id: "google",
  displayName: "Google Gemini",
  secretName: "google",
  keyUrl: "https://aistudio.google.com/apikey",
  catalog: googleCatalog,
  checkKey,
  submit,
  status,
};
