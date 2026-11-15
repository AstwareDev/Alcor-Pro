import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";
import { mediaUrl } from "../../media/mediaUrl";
import { fitWithin } from "../../media/thumbnailMath";
import {
  activeTranscriptionBackend, transcribeCached, type TranscribeRequest,
} from "../../transcription/transcriptionBackend";
import { TranscriptionError, type TranscriptionResult } from "../../transcription/transcription";
import { cachedOnDisk, filterTranscript, type SourceRange } from "../../transcription/transcriptCache";

// Pixel work behind inspect_media: port of InspectFrameOverlay.swift, OverviewRenderer.swift, the frame sampling
// of readVideo/readImage and ImageEncoder.encodeWithinBudget. It needs canvas + WebCodecs, so tool code reaches it
// through `InspectMediaBackend` and tests substitute a fake.

export const inspectGridNote = "0-1, origin top-left";

const maxBytes = 3_500_000;
const maxLongestEdge = 1568;
const jpegQualities = [0.85, 0.7, 0.55, 0.4];
const frameMaxDimension = 512;
export const readVideoJPEGQuality = 0.7;

const tileWidth = 160;
const tileHeight = 90;
const columns = 6;
const maxTiles = 36;
const candidateTarget = 120;
const promoteDiff = 12;
const labelHeight = 14;
const lumaCells = 8;

export interface EncodedStill {
  base64: string;
  mime: string;
  encodedByteSize: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface SampledFrame {
  timestamp: number;
  base64: string;
}

export interface OverviewSheet {
  base64: string;
  timestamps: number[];
}

export interface InspectTranscribeRequest {
  path: string;
  range: SourceRange | undefined;
  durationSeconds: number | undefined;
  language: string | undefined;
}

export interface InspectMediaBackend {
  /** Downscaled still with the coordinate grid; null when the file can't be decoded. */
  readImage(path: string): Promise<EncodedStill | null>;
  /** Frames at `times` (source seconds); "noVideoTrack" when nothing decodable. Undecodable times are skipped. */
  videoFrames(path: string, times: readonly number[]): Promise<SampledFrame[] | "noVideoTrack">;
  /** Storyboard of visually distinct moments; throws with a readable message on failure. */
  overview(path: string, start: number, end: number): Promise<OverviewSheet>;
  transcribe(req: InspectTranscribeRequest): Promise<TranscriptionResult>;
}

type Canvas2D = OffscreenCanvasRenderingContext2D;

function newCanvas(width: number, height: number): { canvas: OffscreenCanvas; ctx: Canvas2D } {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  return { canvas, ctx };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function encodeBlob(canvas: OffscreenCanvas, type: "image/jpeg" | "image/png", quality?: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** `ImageEncoder.encodeWithinBudget`: PNG first when asked and small enough, else JPEG at falling quality. */
async function encodeWithinBudget(canvas: OffscreenCanvas, preferPNG: boolean): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (preferPNG) {
    const png = await encodeBlob(canvas, "image/png");
    if (png.length <= maxBytes) return { bytes: png, mime: "image/png" };
  }
  for (const quality of jpegQualities) {
    const jpeg = await encodeBlob(canvas, "image/jpeg", quality);
    if (jpeg.length <= maxBytes) return { bytes: jpeg, mime: "image/jpeg" };
  }
  return null;
}

function fillChip(ctx: Canvas2D, x: number, y: number, width: number, height: number): void {
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(x, y, width, height);
}

function strokeGrid(ctx: Canvas2D, w: number, h: number, lineWidth: number, gray: number, alpha: number, major: boolean): void {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = `rgba(${gray},${gray},${gray},${alpha})`;
  ctx.beginPath();
  for (let i = 0; i <= 20; i++) {
    if (i % 10 === 0 !== major) continue;
    const t = i / 20;
    const x = Math.min(Math.max(0.5, t * w), w - 0.5);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    const y = Math.min(Math.max(0.5, t * h), h - 0.5);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/** Port of `InspectFrameOverlay.apply`: 0-1 grid (origin top-left) with tick labels, drawn over the canvas. */
export function drawGridOverlay(ctx: Canvas2D, w: number, h: number): void {
  strokeGrid(ctx, w, h, 2, 0, 0.55, false);
  strokeGrid(ctx, w, h, 1, 255, 0.75, false);
  strokeGrid(ctx, w, h, 2.5, 0, 0.65, true);
  strokeGrid(ctx, w, h, 1.5, 255, 0.95, true);
  const fontSize = Math.min(11, Math.max(8, Math.min(w, h) / 42));
  ctx.font = `bold ${fontSize}px Arial, Helvetica, sans-serif`;
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const label = t === 0 || t === 1 ? String(i / 10) : t.toFixed(1);
    const textW = ctx.measureText(label).width;
    const x = t * w;
    const y = t * h;
    ctx.fillStyle = "#fff";
    if (t !== 1) {
      const chipX = Math.min(Math.max(0, x - textW / 2), w - textW - 2);
      fillChip(ctx, chipX, h - 2 - (fontSize + 3), textW + 4, fontSize + 3);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, Math.min(Math.max(2, x - textW / 2), w - textW - 2) + 2, h - 4);
    }
    const chipBottom = Math.min(Math.max(2, h - y - fontSize / 2), h - fontSize - 4);
    fillChip(ctx, w - textW - 6, h - (chipBottom + fontSize + 3), textW + 4, fontSize + 3);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, w - textW - 4, h - Math.min(Math.max(4, h - y - fontSize / 2 + 2), h - fontSize - 2));
  }
}

function hasAlpha(ctx: Canvas2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

async function readImage(path: string): Promise<EncodedStill | null> {
  let full: ImageBitmap;
  try {
    const res = await fetch(mediaUrl(path));
    if (!res.ok) return null;
    full = await createImageBitmap(await res.blob(), { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const size = fitWithin(full.width, full.height, maxLongestEdge);
    const { canvas, ctx } = newCanvas(size.width, size.height);
    ctx.drawImage(full, 0, 0, size.width, size.height);
    const alpha = hasAlpha(ctx, size.width, size.height);
    drawGridOverlay(ctx, size.width, size.height);
    const encoded = await encodeWithinBudget(canvas, alpha);
    if (!encoded) return null;
    return {
      base64: toBase64(encoded.bytes),
      mime: encoded.mime,
      encodedByteSize: encoded.bytes.length,
      pixelWidth: full.width,
      pixelHeight: full.height,
    };
  } finally {
    full.close();
  }
}

function openInput(path: string): Input<UrlSource> {
  return new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
}

async function videoFrames(path: string, times: readonly number[]): Promise<SampledFrame[] | "noVideoTrack"> {
  const input = openInput(path);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return "noVideoTrack";
    const size = fitWithin(await track.getDisplayWidth(), await track.getDisplayHeight(), frameMaxDimension);
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: "fill" });
    const first = await track.getFirstTimestamp();
    const frames: SampledFrame[] = [];
    for (const t of times) {
      try {
        const wrapped = await sink.getCanvas(Math.max(t, first));
        if (!wrapped) continue;
        const { canvas, ctx } = newCanvas(size.width, size.height);
        ctx.drawImage(wrapped.canvas, 0, 0, size.width, size.height);
        drawGridOverlay(ctx, size.width, size.height);
        frames.push({ timestamp: t, base64: toBase64(await encodeBlob(canvas, "image/jpeg", readVideoJPEGQuality)) });
      } catch {
        continue;
      }
    }
    return frames;
  } finally {
    input.dispose();
  }
}

function lumaGrid(source: CanvasImageSource): number[] {
  const { canvas, ctx } = newCanvas(lumaCells, lumaCells);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, lumaCells, lumaCells);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out: number[] = [];
  for (let i = 0; i < lumaCells * lumaCells; i++) out.push(px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114);
  return out;
}

function lumaMeanDiff(a: readonly number[], b: readonly number[]): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length;
}

/** `OverviewRenderer.timeLabel` */
function overviewTimeLabel(t: number): string {
  const s = Math.round(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.trunc(s / 3600)}:${two(Math.trunc((s % 3600) / 60))}:${two(s % 60)}` : `${Math.trunc(s / 60)}:${two(s % 60)}`;
}

async function renderOverview(path: string, start: number, end: number): Promise<OverviewSheet> {
  const input = openInput(path);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error("No video track available");
    const span = Math.max(end - start, 0.001);
    const interval = Math.max(1, span / candidateTarget);
    const times: number[] = [];
    for (let t = start + interval / 2; t < end; t += interval) times.push(t);
    if (times.length === 0) throw new Error("Window too short for a overview");

    const sink = new CanvasSink(track, { width: tileWidth * 2, height: tileHeight * 2, fit: "fill" });
    let tiles: { t: number; canvas: OffscreenCanvas }[] = [];
    let lastGrid: number[] | undefined;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (!wrapped) continue;
      const last = tiles[tiles.length - 1];
      if (last && wrapped.timestamp <= last.t) continue;
      const grid = lumaGrid(wrapped.canvas);
      if (lastGrid && !(lumaMeanDiff(grid, lastGrid) > promoteDiff)) continue;
      lastGrid = grid;
      const copy = newCanvas(tileWidth * 2, tileHeight * 2);
      copy.ctx.drawImage(wrapped.canvas, 0, 0, tileWidth * 2, tileHeight * 2);
      tiles.push({ t: wrapped.timestamp, canvas: copy.canvas });
    }
    if (tiles.length === 0) throw new Error("Could not decode frames for overview");
    if (tiles.length > maxTiles) {
      const step = tiles.length / maxTiles;
      const all = tiles;
      tiles = Array.from({ length: maxTiles }, (_, i) => all[Math.trunc(i * step)]);
    }

    const cols = Math.min(columns, tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    const { canvas, ctx } = newCanvas(cols * tileWidth, rows * tileHeight);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.font = "bold 10px Arial, Helvetica, sans-serif";
    ctx.textBaseline = "alphabetic";
    tiles.forEach((tile, i) => {
      const x = (i % cols) * tileWidth;
      const y = Math.trunc(i / cols) * tileHeight;
      ctx.drawImage(tile.canvas, x, y, tileWidth, tileHeight);
      const label = overviewTimeLabel(tile.t);
      const width = Math.trunc(ctx.measureText(label).width);
      fillChip(ctx, x, y, width + 8, labelHeight);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 4, y + labelHeight - 3.5);
    });
    return { base64: toBase64(await encodeBlob(canvas, "image/jpeg", readVideoJPEGQuality)), timestamps: tiles.map((t) => t.t) };
  } finally {
    input.dispose();
  }
}

/** Cloud transcription (the only kind on Windows); a cached whole-file transcript answers windowed reads. */
async function transcribe(req: InspectTranscribeRequest): Promise<TranscriptionResult> {
  if (req.range && req.language === undefined) {
    const full = await cachedOnDisk(req.path);
    if (full) return filterTranscript(full, req.range);
  }
  const backend = activeTranscriptionBackend();
  if (backend === undefined) throw new TranscriptionError("noBackend");
  const request: TranscribeRequest = { path: req.path, range: req.range, durationSeconds: req.durationSeconds, language: req.language, backend };
  return transcribeCached(request);
}

export const defaultInspectBackend: InspectMediaBackend = { readImage, videoFrames, overview: renderOverview, transcribe };

let current: InspectMediaBackend = defaultInspectBackend;

export function inspectBackend(): InspectMediaBackend {
  return current;
}

/** Tests substitute a fake; pass undefined to restore the canvas implementation. */
export function setInspectBackend(backend: InspectMediaBackend | undefined): void {
  current = backend ?? defaultInspectBackend;
}
