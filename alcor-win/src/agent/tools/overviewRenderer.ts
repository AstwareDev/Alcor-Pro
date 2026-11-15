import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from "mediabunny";
import { swiftRound } from "../../util/math";
import { encodeJPEG } from "./inspectFrameOverlay";

// Port of OverviewRenderer.swift (+ LumaGrid from FrameSampler.swift): one storyboard image of a video's visual flow,
// near-duplicate tiles dropped, a timestamp burned into each kept tile.

export const overviewTileWidth = 160;
export const overviewTileHeight = 90;
export const overviewColumns = 6;
export const overviewMaxTiles = 36;
const candidateTarget = 120;
export const overviewPromoteDiff = 12;
export const overviewLabelHeight = 14;
const jpegQuality = 0.7;

export interface OverviewSheet {
  jpeg: Uint8Array;
  timestamps: number[];
}

export class OverviewError extends Error {}

// MARK: - Pure layout

/** `LumaGrid.cells`. */
export const lumaGridCells = 8;

/** Mean luma per cell of an 8×8 RGBA downsample. */
export function lumaGridFromRGBA(pixels: ArrayLike<number>): number[] {
  const n = lumaGridCells * lumaGridCells;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.fround(pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114));
  return out;
}

export function lumaGridMeanDiff(a: readonly number[], b: readonly number[]): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length;
}

/** Candidate sample times: `stride(from: start + interval/2, to: end, by: interval)`, interval ≥ 1s. */
export function overviewCandidateTimes(start: number, end: number): number[] {
  const span = Math.max(end - start, 0.001);
  const interval = Math.max(1, span / candidateTarget);
  const times: number[] = [];
  for (let i = 0; ; i++) {
    const t = start + interval / 2 + i * interval;
    if (!(t < end)) break;
    times.push(t);
  }
  return times;
}

/** Evenly thins `items` down to `overviewMaxTiles` (`tiles[Int(i * step)]`). */
export function thinOverviewTiles<T>(items: readonly T[]): T[] {
  if (items.length <= overviewMaxTiles) return [...items];
  const step = items.length / overviewMaxTiles;
  return Array.from({ length: overviewMaxTiles }, (_, i) => items[Math.trunc(i * step)]);
}

export interface OverviewGrid {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export function overviewGrid(tileCount: number): OverviewGrid {
  const columns = Math.min(overviewColumns, tileCount);
  const rows = Math.floor((tileCount + columns - 1) / columns);
  return { columns, rows, width: columns * overviewTileWidth, height: rows * overviewTileHeight };
}

/** Top-left pixel origin of tile `index` (row-major, top row first). */
export function overviewTileOrigin(index: number, columns: number): { x: number; y: number } {
  return { x: (index % columns) * overviewTileWidth, y: Math.floor(index / columns) * overviewTileHeight };
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function overviewTimeLabel(t: number): string {
  const s = swiftRound(t);
  const two = (n: number): string => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.trunc(s / 3600)}:${two(Math.trunc((s % 3600) / 60))}:${two(s % 60)}`
    : `${Math.trunc(s / 60)}:${two(s % 60)}`;
}

// MARK: - Rendering

function lumaGrid(source: OffscreenCanvas): number[] {
  const small = new OffscreenCanvas(lumaGridCells, lumaGridCells);
  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new OverviewError("Canvas 2D unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, lumaGridCells, lumaGridCells);
  return lumaGridFromRGBA(ctx.getImageData(0, 0, lumaGridCells, lumaGridCells).data);
}

interface Tile {
  t: number;
  canvas: OffscreenCanvas;
}

function compose(tiles: readonly Tile[]): OffscreenCanvas {
  const grid = overviewGrid(tiles.length);
  const canvas = new OffscreenCanvas(grid.width, grid.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new OverviewError("Failed to compose overview");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, grid.width, grid.height);
  ctx.imageSmoothingQuality = "high";
  ctx.font = "bold 10px Helvetica, Arial, sans-serif";
  ctx.textBaseline = "alphabetic";
  tiles.forEach((tile, i) => {
    const { x, y } = overviewTileOrigin(i, grid.columns);
    ctx.drawImage(tile.canvas, x, y, overviewTileWidth, overviewTileHeight);
    const label = overviewTimeLabel(tile.t);
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(x, y, Math.trunc(ctx.measureText(label).width) + 8, overviewLabelHeight);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 4, y + overviewLabelHeight - 3.5);
  });
  return canvas;
}

/** `OverviewRenderer.make`: storyboard of the video at `url` between `start` and `end` seconds. */
export async function makeOverview(url: string, start: number, end: number): Promise<OverviewSheet> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new OverviewError("No video track available");
    const times = overviewCandidateTimes(start, end);
    if (times.length === 0) throw new OverviewError("Window too short for a overview");
    const sink = new VideoSampleSink(track);
    let tiles: Tile[] = [];
    let lastGrid: number[] | undefined;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (!sample) continue;
      try {
        const last = tiles[tiles.length - 1];
        if (last && sample.timestamp <= last.t) continue;
        const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        sample.draw(ctx, 0, 0);
        const grid = lumaGrid(canvas);
        if (lastGrid && !(lumaGridMeanDiff(grid, lastGrid) > overviewPromoteDiff)) continue;
        lastGrid = grid;
        tiles.push({ t: sample.timestamp, canvas });
      } finally {
        sample.close();
      }
    }
    if (tiles.length === 0) throw new OverviewError("Could not decode frames for overview");
    tiles = thinOverviewTiles(tiles);
    const jpeg = await encodeJPEG(compose(tiles), jpegQuality).catch(() => {
      throw new OverviewError("Failed to compose overview");
    });
    return { jpeg, timestamps: tiles.map((t) => t.t) };
  } finally {
    input.dispose();
  }
}
