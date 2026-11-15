import { maskExpansionAt, maskFeatherAt, maskOpacityAt, maskPathAt, type Mask, type MaskPath } from "../../model/mask";

/** The 2D-context subset used by the rasterizer (OffscreenCanvasRenderingContext2D satisfies it). */
export interface MaskContext2D {
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  filter: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  drawImage(image: MaskSurface, x: number, y: number): void;
}

export interface MaskSurface {
  width: number;
  height: number;
  getContext(kind: "2d"): MaskContext2D | null;
}

export type MaskSurfaceFactory = (w: number, h: number) => MaskSurface;

export const minMaskVertices = 3;

/** Blur sigma per unit of feather: feather behaves like a Gaussian with sigma = feather / 2. */
export const featherSigmaFactor = 0.5;

function tracePath(ctx: MaskContext2D, path: MaskPath, w: number, h: number): void {
  const vs = path.vertices;
  const first = vs[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x * w, first.y * h);
  const segments = path.closed ? vs.length : vs.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    if (!a || !b) continue;
    ctx.bezierCurveTo((a.x + a.outX) * w, (a.y + a.outY) * h, (b.x + b.inX) * w, (b.y + b.inY) * h, b.x * w, b.y * h);
  }
  if (path.closed) ctx.closePath();
}

function compositeFor(mode: Mask["mode"]): GlobalCompositeOperation {
  switch (mode) {
    case "add": return "source-over";
    case "subtract": return "destination-out";
    case "intersect": return "destination-in";
    case "difference": return "xor";
  }
}

export interface MaskScratch {
  shape: MaskSurface;
  blur: MaskSurface;
}

/**
 * Rasterizes `masks` (bottom to top, combined by mode) into the alpha channel of `out` at clip-relative frame `offset`.
 * `pxScale` converts feather/expansion pixels (timeline resolution) to raster pixels. Returns false when no mask
 * contributes (every path is open or has fewer than three vertices), leaving `out` cleared.
 */
export function rasterizeMasks(out: MaskSurface, scratch: MaskScratch, masks: readonly Mask[], offset: number, pxScale: number): boolean {
  const w = out.width, h = out.height;
  const acc = out.getContext("2d");
  const sctx = scratch.shape.getContext("2d");
  const bctx = scratch.blur.getContext("2d");
  if (!acc || !sctx || !bctx) return false;
  acc.globalCompositeOperation = "source-over";
  acc.globalAlpha = 1;
  acc.clearRect(0, 0, w, h);

  let any = false;
  for (const mask of masks) {
    const path = maskPathAt(mask, offset);
    if (path.vertices.length < minMaskVertices || !path.closed) continue;
    const feather = maskFeatherAt(mask, offset) * pxScale;
    const expansion = maskExpansionAt(mask, offset) * pxScale;
    const opacity = maskOpacityAt(mask, offset);

    // Shape plus expansion as opaque coverage.
    sctx.globalCompositeOperation = "source-over";
    sctx.globalAlpha = 1;
    sctx.filter = "none";
    sctx.clearRect(0, 0, w, h);
    sctx.fillStyle = "#000";
    sctx.strokeStyle = "#000";
    tracePath(sctx, path, w, h);
    sctx.fill();
    if (expansion !== 0) {
      sctx.lineJoin = "round";
      sctx.lineWidth = Math.abs(expansion) * 2;
      sctx.globalCompositeOperation = expansion > 0 ? "source-over" : "destination-out";
      sctx.stroke();
      sctx.globalCompositeOperation = "source-over";
    }

    // Feather: blur into the second scratch.
    let result = scratch.shape;
    let rctx = sctx;
    if (feather > 0) {
      bctx.globalCompositeOperation = "source-over";
      bctx.globalAlpha = 1;
      bctx.clearRect(0, 0, w, h);
      bctx.filter = `blur(${feather * featherSigmaFactor}px)`;
      bctx.drawImage(scratch.shape, 0, 0);
      bctx.filter = "none";
      result = scratch.blur;
      rctx = bctx;
    }

    // Invert: xor with an opaque rect leaves 1 - alpha.
    if (mask.inverted) {
      rctx.globalCompositeOperation = "xor";
      rctx.globalAlpha = 1;
      rctx.fillStyle = "#000";
      rctx.fillRect(0, 0, w, h);
      rctx.globalCompositeOperation = "source-over";
    }

    // Combine. A leading subtract mask starts from a full matte; other leading modes behave like add.
    if (!any && mask.mode === "subtract") {
      acc.fillStyle = "#000";
      acc.fillRect(0, 0, w, h);
    }
    acc.globalAlpha = opacity;
    acc.globalCompositeOperation = any || mask.mode === "subtract" ? compositeFor(mask.mode) : "source-over";
    acc.drawImage(result, 0, 0);
    acc.globalAlpha = 1;
    acc.globalCompositeOperation = "source-over";
    any = true;
  }
  return any;
}

export function offscreenSurface(w: number, h: number): MaskSurface {
  return new OffscreenCanvas(w, h) as unknown as MaskSurface;
}
