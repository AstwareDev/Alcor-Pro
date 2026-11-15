// Generic model downloader for multi-file ONNX models: stage -> verify sha256 -> install atomically into
// `<appData>/models/<directoryName>/`. Models are never bundled. Same flow as the Silero VAD installer
// (`src/deadair/sileroModel.ts`), whose `ModelSource` abstraction it reuses.
import { createSignal, type Accessor } from "solid-js";
import { sha256Hex } from "../library/sha256";
import { type MediaIo } from "../media/io";
import { joinPath } from "../model";
import { tauriModelSource, type ModelSource } from "../deadair/sileroModel";

export type { ModelSource };

export interface ModelFileSpec {
  fileName: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface ModelSpec {
  id: string;
  directoryName: string;
  license: string;
  files: readonly ModelFileSpec[];
}

export type ModelPhase = "idle" | "downloading" | "verifying" | "ready" | "error";

export interface ModelStatus {
  phase: ModelPhase;
  receivedBytes: number;
  totalBytes: number;
  message?: string;
}

export class ModelChecksumError extends Error {
  constructor(fileName: string, actual: string) {
    super(`Model file ${fileName} failed its checksum (got ${actual}).`);
    this.name = "ModelChecksumError";
  }
}

export const modelTotalBytes = (spec: ModelSpec): number => spec.files.reduce((n, f) => n + f.bytes, 0);

type StatusSignal = ReturnType<typeof createSignal<ModelStatus>>;
const signals = new Map<string, StatusSignal>();

function signalFor(spec: ModelSpec): StatusSignal {
  let s = signals.get(spec.id);
  if (!s) {
    s = createSignal<ModelStatus>({ phase: "idle", receivedBytes: 0, totalBytes: modelTotalBytes(spec) });
    signals.set(spec.id, s);
  }
  return s;
}

/** Reactive download state for progress UI. */
export function modelStatus(spec: ModelSpec): Accessor<ModelStatus> {
  return signalFor(spec)[0];
}

export async function modelDirectory(spec: ModelSpec, source: ModelSource = tauriModelSource): Promise<string> {
  return joinPath(await source.modelsRoot(), spec.directoryName);
}

async function verified(io: MediaIo, path: string, file: ModelFileSpec): Promise<boolean> {
  const stat = await io.stat(path);
  if (!stat || stat.size !== file.bytes) return false;
  return (await sha256Hex(await io.readAll(path))) === file.sha256;
}

/** True when every file is already installed and verified (no download). */
export async function isModelInstalled(spec: ModelSpec, source: ModelSource = tauriModelSource): Promise<boolean> {
  const io = await source.io();
  const dir = await modelDirectory(spec, source);
  for (const file of spec.files) {
    if (!(await verified(io, joinPath(dir, file.fileName), file))) return false;
  }
  return true;
}

const installing = new Map<string, Promise<string[]>>();

/** Idempotent: returns verified file paths (in `spec.files` order), downloading what is missing. Callers share one install. */
export function ensureModel(spec: ModelSpec, source: ModelSource = tauriModelSource, signal?: AbortSignal): Promise<string[]> {
  let p = installing.get(spec.id);
  if (!p) {
    p = install(spec, source, signal).finally(() => installing.delete(spec.id));
    installing.set(spec.id, p);
  }
  return p;
}

async function install(spec: ModelSpec, source: ModelSource, signal?: AbortSignal): Promise<string[]> {
  const [, setStatus] = signalFor(spec);
  const total = modelTotalBytes(spec);
  const io = await source.io();
  const dir = await modelDirectory(spec, source);
  const paths = spec.files.map((f) => joinPath(dir, f.fileName));
  try {
    let done = 0;
    for (let i = 0; i < spec.files.length; i++) {
      const file = spec.files[i] as ModelFileSpec;
      const path = paths[i] as string;
      if (await verified(io, path, file)) {
        done += file.bytes;
        continue;
      }
      await io.mkdir(dir);
      const staging = `${path}.part`;
      await io.remove(staging).catch(() => undefined);
      const base = done;
      setStatus({ phase: "downloading", receivedBytes: base, totalBytes: total });
      await source.download(file.url, staging, (received) => {
        setStatus({ phase: "downloading", receivedBytes: base + Math.min(received, file.bytes), totalBytes: total });
      }, signal);
      setStatus({ phase: "verifying", receivedBytes: base + file.bytes, totalBytes: total });
      const digest = await sha256Hex(await io.readAll(staging));
      if (digest !== file.sha256) {
        await io.remove(staging).catch(() => undefined);
        throw new ModelChecksumError(file.fileName, digest);
      }
      await io.rename(staging, path);
      done += file.bytes;
    }
    setStatus({ phase: "ready", receivedBytes: total, totalBytes: total });
    return paths;
  } catch (e) {
    setStatus({ phase: "error", receivedBytes: 0, totalBytes: total, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Ensures the model is installed and returns each file as a transferable ArrayBuffer (for the worker `init`). */
export async function loadModelBuffers(spec: ModelSpec, source: ModelSource = tauriModelSource, signal?: AbortSignal): Promise<ArrayBuffer[]> {
  const paths = await ensureModel(spec, source, signal);
  const io = await source.io();
  const out: ArrayBuffer[] = [];
  for (const path of paths) {
    const bytes = await io.readAll(path);
    out.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return out;
}
