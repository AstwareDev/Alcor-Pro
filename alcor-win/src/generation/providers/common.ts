import { httpCancel, httpFetch, type HttpRequest, type HttpResponse } from "../../platform/backend";
import type { JobHandle, LocalReference, ProviderId } from "./types";

export type ErrorCode = "no_key" | "auth" | "quota" | "invalid_input" | "provider_error" | "network" | "cancelled";

/** Normalised provider failure; messages never contain secrets. */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: ErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function errorFromStatus(provider: string, status: number, bodyText: string, headers: [string, string][] = []): ProviderError {
  const detail = excerpt(bodyText);
  const retry = retryAfterMs(headers);
  if (status === 401 || status === 403) return new ProviderError("auth", `${provider} rejected the API key (HTTP ${status}). Check the key and its permissions in Settings. ${detail}`.trim());
  if (status === 402 || status === 429) {
    return new ProviderError("quota", `${provider} reports a quota, billing or rate limit problem (HTTP ${status}). ${detail}`.trim(), retry);
  }
  if (status === 400 || status === 404 || status === 405 || status === 413 || status === 415 || status === 422) {
    return new ProviderError("invalid_input", `${provider} rejected the request (HTTP ${status}). ${detail}`.trim());
  }
  return new ProviderError("provider_error", `${provider} failed (HTTP ${status}). ${detail}`.trim(), retry);
}

export function retryAfterMs(headers: [string, string][]): number | undefined {
  const h = headers.find(([k]) => k.toLowerCase() === "retry-after");
  if (!h) return undefined;
  const seconds = Number(h[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function excerpt(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

export function isNoKeyMessage(message: string): boolean {
  return /no API key stored/i.test(message);
}

let counter = 0;
const nextRequestId = (): string => `req-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** One HTTP call through Rust; resolves for any HTTP status, rejects with ProviderError for transport failures/abort. */
export async function send(provider: string, req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  if (signal?.aborted) throw new ProviderError("cancelled", "Cancelled.");
  const requestId = req.requestId ?? nextRequestId();
  const onAbort = (): void => void httpCancel(requestId).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await httpFetch({ ...req, requestId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (signal?.aborted || message === "cancelled") throw new ProviderError("cancelled", "Cancelled.");
    if (isNoKeyMessage(message)) throw new ProviderError("no_key", `No ${provider} API key is set. Add one in Settings > Models / API Keys.`);
    if (/may not be sent|unknown secret/i.test(message)) throw new ProviderError("provider_error", `Blocked by the host allowlist: ${message}`);
    throw new ProviderError("network", `Could not reach ${provider}: ${message}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** `send` plus JSON parsing; throws a normalised error for non-2xx. */
export async function sendJson<T>(provider: string, req: HttpRequest, signal?: AbortSignal): Promise<T> {
  const res = await send(provider, req, signal);
  if (res.status < 200 || res.status >= 300) throw errorFromStatus(provider, res.status, res.bodyText, res.headers);
  return parseJson<T>(provider, res.bodyText);
}

export function parseJson<T>(provider: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("provider_error", `${provider} returned a response that is not valid JSON.`);
  }
}

export function encodeRef(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeRef<T>(job: JobHandle): T {
  try {
    return JSON.parse(job.ref) as T;
  } catch {
    throw new ProviderError("invalid_input", "The saved job reference is corrupted and cannot be resumed.");
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "file";
}

const mimeByExt: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
};

export function contentTypeOf(ref: LocalReference): string {
  if (ref.contentType) return ref.contentType;
  const ext = fileName(ref.path).split(".").pop()?.toLowerCase() ?? "";
  return mimeByExt[ext] ?? (ref.type === "image" ? "image/png" : ref.type === "video" ? "video/mp4" : "audio/mpeg");
}

/** Width/height for an `a:b` ratio near `targetPixels`, each rounded to a multiple of `multiple`. */
export function sizeForAspect(aspect: string, targetPixels: number, multiple: number): { width: number; height: number } {
  const [a, b] = aspect.split(":").map(Number);
  if (!a || !b) throw new ProviderError("invalid_input", `Unsupported aspect ratio '${aspect}'.`);
  const height = Math.sqrt((targetPixels * b) / a);
  const width = (height * a) / b;
  const snap = (v: number): number => Math.max(multiple, Math.round(v / multiple) * multiple);
  return { width: snap(width), height: snap(height) };
}

export function requireProvider(id: ProviderId, got: ProviderId): void {
  if (id !== got) throw new ProviderError("invalid_input", `Job belongs to provider '${got}', not '${id}'.`);
}

export function sleepSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("cancelled", "Cancelled."));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(t); reject(new ProviderError("cancelled", "Cancelled.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Directory for adapter-written outputs (sync endpoints that return bytes). */
export async function tempOutputPath(ext: string, stem?: string): Promise<string> {
  const { appPaths, fsMkdir } = await import("../../platform/backend");
  const dir = `${(await appPaths()).temp}\\palmier-generation`;
  await fsMkdir(dir);
  const name = stem ?? `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `${dir}\\${name}.${ext}`;
}

/** Streams a response body to `destPath` through Rust; maps `HTTP <status>: …` failures to ProviderError. */
export async function downloadTo(provider: string, req: HttpRequest, destPath: string, signal?: AbortSignal): Promise<string> {
  const { httpDownload } = await import("../../platform/backend");
  if (signal?.aborted) throw new ProviderError("cancelled", "Cancelled.");
  const requestId = req.requestId ?? nextRequestId();
  const onAbort = (): void => void httpCancel(requestId).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await httpDownload({ ...req, requestId }, destPath, () => undefined);
    return destPath;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (signal?.aborted || message === "cancelled") throw new ProviderError("cancelled", "Cancelled.");
    const m = /HTTP (\d{3})\s*:?\s*([\s\S]*)/.exec(message);
    if (m) throw errorFromStatus(provider, Number(m[1]), m[2] ?? "");
    if (isNoKeyMessage(message)) throw new ProviderError("no_key", `No ${provider} API key is set. Add one in Settings > Models / API Keys.`);
    throw new ProviderError("network", `Could not reach ${provider}: ${message}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Decodes a base64 payload into a temp file and returns its path. */
export async function writeBase64Temp(b64: string, ext: string): Promise<string> {
  const { fsWriteBytes } = await import("../../platform/backend");
  const path = await tempOutputPath(ext);
  await fsWriteBytes(path, base64ToBytes(b64));
  return path;
}
