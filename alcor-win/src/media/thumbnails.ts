import { ALL_FORMATS, CanvasSink, Input, UrlSource, type InputVideoTrack } from "mediabunny";
import type { ClipType } from "../model";
import { diskCacheKey } from "./cacheKey";
import { abortError, AsyncSemaphore, InflightMap, isAbortError, throwIfAborted, yieldToUi } from "./concurrency";
import { mediaIo } from "./io";
import { ByteLru } from "./lru";
import { mediaUrl } from "./mediaUrl";
import {
  bitmapBytes, filmstripTimestamps, fitWithin, imageThumbnailGateValue, imageTileMaxPixelSize, posterGateValue,
  posterMaxPixelSize, quantizeThumbnailHeight, videoThumbnailGateValue,
} from "./thumbnailMath";
import { emitVisualReady } from "./visualEvents";

/*
 * Bitmaps returned from here are borrowed from an LRU: draw them right after the await and never close them.
 * An evicted bitmap is closed (width/height become 0), so re-request when `isBitmapLive` is false.
 */

const memoryBudgetBytes = 96 * 1024 * 1024;

const bitmaps = new ByteLru<ImageBitmap>(memoryBudgetBytes, (_key, bitmap) => bitmap.close());
/** path -> content key of the last file version seen, so sync lookups can build cache keys without I/O. */
const latestKeyByPath = new Map<string, string>();

const videoGate = new AsyncSemaphore(videoThumbnailGateValue);
const imageGate = new AsyncSemaphore(imageThumbnailGateValue);
const posterGate = new AsyncSemaphore(posterGateValue);

const posterFlights = new InflightMap<ImageBitmap | null>();
const filmstripFlights = new InflightMap<(ImageBitmap | null)[]>();

export function isBitmapLive(bitmap: ImageBitmap): boolean {
  return bitmap.width > 0;
}

async function contentKey(path: string): Promise<string | undefined> {
  const stat = await (await mediaIo()).stat(path);
  if (!stat || stat.isDir) return undefined;
  const key = await diskCacheKey(path, stat);
  latestKeyByPath.set(path, key);
  return key;
}

function posterKey(key: string, maxSize: number): string {
  return `${key}|poster|${maxSize}`;
}

function frameKey(key: string, height: number, time: number): string {
  return `${key}|film|${height}|${Math.round(time * 1000)}`;
}

function store(key: string, bitmap: ImageBitmap): void {
  bitmaps.set(key, bitmap, bitmapBytes(bitmap.width, bitmap.height));
}

function openInput(path: string): Input<UrlSource> {
  return new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
}

async function primaryDecodableVideo(input: Input): Promise<InputVideoTrack | undefined> {
  const track = await input.getPrimaryVideoTrack();
  return track && (await track.canDecode()) ? track : undefined;
}

async function decodeImage(path: string, maxEdge: number): Promise<ImageBitmap | null> {
  const res = await fetch(mediaUrl(path));
  if (!res.ok) return null;
  const full = await createImageBitmap(await res.blob(), { imageOrientation: "from-image" });
  try {
    const size = fitWithin(full.width, full.height, maxEdge);
    if (size.width === full.width && size.height === full.height) return await createImageBitmap(full);
    return await createImageBitmap(full, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
  } finally {
    full.close();
  }
}

async function decodeVideoPoster(path: string, maxSize: number, signal: AbortSignal): Promise<ImageBitmap | null> {
  const input = openInput(path);
  try {
    const track = await primaryDecodableVideo(input);
    if (!track) return null;
    const size = fitWithin(await track.getDisplayWidth(), await track.getDisplayHeight(), maxSize);
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: "fill" });
    const wrapped = await sink.getCanvas(await track.getFirstTimestamp());
    throwIfAborted(signal);
    return wrapped ? await createImageBitmap(wrapped.canvas) : null;
  } finally {
    input.dispose();
  }
}

export interface PosterRequest {
  type: ClipType;
  /** Longest edge in pixels; defaults to the library poster size (320). */
  maxSize?: number;
  signal?: AbortSignal;
}

/** Library poster: first frame of a video, a scaled still for an image; null for other kinds or undecodable media. */
export async function getPoster(path: string, request: PosterRequest): Promise<ImageBitmap | null> {
  const { type, signal } = request;
  if (type !== "video" && type !== "image") return null;
  const maxSize = request.maxSize ?? posterMaxPixelSize;
  const key = await contentKey(path);
  if (key === undefined) return null;
  const cacheKey = posterKey(key, maxSize);
  const cached = bitmaps.get(cacheKey);
  if (cached) return cached;
  const gate = type === "image" ? imageGate : posterGate;
  const kind = type === "image" && maxSize <= imageTileMaxPixelSize ? "imageThumbnail" : "poster";
  const bitmap = await posterFlights.run(
    cacheKey,
    (flightSignal) =>
      gate.run(async () => {
        let decoded: ImageBitmap | null;
        try {
          decoded = type === "image" ? await decodeImage(path, maxSize) : await decodeVideoPoster(path, maxSize, flightSignal);
        } catch (e) {
          if (flightSignal.aborted) throw abortError();
          if (isAbortError(e)) throw e;
          return null;
        }
        if (decoded) {
          store(cacheKey, decoded);
          emitVisualReady({ kind, path });
        }
        return decoded;
      }, flightSignal),
    signal,
  );
  return bitmap;
}

/** Single still tile for an image clip on the timeline (120 px max edge, like `makeImageThumbnail`). */
export function getImageThumbnail(path: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  return getPoster(path, { type: "image", maxSize: imageTileMaxPixelSize, signal });
}

/** Synchronous lookup for draw calls; undefined until the async request has completed. */
export function peekPoster(path: string, maxSize: number = posterMaxPixelSize): ImageBitmap | undefined {
  const key = latestKeyByPath.get(path);
  return key === undefined ? undefined : bitmaps.peek(posterKey(key, maxSize));
}

export interface FilmstripRequest {
  /** Source seconds covered by the clip's visible range. */
  sourceStart: number;
  sourceEnd: number;
  /** Number of equal tiles across the range. */
  count: number;
  /** Tile height in device pixels (bucketed to a multiple of 8). */
  height: number;
  signal?: AbortSignal;
}

async function decodeFrames(path: string, times: number[], height: number, signal: AbortSignal): Promise<Map<number, ImageBitmap>> {
  const out = new Map<number, ImageBitmap>();
  const input = openInput(path);
  try {
    const track = await primaryDecodableVideo(input);
    if (!track) return out;
    throwIfAborted(signal);
    const first = await track.getFirstTimestamp();
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    const sink = new CanvasSink(track, { height });
    const requested = sorted.map((t) => Math.max(t, first));
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(requested)) {
      throwIfAborted(signal);
      if (wrapped) out.set(sorted[index], await createImageBitmap(wrapped.canvas));
      index += 1;
      await yieldToUi();
    }
    return out;
  } catch (e) {
    for (const bitmap of out.values()) bitmap.close();
    if (signal.aborted) throw abortError();
    throw e;
  } finally {
    input.dispose();
  }
}

/** One bitmap per tile (null where no frame could be decoded). Cached per frame so overlapping requests share work. */
export async function getFilmstrip(path: string, request: FilmstripRequest): Promise<(ImageBitmap | null)[]> {
  const { signal } = request;
  const height = quantizeThumbnailHeight(request.height);
  const times = filmstripTimestamps(request.sourceStart, request.sourceEnd, request.count);
  if (times.length === 0) return [];
  const key = await contentKey(path);
  if (key === undefined) return times.map(() => null);

  const lookup = () => times.map((t) => bitmaps.get(frameKey(key, height, t)) ?? null);
  const missing = () => times.filter((t) => !bitmaps.has(frameKey(key, height, t)));
  if (missing().length === 0) return lookup();

  const flightKey = `${key}|film|${height}|${times.map((t) => Math.round(t * 1000)).join(",")}`;
  await filmstripFlights.run(
    flightKey,
    (flightSignal) =>
      videoGate.run(async () => {
        const wanted = missing();
        if (wanted.length === 0) return [];
        let decoded: Map<number, ImageBitmap>;
        try {
          decoded = await decodeFrames(path, wanted, height, flightSignal);
        } catch (e) {
          if (isAbortError(e)) throw e;
          return [];
        }
        for (const [t, bitmap] of decoded) store(frameKey(key, height, t), bitmap);
        if (decoded.size > 0) emitVisualReady({ kind: "filmstrip", path });
        return [];
      }, flightSignal),
    signal,
  );
  return lookup();
}

/** Drops every cached bitmap for the file's last-seen version (e.g. after relink or an explicit cache clear). */
export function invalidateThumbnails(path: string): void {
  const key = latestKeyByPath.get(path);
  if (key === undefined) return;
  bitmaps.deleteWhere((k) => k.startsWith(`${key}|`));
  latestKeyByPath.delete(path);
}

export function clearThumbnailCache(): void {
  bitmaps.clear();
  latestKeyByPath.clear();
}

export function thumbnailCacheStats(): { entries: number; bytes: number } {
  return { entries: bitmaps.size, bytes: bitmaps.bytes };
}
