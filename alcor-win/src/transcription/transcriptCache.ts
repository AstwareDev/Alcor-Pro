import { joinPath } from "../model";
import { diskCacheDirectory } from "../media/diskCache";
import { mediaIo } from "../media/io";
import { decodeTranscriptionResult, makeTranscriptionResult, type TranscriptionResult } from "./transcription";

// Port of Transcription/TranscriptCache.swift: disk + memory cache keyed by file identity so edits invalidate
// naturally. Only the cloud variants exist here (no on-device transcription).

const memoryMax = 4;
const memory = new Map<string, TranscriptionResult>();
const cacheDirectoryName = "Transcripts";

export interface SourceRange {
  start: number;
  end: number;
}

export interface TranscriptVariant {
  range?: SourceRange | undefined;
  /** Language code; undefined = auto-detect. */
  language?: string | undefined;
}

/** `String(format: "%.3f")` */
function fixed3(x: number): string {
  return x.toFixed(3);
}

export function variantPrefix(v: TranscriptVariant): string {
  const lang = v.language ?? "auto";
  if (!v.range) return `cloud|${lang}|full`;
  return `cloud|${lang}|${fixed3(v.range.start)}...${fixed3(v.range.end)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identity string for a file + variant; the hash of it is the cache key. */
export function transcriptIdentity(path: string, modifiedMs: number, size: number, variant: TranscriptVariant): string {
  const base = `${path}|${modifiedMs / 1000}|${size}`;
  return `${variantPrefix(variant)}|${base}`;
}

/** First 32 hex chars of SHA-256(identity), or undefined when the file can't be stat'ed. */
export async function transcriptKey(path: string, variant: TranscriptVariant = {}): Promise<string | undefined> {
  const stat = await (await mediaIo()).stat(path);
  if (!stat || stat.isDir) return undefined;
  return (await sha256Hex(transcriptIdentity(path, stat.modifiedMs, stat.size, variant))).slice(0, 32);
}

async function diskPath(key: string): Promise<string> {
  return joinPath(await diskCacheDirectory(cacheDirectoryName), `${key}.json`);
}

async function readDisk(key: string): Promise<TranscriptionResult | undefined> {
  try {
    const bytes = await (await mediaIo()).readAll(await diskPath(key));
    return decodeTranscriptionResult(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

function remember(result: TranscriptionResult, key: string): void {
  if (memory.size >= memoryMax) memory.clear();
  memory.set(key, result);
}

async function cached(key: string): Promise<TranscriptionResult | undefined> {
  const hit = memory.get(key);
  if (hit) return hit;
  const result = await readDisk(key);
  if (result) remember(result, key);
  return result;
}

async function store(result: TranscriptionResult, key: string): Promise<void> {
  remember(result, key);
  try {
    const io = await mediaIo();
    await io.mkdir(await diskCacheDirectory(cacheDirectoryName));
    await io.writeBytes(await diskPath(key), new TextEncoder().encode(JSON.stringify(result)));
  } catch {
    // best effort, like `try? data.write`
  }
}

/** Keeps segments/words overlapping `range`; the text is rebuilt from the kept segments. */
export function filterTranscript(r: TranscriptionResult, range: SourceRange): TranscriptionResult {
  const segments = r.segments.filter((s) => s.end > range.start && s.start < range.end);
  const words = r.words.filter((w) => w.start !== undefined && w.end !== undefined && w.end > range.start && w.start < range.end);
  return makeTranscriptionResult({
    text: segments.map((s) => s.text).join(" "),
    ...(r.language !== undefined ? { language: r.language } : {}),
    words,
    segments,
  });
}

export async function cachedCloudTranscript(path: string, variant: TranscriptVariant): Promise<TranscriptionResult | undefined> {
  const key = await transcriptKey(path, variant);
  return key === undefined ? undefined : cached(key);
}

export async function hasCachedCloudTranscript(path: string, variant: TranscriptVariant): Promise<boolean> {
  const key = await transcriptKey(path, variant);
  if (key === undefined) return false;
  if (memory.has(key)) return true;
  return (await (await mediaIo()).stat(await diskPath(key))) !== null;
}

export async function storeCloudTranscript(result: TranscriptionResult, path: string, variant: TranscriptVariant): Promise<void> {
  const key = await transcriptKey(path, variant);
  if (key !== undefined) await store(result, key);
}

/** Disk-only read of the full, auto-language transcript (what search and the agent read). */
export async function cachedOnDisk(path: string): Promise<TranscriptionResult | undefined> {
  const key = await transcriptKey(path, {});
  return key === undefined ? undefined : readDisk(key);
}

export async function hasCachedOnDisk(path: string): Promise<boolean> {
  const key = await transcriptKey(path, {});
  return key !== undefined && (await (await mediaIo()).stat(await diskPath(key))) !== null;
}

/** Drop in-memory entries so a disk clear isn't shadowed by the memory cache. */
export function clearTranscriptMemory(): void {
  memory.clear();
}
