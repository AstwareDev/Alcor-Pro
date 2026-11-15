import { swiftRound } from "../util/math";

/* Sizing and timing rules of MediaVisualCache / MediaAsset thumbnails. */

/** Timeline strip thumbnail budget (AVAssetImageGenerator.maximumSize). */
export const timelineThumbnailMaxSize = { width: 120, height: 68 } as const;
/** Single-still image tile on the timeline (kCGImageSourceThumbnailMaxPixelSize). */
export const imageTileMaxPixelSize = 120;
/** Media-library poster (square budget so portrait video gets full resolution too). */
export const posterMaxPixelSize = 320;
/** ImageEncoder.maxLongestEdge: preview-size decode. */
export const previewMaxPixelSize = 1568;

export const videoThumbnailGateValue = 2;
export const imageThumbnailGateValue = 4;
export const posterGateValue = 4;
export const waveformGateValue = 2;

/** Whole-video thumbnail times: every 1 s below 10 s duration, else every 2 s. */
export function videoThumbnailTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || !(duration > 0)) return [];
  const interval = duration < 10 ? 1.0 : 2.0;
  const times: number[] = [];
  for (let t = 0; t < duration; t += interval) times.push(t);
  return times;
}

export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge) || !(longest > 0)) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Frame timestamps for `count` equal tiles across [start, end): the middle of each tile, clamped to the range. */
export function filmstripTimestamps(start: number, end: number, count: number): number[] {
  if (count <= 0) return [];
  const span = Math.max(0, end - start);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + ((i + 0.5) * span) / count);
  return out;
}

/** Heights are bucketed to multiples of 8 px (16...512) so nearby zoom levels share cached frames. */
export function quantizeThumbnailHeight(height: number): number {
  const h = Math.ceil(Math.max(1, height) / 8) * 8;
  return Math.min(512, Math.max(16, h));
}

/** Nearest thumbnail of a uniformly spaced sequence (`drawThumbnailStrip`), or undefined past its coverage. */
export function thumbnailIndexForTime(
  timeSec: number,
  startTime: number,
  spacing: number,
  count: number,
  lastTime: number,
): number | undefined {
  if (count <= 0 || timeSec > lastTime + spacing) return undefined;
  const index = swiftRound((timeSec - startTime) / spacing);
  return Math.max(0, Math.min(count - 1, index));
}

export function bitmapBytes(width: number, height: number): number {
  return width * height * 4;
}
