// Silero VAD ONNX model: downloaded on first use (never bundled) into `<appData>/models/silero-vad/`, verified by
// sha256, installed atomically. Same shape as the Swift `ModelDownloader` (stage -> verify -> install), with a progress
// signal for the UI. Model: https://github.com/snakers4/silero-vad, tag v5.1.2, MIT licence.
import { createSignal } from "solid-js";
import { joinPath } from "../model";
import { sha256Hex } from "../library/sha256";
import { mediaIo, type MediaIo } from "../media/io";

export const sileroModel = {
  url: "https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx",
  fileName: "silero_vad.onnx",
  sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
  bytes: 2_327_524,
  license: "MIT (Copyright (c) 2020-present Silero Team)",
  directoryName: "silero-vad",
} as const;

export type ModelPhase = "idle" | "downloading" | "verifying" | "ready" | "error";

export interface ModelStatus {
  phase: ModelPhase;
  receivedBytes: number;
  totalBytes: number;
  message?: string;
}

const [status, setStatus] = createSignal<ModelStatus>({ phase: "idle", receivedBytes: 0, totalBytes: sileroModel.bytes });
/** Reactive download state for the progress UI. */
export const sileroModelStatus = status;

export class ModelChecksumError extends Error {
  constructor(actual: string) {
    super(`Silero VAD model checksum mismatch (got ${actual}).`);
    this.name = "ModelChecksumError";
  }
}

/** Where the model file lives and how bytes arrive; the Tauri implementation is `tauriModelSource`. */
export interface ModelSource {
  io(): Promise<MediaIo>;
  modelsRoot(): Promise<string>;
  /** Streams `url` to `dest`; rejects on non-2xx or when `signal` aborts. */
  download(url: string, dest: string, onProgress: (received: number, total: number | null) => void, signal?: AbortSignal): Promise<void>;
}

export const tauriModelSource: ModelSource = {
  io: () => mediaIo(),
  async modelsRoot() {
    const { appPaths } = await import("../platform/backend");
    return joinPath((await appPaths()).appData, "models");
  },
  async download(url, dest, onProgress, signal) {
    const { httpCancel, httpDownload } = await import("../platform/backend");
    const requestId = crypto.randomUUID();
    const onAbort = () => void httpCancel(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await httpDownload({ url, requestId, timeoutMs: 120_000 }, dest, (p) => onProgress(p.received, p.total));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  },
};

export async function sileroModelPath(source: ModelSource = tauriModelSource): Promise<string> {
  return joinPath(joinPath(await source.modelsRoot(), sileroModel.directoryName), sileroModel.fileName);
}

async function verified(io: MediaIo, path: string): Promise<boolean> {
  const stat = await io.stat(path);
  if (!stat || stat.size !== sileroModel.bytes) return false;
  return (await sha256Hex(await io.readAll(path))) === sileroModel.sha256;
}

let installing: Promise<string> | undefined;

/** Idempotent: returns the verified model path, downloading it first if needed. Concurrent callers share one download. */
export function ensureSileroModel(source: ModelSource = tauriModelSource, signal?: AbortSignal): Promise<string> {
  installing ??= install(source, signal).finally(() => {
    installing = undefined;
  });
  return installing;
}

async function install(source: ModelSource, signal?: AbortSignal): Promise<string> {
  const io = await source.io();
  const path = await sileroModelPath(source);
  const dir = joinPath(await source.modelsRoot(), sileroModel.directoryName);
  try {
    if (await verified(io, path)) {
      setStatus({ phase: "ready", receivedBytes: sileroModel.bytes, totalBytes: sileroModel.bytes });
      return path;
    }
    await io.mkdir(dir);
    const staging = `${path}.part`;
    await io.remove(staging).catch(() => undefined);
    setStatus({ phase: "downloading", receivedBytes: 0, totalBytes: sileroModel.bytes });
    await source.download(sileroModel.url, staging, (received, total) => {
      setStatus({ phase: "downloading", receivedBytes: received, totalBytes: total ?? sileroModel.bytes });
    }, signal);
    setStatus({ phase: "verifying", receivedBytes: sileroModel.bytes, totalBytes: sileroModel.bytes });
    const digest = await sha256Hex(await io.readAll(staging));
    if (digest !== sileroModel.sha256) {
      await io.remove(staging).catch(() => undefined);
      throw new ModelChecksumError(digest);
    }
    await io.rename(staging, path);
    setStatus({ phase: "ready", receivedBytes: sileroModel.bytes, totalBytes: sileroModel.bytes });
    return path;
  } catch (e) {
    setStatus({ phase: "error", receivedBytes: 0, totalBytes: sileroModel.bytes, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
