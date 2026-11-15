import { fsStat } from "../../platform/backend";
import type { HttpAuth } from "../../platform/backend";
import { falCatalog } from "./falCatalog";
import {
  ProviderError, contentTypeOf, decodeRef, encodeRef, errorFromStatus, fileName, isRecord, parseJson, send, sendJson, sizeForAspect, str,
} from "./common";
import type {
  AudioParams, CatalogEntry, GenerationParams, ImageParams, JobHandle, JobOutput, JobState, LocalReference, Provider, UpscaleParams, VideoParams,
} from "./types";

// Queue API: https://fal.ai/docs/model-apis/model-endpoints/queue  (submit -> status_url -> response_url)
// Uploads: POST https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3 {content_type,file_name} -> {file_url, upload_url}, then PUT bytes.

const auth: HttpAuth = { secret: "fal", header: "Authorization", prefix: "Key " };
const QUEUE = "https://queue.fal.run";
const INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
/** fal's client switches to multipart above 90 MiB; that flow is not implemented. */
export const MAX_SIMPLE_UPLOAD_BYTES = 90 * 1024 * 1024;

export interface FalRequest {
  endpoint: string;
  input: Record<string, unknown>;
}

/** Remote URL for a local reference (after upload). */
export type UrlOf = (ref: LocalReference) => string;

/** Every local file a request will need uploaded. */
export function referencesOf(params: GenerationParams): LocalReference[] {
  switch (params.kind) {
    case "video":
      return [params.sourceVideo, params.startFrame, params.endFrame, ...params.referenceImages, ...params.referenceVideos, ...params.referenceAudios]
        .filter((r): r is LocalReference => r !== undefined);
    case "image": return params.images;
    case "upscale": return [params.source];
    case "audio": return [params.video, params.source, params.referenceImage, ...(params.referenceAudios ?? [])].filter((r): r is LocalReference => r !== undefined);
  }
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

function expectKind<K extends GenerationParams["kind"]>(params: GenerationParams, kind: K): Extract<GenerationParams, { kind: K }> {
  if (params.kind !== kind) throw new ProviderError("invalid_input", `Expected ${kind} parameters.`);
  return params as Extract<GenerationParams, { kind: K }>;
}

const need = (ref: LocalReference | undefined, what: string): LocalReference => {
  if (!ref) throw new ProviderError("invalid_input", `${what} is required.`);
  return ref;
};

function buildVideo(id: string, p: VideoParams, url: UrlOf): FalRequest {
  const start = p.startFrame ? url(p.startFrame) : undefined;
  const end = p.endFrame ? url(p.endFrame) : undefined;
  const prompt = p.prompt;
  switch (id) {
    case "bytedance/seedance-2.0": {
      const common = { prompt, resolution: p.resolution, duration: String(p.duration), aspect_ratio: p.aspectRatio, generate_audio: p.generateAudio };
      const hasRefs = p.referenceImages.length + p.referenceVideos.length + p.referenceAudios.length > 0;
      if (hasRefs) {
        return {
          endpoint: "bytedance/seedance-2.0/reference-to-video",
          input: compact({
            ...common,
            image_urls: p.referenceImages.length ? p.referenceImages.map(url) : undefined,
            video_urls: p.referenceVideos.length ? p.referenceVideos.map(url) : undefined,
            audio_urls: p.referenceAudios.length ? p.referenceAudios.map(url) : undefined,
          }),
        };
      }
      if (start) return { endpoint: "bytedance/seedance-2.0/image-to-video", input: compact({ ...common, image_url: start, end_image_url: end }) };
      return { endpoint: "bytedance/seedance-2.0/text-to-video", input: compact(common) };
    }
    case "kling/v4":
      if (start) {
        return { endpoint: "kling/v4/image-to-video", input: compact({ start_image_url: start, end_image_url: end, prompt, duration: p.duration, resolution: p.resolution }) };
      }
      return { endpoint: "kling/v4/text-to-video", input: compact({ prompt, duration: p.duration, resolution: p.resolution, aspect_ratio: p.aspectRatio }) };
    case "minimax/h3":
      if (start) {
        return { endpoint: "minimax/h3/image-to-video", input: compact({ prompt, image_url: start, end_image_url: end, duration: p.duration, resolution: p.resolution }) };
      }
      return { endpoint: "minimax/h3/text-to-video", input: compact({ prompt, duration: p.duration, resolution: p.resolution, aspect_ratio: p.aspectRatio }) };
    case "xai/grok-imagine-video/v1.5":
      if (start) {
        return { endpoint: "xai/grok-imagine-video/v1.5/image-to-video", input: compact({ prompt, image_url: start, duration: p.duration, resolution: p.resolution }) };
      }
      return { endpoint: "xai/grok-imagine-video/v1.5/text-to-video", input: compact({ prompt, duration: p.duration, resolution: p.resolution, aspect_ratio: p.aspectRatio }) };
  }
  throw new ProviderError("invalid_input", `Unknown fal video model '${id}'.`);
}

const IDEOGRAM_SIZES: Record<string, string> = {
  "1:1": "square_hd", "4:3": "landscape_4_3", "3:4": "portrait_4_3", "16:9": "landscape_16_9", "9:16": "portrait_16_9",
};
const SEEDREAM_PIXELS: Record<string, number> = { "1K": 1024 * 1024, "1.5K": 1536 * 1536, "2K": 2048 * 2048 };

function buildImage(id: string, p: ImageParams, url: UrlOf): FalRequest {
  const refs = p.images.length ? p.images.map(url) : undefined;
  switch (id) {
    case "fal-ai/nano-banana-pro":
      return {
        endpoint: refs ? "fal-ai/nano-banana-pro/edit" : "fal-ai/nano-banana-pro",
        input: compact({ prompt: p.prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, num_images: p.numImages, image_urls: refs }),
      };
    case "blackforestlabs/flux-3":
      return {
        endpoint: refs ? "blackforestlabs/flux-3/edit-image" : "blackforestlabs/flux-3/text-to-image",
        input: compact({ prompt: p.prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, image_urls: refs }),
      };
    case "bytedance/seedream/v5/pro": {
      const pixels = SEEDREAM_PIXELS[p.resolution ?? "2K"];
      if (pixels === undefined) throw new ProviderError("invalid_input", `Seedream does not support resolution '${p.resolution}'.`);
      return {
        endpoint: refs ? "bytedance/seedream/v5/pro/edit" : "bytedance/seedream/v5/pro/text-to-image",
        input: compact({ prompt: p.prompt, image_size: sizeForAspect(p.aspectRatio, pixels, 16), num_images: p.numImages, image_urls: refs }),
      };
    }
    case "ideogram/v4.5": {
      const size = IDEOGRAM_SIZES[p.aspectRatio];
      if (!size) throw new ProviderError("invalid_input", `Ideogram does not support aspect ratio '${p.aspectRatio}'.`);
      return { endpoint: "ideogram/v4.5", input: compact({ prompt: p.prompt, image_size: size, quality: p.quality, num_images: p.numImages }) };
    }
  }
  throw new ProviderError("invalid_input", `Unknown fal image model '${id}'.`);
}

function buildUpscale(id: string, p: UpscaleParams, url: UrlOf): FalRequest {
  const src = url(p.source);
  const factor = p.settings.upscale_factor;
  switch (id) {
    case "fal-ai/seedvr/upscale/video":
      return { endpoint: id, input: compact({ video_url: src, upscale_mode: "factor", upscale_factor: factor }) };
    case "fal-ai/seedvr/upscale/image":
      return { endpoint: id, input: compact({ image_url: src, upscale_mode: "factor", upscale_factor: factor }) };
    case "fal-ai/topaz/upscale/video":
      return { endpoint: id, input: compact({ video_url: src, upscale_factor: factor, model: p.settings.model }) };
    case "fal-ai/topaz/upscale/image":
      return { endpoint: id, input: compact({ image_url: src, upscale_factor: factor, model: p.settings.model }) };
  }
  throw new ProviderError("invalid_input", `Unknown fal upscale model '${id}'.`);
}

function buildAudio(id: string, p: AudioParams, url: UrlOf): FalRequest {
  const prompt = p.prompt.trim() || undefined;
  switch (id) {
    case "mirelo-ai/sfx2.0/video-to-audio":
      return { endpoint: id, input: compact({ video_url: url(need(p.video, "A source video")), text_prompt: prompt, duration: p.durationSeconds, num_samples: 1, upload_audio_format: "mp3" }) };
    case "sonilo/v1.1/video-to-music":
      return { endpoint: id, input: compact({ video_url: url(need(p.video, "A source video")), prompt, duration: p.durationSeconds, num_samples: 1 }) };
    case "sonilo/v1.1/video-to-sound-effects":
      return { endpoint: id, input: compact({ video_url: url(need(p.video, "A source video")), prompt, audio_format: "mp3" }) };
    case "sonilo/v1.1/text-to-music":
      return { endpoint: id, input: compact({ prompt: p.prompt, duration: p.durationSeconds === undefined ? undefined : Math.round(p.durationSeconds), num_samples: 1 }) };
    case "sonilo/v1.1/text-to-sound-effects":
      return { endpoint: id, input: compact({ prompt: p.prompt, duration: p.durationSeconds, audio_format: "mp3" }) };
  }
  throw new ProviderError("invalid_input", `Unknown fal audio model '${id}'.`);
}

/** Pure mapping from catalog entry + params to the queue endpoint and JSON input. */
export function buildFalRequest(model: CatalogEntry, params: GenerationParams, url: UrlOf): FalRequest {
  const id = model.id.replace(/^fal\//, "");
  switch (model.kind) {
    case "video": return buildVideo(id, expectKind(params, "video"), url);
    case "image": return buildImage(id, expectKind(params, "image"), url);
    case "upscale": return buildUpscale(id, expectKind(params, "upscale"), url);
    case "audio": return buildAudio(id, expectKind(params, "audio"), url);
  }
}

interface FalRef {
  s: string;
  r: string;
  c: string;
}

function urlsOf(v: unknown): JobOutput[] {
  const items = Array.isArray(v) ? v : [v];
  return items.flatMap((item) => (isRecord(item) && typeof item.url === "string" ? [{ url: item.url }] : []));
}

/** Collects output file URLs from any fal result body (`video`, `images`, `image`, `audio`, `audios`). */
export function extractFalOutputs(body: unknown): JobOutput[] {
  if (!isRecord(body)) return [];
  for (const key of ["video", "images", "image", "audio", "audios"]) {
    const found = urlsOf(body[key]);
    if (found.length) return found;
  }
  return [];
}

function describeFailure(body: unknown): string {
  if (isRecord(body)) {
    const detail = body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const msgs = detail.flatMap((d) => (isRecord(d) && typeof d.msg === "string" ? [d.msg] : []));
      if (msgs.length) return msgs.join("; ");
    }
    if (typeof body.error === "string") return body.error;
  }
  return "The model reported a failure.";
}

export function parseFalStatus(body: unknown): { state: "queued" | "running" | "completed"; error?: string; errorType?: string; queuePosition?: number } {
  if (!isRecord(body)) throw new ProviderError("provider_error", "fal returned an unexpected status payload.");
  const status = str(body.status);
  if (status === "IN_QUEUE") {
    return { state: "queued", ...(typeof body.queue_position === "number" ? { queuePosition: body.queue_position } : {}) };
  }
  if (status === "IN_PROGRESS") return { state: "running" };
  if (status === "COMPLETED") {
    const error = str(body.error);
    const errorType = str(body.error_type);
    return { state: "completed", ...(error ? { error } : {}), ...(errorType ? { errorType } : {}) };
  }
  throw new ProviderError("provider_error", `fal returned an unknown status '${status ?? ""}'.`);
}

async function upload(ref: LocalReference, signal?: AbortSignal): Promise<string> {
  const stat = await fsStat(ref.path);
  if (!stat) throw new ProviderError("invalid_input", `Reference file not found: ${fileName(ref.path)}.`);
  if (stat.size > MAX_SIMPLE_UPLOAD_BYTES) {
    throw new ProviderError("invalid_input", `${fileName(ref.path)} is larger than 90 MB, which the fal upload path here does not support. Trim or compress it first.`);
  }
  const contentType = contentTypeOf(ref);
  const init = await sendJson<unknown>("fal", {
    url: INITIATE, method: "POST", auth, body: { kind: "json", value: { content_type: contentType, file_name: fileName(ref.path) } },
  }, signal);
  const fileUrl = isRecord(init) ? str(init.file_url) : undefined;
  const uploadUrl = isRecord(init) ? str(init.upload_url) : undefined;
  if (!fileUrl || !uploadUrl) throw new ProviderError("provider_error", "fal did not return an upload URL.");
  const put = await send("fal", {
    url: uploadUrl, method: "PUT", headers: [["Content-Type", contentType]], body: { kind: "file", path: ref.path }, timeoutMs: 10 * 60_000,
  }, signal);
  if (put.status < 200 || put.status >= 300) throw errorFromStatus("fal upload", put.status, put.bodyText, put.headers);
  return fileUrl;
}

async function submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  const uploaded = new Map<string, string>();
  for (const ref of referencesOf(params)) {
    if (!uploaded.has(ref.path)) uploaded.set(ref.path, await upload(ref, signal));
  }
  const request = buildFalRequest(model, params, (ref) => {
    const found = uploaded.get(ref.path);
    if (!found) throw new ProviderError("invalid_input", "Reference was not uploaded.");
    return found;
  });
  const res = await sendJson<unknown>("fal", {
    url: `${QUEUE}/${request.endpoint}`, method: "POST", auth, body: { kind: "json", value: request.input },
  }, signal);
  const requestId = isRecord(res) ? str(res.request_id) : undefined;
  if (!isRecord(res) || !requestId) throw new ProviderError("provider_error", "fal did not return a request id.");
  const base = `${QUEUE}/${request.endpoint.split("/").slice(0, 2).join("/")}/requests/${requestId}`;
  const ref: FalRef = { s: str(res.status_url) ?? `${base}/status`, r: str(res.response_url) ?? base, c: str(res.cancel_url) ?? `${base}/cancel` };
  return { providerId: "fal", modelId: model.id, ref: encodeRef(ref) };
}

async function status(job: JobHandle, signal?: AbortSignal): Promise<JobState> {
  const ref = decodeRef<FalRef>(job);
  const st = parseFalStatus(await sendJson<unknown>("fal", { url: ref.s, auth }, signal));
  if (st.state === "queued") return { status: "queued" };
  if (st.state === "running") return { status: "running" };
  if (st.error) return { status: "failed", errorMessage: st.error, ...(st.errorType ? { code: st.errorType } : {}) };
  const res = await send("fal", { url: ref.r, auth }, signal);
  if (res.status < 200 || res.status >= 300) {
    if (res.status === 401 || res.status === 403 || res.status >= 500) throw errorFromStatus("fal", res.status, res.bodyText, res.headers);
    return { status: "failed", errorMessage: describeFailure(safeParse(res.bodyText)), code: "invalid_input" };
  }
  const outputs = extractFalOutputs(parseJson<unknown>("fal", res.bodyText));
  if (!outputs.length) return { status: "failed", errorMessage: "fal finished but returned no output file.", code: "provider_error" };
  return { status: "succeeded", outputs };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

async function cancel(job: JobHandle): Promise<void> {
  const ref = decodeRef<FalRef>(job);
  await send("fal", { url: ref.c, method: "PUT", auth });
}

async function checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // Authenticated, creates nothing until bytes are PUT to the returned URL.
    await sendJson<unknown>("fal", { url: INITIATE, method: "POST", auth, body: { kind: "json", value: { content_type: "text/plain", file_name: "key-check.txt" } } }, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Key check failed." };
  }
}

export const falProvider: Provider = {
  id: "fal",
  displayName: "fal",
  secretName: "fal",
  keyUrl: "https://fal.ai/dashboard/keys",
  catalog: falCatalog,
  checkKey,
  submit,
  status,
  cancel,
};
