import { masksAreAnimated, type Mask } from "../../model/mask";
import { offscreenSurface, rasterizeMasks, type MaskScratch, type MaskSurface, type MaskSurfaceFactory } from "./rasterize";

/** Largest mask raster edge in pixels; bigger clips are rasterized smaller and sampled bilinearly. */
export const maxMaskRasterEdge = 2048;

interface Entry {
  masks: readonly Mask[];
  animated: boolean;
  offset: number;
  w: number;
  h: number;
  pxScale: number;
  surface: MaskSurface;
  tex: WebGLTexture | null;
  /** False when no mask contributes, so the layer is drawn unmasked. */
  active: boolean;
  lastUsed: number;
}

/** Raster size and feather scale for a clip rect of `clipW` x `clipH` timeline pixels drawn at render `scale`. */
export function maskRasterSize(clipW: number, clipH: number, scale: number): { w: number; h: number; pxScale: number } {
  let w = Math.max(1, clipW * scale), h = Math.max(1, clipH * scale);
  let pxScale = scale;
  const big = Math.max(w, h);
  if (big > maxMaskRasterEdge) {
    const k = maxMaskRasterEdge / big;
    w *= k;
    h *= k;
    pxScale *= k;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), pxScale };
}

/**
 * Per-layer mask alpha textures. A mask stack is rasterized (OffscreenCanvas 2D) only when its evaluated state, size
 * or scale changes: static masks are keyed by the identity of the frozen `masks` array, animated ones by clip offset.
 */
export class MaskTextures {
  private entries = new Map<string, Entry>();
  private scratch: MaskScratch | null = null;
  private animatedMemo = new WeakMap<readonly Mask[], boolean>();
  rasterCount = 0;

  constructor(private readonly factory: MaskSurfaceFactory = offscreenSurface) {}

  private isAnimated(masks: readonly Mask[]): boolean {
    let v = this.animatedMemo.get(masks);
    if (v === undefined) {
      v = masksAreAnimated(masks);
      this.animatedMemo.set(masks, v);
    }
    return v;
  }

  private scratchFor(w: number, h: number): MaskScratch {
    const s = this.scratch ?? (this.scratch = { shape: this.factory(w, h), blur: this.factory(w, h) });
    for (const surface of [s.shape, s.blur]) {
      if (surface.width !== w) surface.width = w;
      if (surface.height !== h) surface.height = h;
    }
    return s;
  }

  /** The mask alpha texture for the layer, or null when nothing contributes. */
  acquire(
    gl: WebGL2RenderingContext, key: string, masks: readonly Mask[], offset: number,
    w: number, h: number, pxScale: number, frameNo: number,
  ): WebGLTexture | null {
    let e = this.entries.get(key);
    const animated = this.isAnimated(masks);
    const fresh = e !== undefined && e.masks === masks && e.w === w && e.h === h && e.pxScale === pxScale &&
      (!animated || e.offset === offset);
    if (!e) {
      e = { masks, animated, offset, w, h, pxScale, surface: this.factory(w, h), tex: null, active: false, lastUsed: frameNo };
      this.entries.set(key, e);
    }
    e.lastUsed = frameNo;
    if (fresh) return e.active ? e.tex : null;

    if (e.surface.width !== w) e.surface.width = w;
    if (e.surface.height !== h) e.surface.height = h;
    e.masks = masks;
    e.animated = animated;
    e.offset = offset;
    e.w = w;
    e.h = h;
    e.pxScale = pxScale;
    e.active = rasterizeMasks(e.surface, this.scratchFor(w, h), masks, offset, pxScale);
    this.rasterCount += 1;
    if (!e.active) return null;
    if (!e.tex) {
      e.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, e.surface as unknown as OffscreenCanvas);
    return e.tex;
  }

  /** Frees layers unused for `idleFrames`. */
  collect(gl: WebGL2RenderingContext, frameNo: number, idleFrames: number): void {
    for (const [key, e] of this.entries) {
      if (frameNo - e.lastUsed <= idleFrames) continue;
      if (e.tex) gl.deleteTexture(e.tex);
      this.entries.delete(key);
    }
  }

  forget(gl: WebGL2RenderingContext, key: string): void {
    const e = this.entries.get(key);
    if (e?.tex) gl.deleteTexture(e.tex);
    this.entries.delete(key);
  }

  /** Drops everything; `gl` is omitted when the context is gone. */
  clear(gl?: WebGL2RenderingContext): void {
    if (gl) for (const e of this.entries.values()) if (e.tex) gl.deleteTexture(e.tex);
    this.entries.clear();
    this.scratch = null;
  }
}
