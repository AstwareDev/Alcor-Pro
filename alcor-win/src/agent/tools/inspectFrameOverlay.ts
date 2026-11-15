// Port of InspectFrameOverlay.swift (+ the ImageEncoder budget helpers it uses): the 0-1 coordinate grid and tick
// labels burned into frames the agent looks at. Layout is pure and in top-left canvas coordinates (the Swift
// draws in CoreGraphics' bottom-left space; every y below is already flipped).

export const inspectOverlayMetadataNote = "0-1, origin top-left";

/** `ImageEncoder.maxBytes` / `maxLongestEdge` / JPEG quality ladder. */
export const imageEncoderMaxBytes = 3_500_000;
export const imageEncoderMaxLongestEdge = 1568;
const jpegQualities = [0.85, 0.7, 0.55, 0.4];

export interface OverlayLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GridStroke {
  lineWidth: number;
  /** Gray level 0-1 (stroke colour is `gray` on every channel). */
  gray: number;
  alpha: number;
  lines: OverlayLine[];
}

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayLabel {
  text: string;
  /** Chip behind the text. */
  chip: OverlayRect;
  /** Text origin: x of the left edge, y of the baseline. */
  x: number;
  baselineY: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(lo, v), hi);

/** Minor lines every 0.05, major lines at 0, 0.5 and 1; drawn dark-under-light, minor first. */
export function inspectGridStrokes(w: number, h: number): GridStroke[] {
  const lines = (major: boolean): OverlayLine[] => {
    const out: OverlayLine[] = [];
    for (let i = 0; i <= 20; i++) {
      if ((i % 10 === 0) !== major) continue;
      const t = i / 20;
      const x = clamp(t * w, 0.5, w - 0.5);
      out.push({ x1: x, y1: 0, x2: x, y2: h });
      const y = clamp(t * h, 0.5, h - 0.5);
      out.push({ x1: 0, y1: y, x2: w, y2: y });
    }
    return out;
  };
  const minor = lines(false);
  const major = lines(true);
  return [
    { lineWidth: 2, gray: 0, alpha: 0.55, lines: minor },
    { lineWidth: 1, gray: 1, alpha: 0.75, lines: minor },
    { lineWidth: 2.5, gray: 0, alpha: 0.65, lines: major },
    { lineWidth: 1.5, gray: 1, alpha: 0.95, lines: major },
  ];
}

export function inspectTickFontSize(w: number, h: number): number {
  return Math.min(11, Math.max(8, Math.min(w, h) / 42));
}

export function inspectTickText(t: number): string {
  return t === 0 || t === 1 ? String(t) : t.toFixed(1);
}

/** Tick labels along the bottom edge (x ticks, except 1) and right edge (y ticks), with their chips. */
export function inspectTickLabels(w: number, h: number, textWidth: (text: string, fontSize: number) => number): OverlayLabel[] {
  const fontSize = inspectTickFontSize(w, h);
  const chipHeight = fontSize + 3;
  const labels: OverlayLabel[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const text = inspectTickText(t);
    const textW = textWidth(text, fontSize);
    const x = t * w;
    const y = (1 - t) * h;
    if (t !== 1) {
      const chipX = Math.min(Math.max(0, x - textW / 2), w - textW - 2);
      labels.push({
        text,
        chip: { x: chipX, y: h - 2 - chipHeight, width: textW + 4, height: chipHeight },
        x: Math.min(Math.max(2, x - textW / 2), w - textW - 2) + 2,
        baselineY: h - 4,
      });
    }
    const chipY = Math.min(Math.max(2, y - fontSize / 2), h - fontSize - 4);
    const baseline = Math.min(Math.max(4, y - fontSize / 2 + 2), h - fontSize - 2);
    labels.push({
      text,
      chip: { x: w - textW - 6, y: h - chipY - chipHeight, width: textW + 4, height: chipHeight },
      x: w - textW - 4,
      baselineY: h - baseline,
    });
  }
  return labels;
}

export const inspectCaptionFontSize = 12;
const captionChipHeight = 16;

/** Top-left caption chip ("f12"). */
export function inspectCaptionLayout(textW: number): { chip: OverlayRect; x: number; baselineY: number } {
  return { chip: { x: 0, y: 0, width: textW + 10, height: captionChipHeight }, x: 5, baselineY: captionChipHeight - 4 };
}

// MARK: - Drawing

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const fontFamily = "Helvetica, Arial, sans-serif";

function newCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  return ctx;
}

function fillChip(ctx: Ctx, r: OverlayRect): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(r.x, r.y, r.width, r.height);
}

function drawText(ctx: Ctx, text: string, x: number, baselineY: number): void {
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, baselineY);
}

/** Draws the grid, tick labels and optional caption over whatever `ctx` already holds (size `w`×`h`). */
export function drawInspectOverlay(ctx: Ctx, w: number, h: number, caption?: string): void {
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const stroke of inspectGridStrokes(w, h)) {
    ctx.lineWidth = stroke.lineWidth;
    const c = Math.round(stroke.gray * 255);
    ctx.strokeStyle = `rgba(${c}, ${c}, ${c}, ${stroke.alpha})`;
    ctx.beginPath();
    for (const l of stroke.lines) {
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
    }
    ctx.stroke();
  }
  const fontSize = inspectTickFontSize(w, h);
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  const labels = inspectTickLabels(w, h, (text) => ctx.measureText(text).width);
  for (const label of labels) {
    fillChip(ctx, label.chip);
    drawText(ctx, label.text, label.x, label.baselineY);
  }
  if (caption !== undefined) {
    ctx.font = `bold ${inspectCaptionFontSize}px ${fontFamily}`;
    const layout = inspectCaptionLayout(ctx.measureText(caption).width);
    fillChip(ctx, layout.chip);
    drawText(ctx, caption, layout.x, layout.baselineY);
  }
  ctx.restore();
}

/** `InspectFrameOverlay.apply`: a copy of `image` with the grid (and caption) drawn on top. */
export function applyInspectOverlay(image: Surface | ImageBitmap, caption?: string): OffscreenCanvas {
  const width = image.width, height = image.height;
  const canvas = newCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0);
  drawInspectOverlay(ctx, canvas.width, canvas.height, caption);
  return canvas;
}

/** `InspectFrameOverlay.hasAlpha`: true when any pixel is not fully opaque. */
export function canvasHasAlpha(canvas: OffscreenCanvas): boolean {
  const data = context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

export interface EncodedImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

async function blobBytes(canvas: OffscreenCanvas, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export const encodeJPEG = async (canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> => blobBytes(canvas, "image/jpeg", quality);

export const encodePNG = async (canvas: OffscreenCanvas): Promise<Uint8Array> => blobBytes(canvas, "image/png");

/** `ImageEncoder.encodeWithinBudget`: PNG when preferred and small enough, else the first JPEG quality that fits. */
export async function encodeWithinBudget(canvas: OffscreenCanvas, preferPNG = false): Promise<EncodedImage | null> {
  if (preferPNG) {
    const png = await encodePNG(canvas);
    if (png.length <= imageEncoderMaxBytes) return { bytes: png, mime: "image/png" };
  }
  for (const quality of jpegQualities) {
    const jpeg = await encodeJPEG(canvas, quality);
    if (jpeg.length <= imageEncoderMaxBytes) return { bytes: jpeg, mime: "image/jpeg" };
  }
  return null;
}

/** `InspectFrameOverlay.encode`: overlay, then PNG for images with transparency and JPEG otherwise. */
export async function encodeInspectOverlay(image: OffscreenCanvas, caption?: string): Promise<EncodedImage | null> {
  const overlaid = applyInspectOverlay(image, caption);
  return encodeWithinBudget(overlaid, canvasHasAlpha(image));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
