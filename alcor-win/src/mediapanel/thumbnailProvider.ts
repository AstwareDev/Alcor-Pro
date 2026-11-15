import type { ClipType } from "../model";
import { isBitmapLive, getPoster, peekPoster } from "../media/thumbnails";

export type ThumbnailSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface ThumbnailRequest {
  path: string;
  type: ClipType;
}

/** Supplies library posters. Borrowed bitmaps must be drawn right after the await and never closed. */
export interface ThumbnailProvider {
  /** Synchronous cache lookup for the first paint. */
  peek(request: ThumbnailRequest): ThumbnailSource | undefined;
  load(request: ThumbnailRequest, signal: AbortSignal): Promise<ThumbnailSource | null>;
  /** False once a borrowed source was evicted and must be requested again. */
  isLive(source: ThumbnailSource): boolean;
}

export const defaultThumbnailProvider: ThumbnailProvider = {
  peek: ({ path, type }) => (type === "video" || type === "image" ? peekPoster(path) : undefined),
  load: ({ path, type }, signal) => getPoster(path, { type, signal }),
  isLive: (source) => !(source instanceof ImageBitmap) || isBitmapLive(source),
};

/** Whether the asset type has a visual poster at all (audio, lottie and subtitles show an icon). */
export function hasPoster(type: ClipType): boolean {
  return type === "video" || type === "image";
}
