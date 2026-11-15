import { keyframeTrackIsActive } from "../model/keyframe";
import type { Size } from "../model/geometry";
import { cropIsIdentity, cropVisibleHeightFraction, cropVisibleWidthFraction, transformHasTiltRotation } from "../model/timeline";
import { blendModeIndex, compositeFrag, prepFrag, presentFrag, stencilFrag } from "./compositorShaders";
import { edgeRoundingPasses, effectPasses, type PassTexture, type RenderPass } from "./effects/effectPasses";
import type { CubeLUT } from "./effects/lutLoader";
import {
  affineTransform, canvasRotationTransform, type Affine, type FrameEffect, type FrameGraph, type FrameLayer,
  type AdjustmentLayer, type GroupLayer, type MediaLayer, type TextLayer, type TransitionLayer,
} from "./frameGraph";
import { MaskTextures, maskRasterSize } from "./masks/maskTextures";
import { FULLSCREEN_VERTEX_SHADER, SHADERS } from "./shaders";
import { TextRenderer, type TextRaster } from "./textRenderer";
import { textTiltCorners } from "./textTiltGeometry";
import { transitionFrag, transitionKindIndex } from "../transitions/transitionShader";

export type PreviewQuality = "full" | "half" | "quarter";

export const previewQualityScale: Record<PreviewQuality, number> = { full: 1, half: 0.5, quarter: 0.25 };

/** A decoded frame for a media layer. `source: null` = keep showing the last uploaded frame for this layer. */
export interface SourceFrame {
  source: TexImageSource | null;
  width: number;
  height: number;
  /** Changes whenever the pixels change; equal versions skip the upload. */
  version: number | string;
  premultiplied: boolean;
}

export interface TextureProvider {
  media(layer: MediaLayer): SourceFrame | null;
}

export interface CompositorOptions {
  loadLut?: (path: string) => CubeLUT | undefined;
}

export interface CompositorStats {
  layers: number;
  passes: number;
  uploads: number;
}

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, { loc: WebGLUniformLocation; type: number }>;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  inUse: boolean;
  lastUsed: number;
}

interface LayerTexture {
  tex: WebGLTexture;
  w: number;
  h: number;
  version: number | string;
  /** Identity of the uploaded source; a different object always re-uploads. */
  origin: TexImageSource | null;
  premultiplied: boolean;
  lastUsed: number;
}

interface PassCache {
  offset: number;
  w: number;
  h: number;
  scale: number;
  passes: RenderPass[];
}

type GLCanvas = HTMLCanvasElement | OffscreenCanvas;

const idleFramesBeforeFree = 120;

/**
 * WebGL2 compositor shared by preview and export.
 * Layer textures and effect chains carry straight alpha (shaders/ contract); placement outputs premultiplied
 * source-over (ONE, ONE_MINUS_SRC_ALPHA) into accumulators that are always opaque, so premultiplied == straight there.
 */
export class Compositor {
  readonly text = new TextRenderer();
  readonly stats: CompositorStats = { layers: 0, passes: 0, uploads: 0 };
  private gl: WebGL2RenderingContext;
  private lost = false;
  private scaleValue = 1;
  private frameNo = 0;
  private programs = new Map<string, Program>();
  private pool: Target[] = [];
  private accum: Target | null = null;
  private readback: Target | null = null;
  private layerTextures = new Map<string, LayerTexture>();
  private lutTextures = new Map<string, WebGLTexture>();
  private passCache = new WeakMap<object, PassCache>();
  private readonly masks = new MaskTextures();
  /** Mask alpha for the next compositeLayer call (consumed by it); layer-space rect in `maskRect`. */
  private maskTex: WebGLTexture | null = null;
  private readonly maskRect = new Float32Array(4);
  private vao: WebGLVertexArrayObject | null = null;
  private floatTargets = false;
  private hasFrame = false;
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
  };
  private readonly onRestored = (): void => {
    this.init();
    this.lost = false;
    this.onContextRestored?.();
  };
  /** Called after a lost context comes back; the owner should re-render. */
  onContextRestored?: () => void;

  // Scratch values reused across layers (no per-frame allocation).
  private readonly inv = new Float32Array(9);
  private readonly fwd = new Float64Array(9);
  private readonly region = new Float32Array(4);
  private readonly visible = new Float32Array(4);
  private readonly bbox = new Int32Array(4);
  private readonly passOutputs: Target[] = [];

  constructor(private readonly canvas: GLCanvas, private readonly options: CompositorOptions = {}) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.onLost as EventListener);
    canvas.addEventListener("webglcontextrestored", this.onRestored as EventListener);
    this.init();
  }

  get scale(): number {
    return this.scaleValue;
  }

  setScale(scale: number): void {
    this.scaleValue = scale;
  }

  get isContextLost(): boolean {
    return this.lost;
  }

  /** Output size in pixels for a timeline size at the current scale. */
  outputSize(width: number, height: number): Size {
    return { width: Math.max(1, Math.round(width * this.scaleValue)), height: Math.max(1, Math.round(height * this.scaleValue)) };
  }

  render(graph: FrameGraph, provider: TextureProvider): boolean {
    if (this.lost || this.gl.isContextLost()) return false;
    const gl = this.gl;
    this.frameNo += 1;
    this.stats.layers = 0;
    this.stats.passes = 0;
    this.stats.uploads = 0;
    const out = this.outputSize(graph.width, graph.height);
    if (!this.accum || this.accum.w !== out.width || this.accum.h !== out.height) {
      if (this.accum) this.deleteTarget(this.accum);
      this.accum = this.createTarget(out.width, out.height, this.floatTargets);
    }
    if (this.canvas.width !== out.width || this.canvas.height !== out.height) {
      this.canvas.width = out.width;
      this.canvas.height = out.height;
    }
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    this.clearTarget(this.accum, 0, 0, 0, 1);
    this.drawLayers(graph.layers, this.accum, { width: graph.width, height: graph.height }, provider);
    this.present(this.accum, null, true);
    this.hasFrame = true;
    this.collectGarbage();
    return true;
  }

  /** RGBA8 pixels of the last rendered frame, rows top → bottom, in output pixels. */
  readPixels(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    if (!this.accum || !this.hasFrame || this.lost) return out;
    if (!this.readback || this.readback.w !== this.accum.w || this.readback.h !== this.accum.h) {
      if (this.readback) this.deleteTarget(this.readback);
      this.readback = this.createTarget(this.accum.w, this.accum.h, false);
    }
    gl.bindVertexArray(this.vao);
    this.present(this.accum, this.readback, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readback.fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Drops cached per-layer textures (e.g. after the timeline changed media). */
  forgetLayer(key: string): void {
    const t = this.layerTextures.get(key);
    if (t) {
      this.gl.deleteTexture(t.tex);
      this.layerTextures.delete(key);
    }
    this.masks.forget(this.gl, key);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost as EventListener);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored as EventListener);
    if (!this.gl.isContextLost()) this.releaseAll();
    this.text.dispose();
  }

  // MARK: - Setup

  private init(): void {
    const gl = this.gl;
    this.programs = new Map();
    this.pool = [];
    this.accum = null;
    this.readback = null;
    this.layerTextures = new Map();
    this.masks.clear();
    this.lutTextures = new Map();
    this.passCache = new WeakMap();
    this.hasFrame = false;
    this.floatTargets = gl.getExtension("EXT_color_buffer_float") !== null;
    gl.getExtension("OES_texture_float_linear");
    this.vao = gl.createVertexArray();
  }

  private releaseAll(): void {
    const gl = this.gl;
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    for (const t of this.pool) this.deleteTarget(t);
    if (this.accum) this.deleteTarget(this.accum);
    if (this.readback) this.deleteTarget(this.readback);
    for (const t of this.layerTextures.values()) gl.deleteTexture(t.tex);
    for (const t of this.lutTextures.values()) gl.deleteTexture(t);
    this.masks.clear(gl);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.programs.clear();
    this.pool = [];
    this.layerTextures.clear();
    this.lutTextures.clear();
  }

  private program(name: string): Program {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const source = name === "#composite" ? compositeFrag
      : name === "#prep" ? prepFrag
        : name === "#present" ? presentFrag
          : name === "#stencil" ? stencilFrag
            : name === "#transition" ? transitionFrag
            : SHADERS[name];
    if (source === undefined) throw new Error(`Unknown shader ${name}`);
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`Shader ${name}: ${gl.getShaderInfoLog(s) ?? ""}`);
      }
      return s;
    };
    const program = gl.createProgram() as WebGLProgram;
    const vs = compile(gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, source);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program ${name}: ${gl.getProgramInfoLog(program) ?? ""}`);
    }
    const uniforms = new Map<string, { loc: WebGLUniformLocation; type: number }>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(program, info.name);
      if (loc) uniforms.set(info.name.replace(/\[0\]$/, ""), { loc, type: info.type });
    }
    const p = { program, uniforms };
    this.programs.set(name, p);
    return p;
  }

  /** Compiles every effect and compositor program up front (self-test, warm-up). */
  compileAll(): string[] {
    const failures: string[] = [];
    for (const name of [...Object.keys(SHADERS), "#composite", "#prep", "#present", "#stencil", "#transition"]) {
      try {
        this.program(name);
      } catch (e) {
        failures.push(`${name}: ${String(e)}`);
      }
    }
    return failures;
  }

  // MARK: - Targets

  private createTarget(w: number, h: number, float: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    setSampling(gl, gl.LINEAR);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, inUse: false, lastUsed: this.frameNo };
  }

  private deleteTarget(t: Target): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  private acquire(w0: number, h0: number): Target {
    const w = Math.max(1, Math.round(w0)), h = Math.max(1, Math.round(h0));
    for (const t of this.pool) {
      if (!t.inUse && t.w === w && t.h === h) {
        t.inUse = true;
        t.lastUsed = this.frameNo;
        return t;
      }
    }
    const t = this.createTarget(w, h, this.floatTargets);
    t.inUse = true;
    this.pool.push(t);
    return t;
  }

  private release(t: Target): void {
    t.inUse = false;
  }

  private collectGarbage(): void {
    if (this.frameNo % 30 !== 0) return;
    const gl = this.gl;
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const t = this.pool[i] as Target;
      if (!t.inUse && this.frameNo - t.lastUsed > idleFramesBeforeFree) {
        this.deleteTarget(t);
        this.pool.splice(i, 1);
      }
    }
    for (const [key, t] of this.layerTextures) {
      if (this.frameNo - t.lastUsed > idleFramesBeforeFree) {
        gl.deleteTexture(t.tex);
        this.layerTextures.delete(key);
      }
    }
    this.masks.collect(gl, this.frameNo, idleFramesBeforeFree);
  }

  private clearTarget(t: Target, r: number, g: number, b: number, a: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private present(src: Target, dst: Target | null, flip: boolean): void {
    const gl = this.gl;
    const p = this.program("#present");
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, src.w, src.h);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    setInt(gl, p, "uSrc", 0);
    setInt(gl, p, "uFlip", flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // MARK: - Layers

  private drawLayers(layers: readonly FrameLayer[], target: Target, canvas: Size, provider: TextureProvider): void {
    for (let i = 0; i < layers.length; i++) this.drawLayer(layers[i] as FrameLayer, target, canvas, provider);
  }

  private drawLayer(layer: FrameLayer, target: Target, canvas: Size, provider: TextureProvider): void {
    if (layer.kind === "text") this.drawText(layer, target, canvas);
    else if (layer.kind === "adjustment") this.drawAdjustment(layer, target, canvas);
    else if (layer.kind === "transition") this.drawTransition(layer, target, canvas, provider);
    else this.drawVisual(layer, target, canvas, provider);
  }

  /** Adjustment layer: its effects run over everything accumulated so far, then mix back through opacity and masks. */
  private drawAdjustment(layer: AdjustmentLayer, target: Target, canvas: Size): void {
    if (layer.effects.length === 0) return;
    this.stats.layers += 1;
    const effected = this.runEffects(
      target.tex, true, 0, 0, 1, 1, target.w, target.h, layer.effects, layer.effectOffset,
      layer.effectSpatialScale * (target.w / canvas.width), null,
    );
    this.setAffine(affineIdentityValue, 1);
    this.setRect(this.region, 0, 0, target.w, target.h);
    this.setRect(this.visible, 0, 0, target.w, target.h);
    this.prepareMask(layer, canvas, 0, 0, target.w, target.h);
    this.compositeLayer(target, effected.tex, false, layer.opacity, blendModeIndex(layer.blendMode), false);
    this.release(effected);
  }

  /** Both clips render into transparent canvases; one shader pass blends them straight onto the target. */
  private drawTransition(layer: TransitionLayer, target: Target, canvas: Size, provider: TextureProvider): void {
    const gl = this.gl;
    const from = this.acquire(target.w, target.h);
    const to = this.acquire(target.w, target.h);
    this.clearTarget(from, 0, 0, 0, 0);
    this.clearTarget(to, 0, 0, 0, 0);
    if (layer.from) this.drawLayer(layer.from, from, canvas, provider);
    if (layer.to) this.drawLayer(layer.to, to, canvas, provider);
    const p = this.program("#transition");
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    setInt(gl, p, "uFrom", 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, to.tex);
    setInt(gl, p, "uTo", 1);
    setInt(gl, p, "uKind", transitionKindIndex(layer.transitionKind));
    const progress = p.uniforms.get("uProgress");
    if (progress) gl.uniform1f(progress.loc, layer.progress);
    const res = p.uniforms.get("uResolution");
    if (res) gl.uniform2f(res.loc, target.w, target.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    this.stats.passes += 1;
    this.release(from);
    this.release(to);
  }

  /** Media and nest groups: crop → effects → edge rounding → transform → opacity/blend (applyClipPipeline). */
  private drawVisual(layer: MediaLayer | GroupLayer, target: Target, canvas: Size, provider: TextureProvider): void {
    const s = this.scaleValue;
    let srcTex: WebGLTexture;
    let srcW: number, srcH: number;
    let premul: boolean;
    let natW: number, natH: number;
    let group: Target | null = null;
    if (layer.kind === "media") {
      const frame = provider.media(layer);
      const entry = frame ? this.uploadLayerTexture(layer.key, frame) : this.layerTextures.get(layer.key);
      if (!entry) return;
      entry.lastUsed = this.frameNo;
      srcTex = entry.tex;
      srcW = entry.w;
      srcH = entry.h;
      premul = entry.premultiplied;
      natW = layer.natSize?.width ?? entry.w;
      natH = layer.natSize?.height ?? entry.h;
    } else {
      natW = layer.natSize.width;
      natH = layer.natSize.height;
      group = this.acquire(natW * s, natH * s);
      this.clearTarget(group, 0, 0, 0, 1);
      this.drawLayers(layer.children, group, layer.natSize, provider);
      srcTex = group.tex;
      srcW = group.w;
      srcH = group.h;
      premul = true;
    }
    if (!(natW > 0 && natH > 0)) {
      if (group) this.release(group);
      return;
    }
    this.stats.layers += 1;

    // Display-space crop insets → source pixels.
    const crop = layer.crop;
    let cx = 0, cy = 0, cw = natW, ch = natH;
    if (!cropIsIdentity(crop)) {
      cx = crop.left * natW;
      cy = crop.top * natH;
      cw = Math.max(1, cropVisibleWidthFraction(crop) * natW);
      ch = Math.max(1, cropVisibleHeightFraction(crop) * natH);
    }

    const edge = edgeRoundingPasses(layer.edgeRounding, layer.edgeSoftness, cw, ch);
    let effected: Target | null = null;
    if (layer.effects.length > 0 || edge.length > 0) {
      // Effects run in source-pixel space; below Full quality media effects run at the reduced render scale.
      const workX = (srcW / natW) * (layer.kind === "media" ? s : 1);
      const workY = (srcH / natH) * (layer.kind === "media" ? s : 1);
      const w = Math.max(1, Math.round(cw * workX)), h = Math.max(1, Math.round(ch * workY));
      effected = this.runEffects(
        srcTex, premul, cx / natW, cy / natH, cw / natW, ch / natH, w, h,
        layer.effects, layer.effectOffset, layer.effectSpatialScale * workX, edge,
      );
    }

    const a = affineTransform(layer.transform, { width: natW, height: natH }, canvas);
    this.setAffine(a, s);
    if (effected) this.setRect(this.region, cx, cy, cw, ch);
    else this.setRect(this.region, 0, 0, natW, natH);
    this.setRect(this.visible, cx, cy, cw, ch);
    this.prepareMask(layer, canvas, 0, 0, natW, natH);
    this.compositeLayer(
      target, effected ? effected.tex : srcTex, effected ? false : premul,
      layer.opacity, blendModeIndex(layer.blendMode), false,
    );
    if (effected) this.release(effected);
    if (group) this.release(group);
  }

  /** composedTextLayer / footage fill: raster → (effects) → rotation or tilt → opacity/blend. */
  private drawText(layer: TextLayer, target: Target, canvas: Size): void {
    const s = this.scaleValue;
    const renderSize = { width: target.w, height: target.h };
    const raster = this.text.raster(layer, renderSize);
    if (!raster) return;
    const entry = this.uploadLayerTexture(layer.key, {
      source: raster.source, width: raster.rect.width, height: raster.rect.height, version: raster.version, premultiplied: true,
    });
    if (!entry) return;
    entry.lastUsed = this.frameNo;
    this.stats.layers += 1;
    const t = layer.text;
    const entranceOpacity = t.entrance.opacity;
    const footage = t.fillMode === "footage";
    const hasEffects = layer.effects.length > 0;

    // Entrance (scale around the box centre, then dy) maps the raster rect to R'.
    const box = raster.box;
    const ecx = box.x + box.width / 2, ecy = box.y + box.height / 2;
    const es = t.entrance.scale, edy = t.entrance.dy * renderSize.height;
    const entrance: Affine = { a: es, b: 0, c: 0, d: es, tx: ecx - es * ecx, ty: ecy - es * ecy + edy };

    let mask: Target | null = null;
    let effected: Target | null = null;
    const opacity = layer.opacity;
    if (footage || hasEffects) {
      // Text effects (and the stencil mask) run on a full-canvas image.
      const full = this.acquire(target.w, target.h);
      this.clearTarget(full, 0, 0, 0, 0);
      this.setAffine(entrance, 1);
      this.setRasterRects(raster);
      if (footage) {
        this.placeTextTransform(layer, raster, renderSize, entrance, canvas);
        this.compositeLayer(full, entry.tex, true, entranceOpacity, 0, false);
        mask = full;
        const stencil = this.stencil(target, mask, t.matteColor.r, t.matteColor.g, t.matteColor.b, t.matteColor.a);
        this.release(mask);
        if (hasEffects) {
          effected = this.runEffects(stencil.tex, true, 0, 0, 1, 1, target.w, target.h, layer.effects, layer.effectOffset,
            layer.effectSpatialScale * s, null);
          this.release(stencil);
        } else {
          effected = stencil;
        }
        this.setAffine(affineIdentityValue, 1);
        this.setRect(this.region, 0, 0, target.w, target.h);
        this.setRect(this.visible, 0, 0, target.w, target.h);
        this.prepareTextMask(layer, target, canvas);
        this.compositeLayer(target, effected.tex, !hasEffects, opacity, 0, false);
        this.release(effected);
        return;
      }
      this.compositeLayer(full, entry.tex, true, entranceOpacity, 0, false);
      effected = this.runEffects(full.tex, true, 0, 0, 1, 1, target.w, target.h, layer.effects, layer.effectOffset,
        layer.effectSpatialScale * s, null);
      this.release(full);
      const fullRect = { x: 0, y: 0, width: target.w, height: target.h };
      this.placeTextTransformForRect(layer, fullRect, renderSize, null, canvas);
      this.setRect(this.region, 0, 0, target.w, target.h);
      this.setRect(this.visible, 0, 0, target.w, target.h);
      this.prepareTextMask(layer, target, canvas);
      this.compositeLayer(target, effected.tex, false, opacity, blendModeIndex(layer.blendMode), t.fillMode === "inverted");
      this.release(effected);
      return;
    }

    this.placeTextTransform(layer, raster, renderSize, entrance, canvas);
    this.setRasterRects(raster);
    this.prepareTextMask(layer, target, canvas);
    this.compositeLayer(
      target, entry.tex, true, opacity * entranceOpacity, blendModeIndex(layer.blendMode), t.fillMode === "inverted",
    );
  }

  /** Masks live in the clip's transform rect, which for text is the box in render pixels. */
  private prepareTextMask(layer: TextLayer, target: Target, canvas: Size): void {
    const t = layer.transform;
    this.prepareMask(layer, canvas, (t.centerX - t.width / 2) * target.w, (t.centerY - t.height / 2) * target.h, t.width * target.w, t.height * target.h);
  }

  /** Rasterizes (cached) the layer's masks and queues the texture for the next composite; no masks costs nothing. */
  private prepareMask(layer: FrameLayer, canvas: Size, rx: number, ry: number, rw: number, rh: number): void {
    const masks = layer.masks;
    if (!masks) return;
    const size = maskRasterSize(layer.transform.width * canvas.width, layer.transform.height * canvas.height, this.scaleValue);
    this.maskTex = this.masks.acquire(this.gl, layer.key, masks, layer.maskOffset, size.w, size.h, size.pxScale, this.frameNo);
    if (this.maskTex) this.setRect(this.maskRect, rx, ry, rw, rh);
  }

  private setRasterRects(raster: TextRaster): void {
    const r = raster.rect;
    this.setRect(this.region, r.x, r.y, r.width, r.height);
    this.setRect(this.visible, r.x, r.y, r.width, r.height);
  }

  private placeTextTransform(layer: TextLayer, raster: TextRaster, renderSize: Size, entrance: Affine, canvas: Size): void {
    // Entrance only scales/translates, so R' stays an axis-aligned rect.
    const r = raster.rect;
    const x0 = entrance.a * r.x + entrance.tx, y0 = entrance.d * r.y + entrance.ty;
    const rect = { x: x0, y: y0, width: entrance.a * r.width, height: entrance.d * r.height };
    this.placeTextTransformForRect(layer, rect, renderSize, entrance, canvas);
  }

  /** Forward matrix for text: entrance, then canvas rotation, or the tilt homography of `rect` (TextTiltGeometry). */
  private placeTextTransformForRect(layer: TextLayer, rect: { x: number; y: number; width: number; height: number },
    renderSize: Size, entrance: Affine | null, canvas: Size): void {
    const t = layer.transform;
    void canvas;
    if (transformHasTiltRotation(t)) {
      const corners = textTiltCorners(rect, { x: t.centerX * renderSize.width, y: t.centerY * renderSize.height }, t, renderSize);
      const f = this.fwd;
      squareToQuad(f, corners.topLeft.x, corners.topLeft.y, corners.topRight.x, corners.topRight.y,
        corners.bottomRight.x, corners.bottomRight.y, corners.bottomLeft.x, corners.bottomLeft.y);
      // Pre-compose rect → unit square, then the entrance.
      preMultiplyAffine(f, { a: 1 / rect.width, b: 0, c: 0, d: 1 / rect.height, tx: -rect.x / rect.width, ty: -rect.y / rect.height });
      if (entrance) preMultiplyAffine(f, entrance);
      invert3(this.inv, f);
      return;
    }
    const rot = canvasRotationTransform(t, renderSize);
    const m = entrance ? concatAffine(entrance, rot) : rot;
    this.setAffine(m, 1);
  }

  private stencil(target: Target, mask: Target, r: number, g: number, b: number, a: number): Target {
    const gl = this.gl;
    const copy = this.acquire(target.w, target.h);
    this.copyTarget(target, copy);
    const out = this.acquire(target.w, target.h);
    const p = this.program("#stencil");
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, copy.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    setInt(gl, p, "uSrc", 0);
    setInt(gl, p, "uMask", 1);
    const loc = p.uniforms.get("uColor");
    if (loc) gl.uniform4f(loc.loc, r, g, b, a);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.passes += 1;
    this.release(copy);
    return out;
  }

  private copyTarget(src: Target, dst: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(0, 0, src.w, src.h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // MARK: - Geometry helpers

  private setRect(out: Float32Array, x: number, y: number, w: number, h: number): void {
    out[0] = x;
    out[1] = y;
    out[2] = w;
    out[3] = h;
  }

  /** Forward = affine (layer px → canvas px) then × scale; stores its inverse. */
  private setAffine(m: Affine, scale: number): void {
    const f = this.fwd;
    f[0] = m.a * scale; f[1] = m.b * scale; f[2] = 0;
    f[3] = m.c * scale; f[4] = m.d * scale; f[5] = 0;
    f[6] = m.tx * scale; f[7] = m.ty * scale; f[8] = 1;
    invert3(this.inv, f);
  }

  /** Dest-pixel bounding box of the visible rect under the forward matrix, clamped to the target. */
  private computeBBox(target: Target): boolean {
    const f = this.fwd, v = this.visible, bb = this.bbox;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let behind = false;
    for (let i = 0; i < 4; i++) {
      const lx = (v[0] as number) + (i === 1 || i === 2 ? (v[2] as number) : 0);
      const ly = (v[1] as number) + (i >= 2 ? (v[3] as number) : 0);
      const X = (f[0] as number) * lx + (f[3] as number) * ly + (f[6] as number);
      const Y = (f[1] as number) * lx + (f[4] as number) * ly + (f[7] as number);
      const Z = (f[2] as number) * lx + (f[5] as number) * ly + (f[8] as number);
      if (!(Z > 1e-9)) {
        behind = true;
        break;
      }
      const x = X / Z, y = Y / Z;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (behind) {
      bb[0] = 0; bb[1] = 0; bb[2] = target.w; bb[3] = target.h;
      return true;
    }
    bb[0] = Math.max(0, Math.floor(x0) - 1);
    bb[1] = Math.max(0, Math.floor(y0) - 1);
    bb[2] = Math.min(target.w, Math.ceil(x1) + 1);
    bb[3] = Math.min(target.h, Math.ceil(y1) + 1);
    return (bb[2] as number) > (bb[0] as number) && (bb[3] as number) > (bb[1] as number);
  }

  private compositeLayer(target: Target, tex: WebGLTexture, premul: boolean, opacity: number, mode: number, forceWhite: boolean): void {
    if (!this.computeBBox(target)) return;
    const gl = this.gl;
    const bb = this.bbox;
    const bx = bb[0] as number, by = bb[1] as number, bw = (bb[2] as number) - bx, bh = (bb[3] as number) - by;
    let dstCopy: Target | null = null;
    if (mode !== 0) {
      dstCopy = this.acquire(target.w, target.h);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstCopy.fbo);
      gl.blitFramebuffer(bx, by, bx + bw, by + bh, bx, by, bx + bw, by + bh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    const p = this.program("#composite");
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(bx, by, bw, bh);
    if (mode === 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setInt(gl, p, "uSrc", 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dstCopy ? dstCopy.tex : null);
    setInt(gl, p, "uDst", 1);
    const u = p.uniforms;
    const inv = u.get("uInv");
    if (inv) gl.uniformMatrix3fv(inv.loc, false, this.inv);
    const region = u.get("uRegion");
    if (region) gl.uniform4fv(region.loc, this.region);
    const visible = u.get("uVisible");
    if (visible) gl.uniform4fv(visible.loc, this.visible);
    const op = u.get("uOpacity");
    if (op) gl.uniform1f(op.loc, opacity);
    setInt(gl, p, "uMode", mode);
    setInt(gl, p, "uSrcPremul", premul ? 1 : 0);
    setInt(gl, p, "uForceWhite", forceWhite ? 1 : 0);
    const maskTex = this.maskTex;
    this.maskTex = null;
    setInt(gl, p, "uMaskOn", maskTex ? 1 : 0);
    if (maskTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      setInt(gl, p, "uMask", 2);
      const mr = u.get("uMaskRect");
      if (mr) gl.uniform4fv(mr.loc, this.maskRect);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (maskTex) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    this.stats.passes += 1;
    if (dstCopy) this.release(dstCopy);
  }

  // MARK: - Effects

  /** Crop-copies the source into a straight-alpha target, then runs the effect stack and edge rounding (ping-pong). */
  private runEffects(
    src: WebGLTexture, premul: boolean, u0: number, v0: number, uw: number, vh: number, w: number, h: number,
    effects: readonly FrameEffect[], offset: number, spatialScale: number, edge: RenderPass[] | null,
  ): Target {
    const gl = this.gl;
    const prep = this.acquire(w, h);
    const p = this.program("#prep");
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prep.fbo);
    gl.viewport(0, 0, prep.w, prep.h);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    setInt(gl, p, "uSrc", 0);
    const r = p.uniforms.get("uUvRect");
    if (r) gl.uniform4f(r.loc, u0, v0, uw, vh);
    setInt(gl, p, "uSrcPremul", premul ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.passes += 1;

    let current = prep;
    for (let i = 0; i < effects.length; i++) {
      const fe = effects[i] as FrameEffect;
      current = this.runPasses(current, this.passesFor(fe, offset, prep.w, prep.h, spatialScale));
    }
    if (edge && edge.length > 0) current = this.runPasses(current, edge);
    return current;
  }

  private passesFor(fe: FrameEffect, offset: number, w: number, h: number, spatialScale: number): RenderPass[] {
    const effect = fe.effect;
    const animated = effect.type === "stylize.grain" ||
      Object.values(effect.params).some((p) => p.track !== undefined && keyframeTrackIsActive(p.track));
    const cached = this.passCache.get(effect);
    if (cached && cached.w === w && cached.h === h && cached.scale === spatialScale && (!animated || cached.offset === offset)) {
      return cached.passes;
    }
    const passes = effectPasses(effect, { width: w, height: h, offset, spatialScale, pixelScale: this.scaleValue, loadLut: this.options.loadLut });
    this.passCache.set(effect, { offset, w, h, scale: spatialScale, passes });
    return passes;
  }

  private runPasses(input: Target, passes: readonly RenderPass[]): Target {
    if (passes.length === 0) return input;
    const gl = this.gl;
    const outs = this.passOutputs;
    outs.length = 0;
    let previous = input;
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i] as RenderPass;
      const out = this.acquire(input.w, input.h);
      const p = this.program(pass.shader);
      gl.useProgram(p.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.viewport(0, 0, out.w, out.h);
      gl.disable(gl.BLEND);
      let unit = 0;
      const imageInput = pass.inputs?.["uImage"];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.resolveInput(imageInput, input, previous, outs).tex);
      setInt(gl, p, "uImage", unit);
      unit += 1;
      if (pass.inputs) {
        for (const name in pass.inputs) {
          if (name === "uImage") continue;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, this.resolveInput(pass.inputs[name], input, previous, outs).tex);
          setInt(gl, p, name, unit);
          unit += 1;
        }
      }
      if (pass.textures) {
        for (const name in pass.textures) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, this.passTexture(pass.textures[name] as PassTexture));
          setInt(gl, p, name, unit);
          unit += 1;
        }
      }
      const res = p.uniforms.get("uResolution");
      if (res) gl.uniform2f(res.loc, out.w, out.h);
      for (const name in pass.uniforms) {
        const info = p.uniforms.get(name);
        if (!info) continue;
        setUniform(gl, info.loc, info.type, pass.uniforms[name] as number | number[]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.stats.passes += 1;
      outs.push(out);
      previous = out;
    }
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < outs.length - 1; i++) this.release(outs[i] as Target);
    this.release(input);
    return previous;
  }

  private resolveInput(
    input: RenderPass["inputs"] extends Record<string, infer T> | undefined ? T | undefined : never,
    source: Target, previous: Target, outs: readonly Target[],
  ): Target {
    if (input === undefined || input === "previous") return previous;
    if (input === "source") return source;
    return outs[input.pass] ?? previous;
  }

  private passTexture(t: PassTexture): WebGLTexture {
    const key = t.cacheKey ?? "";
    const cached = key !== "" ? this.lutTextures.get(`${t.kind}|${key}`) : undefined;
    if (cached) return cached;
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (t.data instanceof Float32Array) {
      // lut3d is texelFetched (needs exact 32F); 1D curve LUTs are filtered, 16F is always filterable.
      const internal = t.kind === "lut3d" ? gl.RGBA32F : gl.RGBA16F;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, t.width, t.height, 0, gl.RGBA, gl.FLOAT, t.data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, t.width, t.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.data);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    setSampling(gl, t.kind === "lut3d" ? gl.NEAREST : gl.LINEAR);
    if (key !== "") this.lutTextures.set(`${t.kind}|${key}`, tex);
    return tex;
  }

  // MARK: - Uploads

  private uploadLayerTexture(key: string, frame: SourceFrame): LayerTexture | undefined {
    const gl = this.gl;
    let entry = this.layerTextures.get(key);
    if (!frame.source || (entry && entry.version === frame.version && entry.origin === frame.source)) return entry;
    if (!(frame.width > 0 && frame.height > 0)) return entry;
    const isCanvas = (typeof HTMLCanvasElement !== "undefined" && frame.source instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== "undefined" && frame.source instanceof OffscreenCanvas);
    if (!entry) {
      entry = { tex: gl.createTexture() as WebGLTexture, w: 0, h: 0, version: -1, origin: null, premultiplied: false, lastUsed: this.frameNo };
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      setSampling(gl, gl.LINEAR);
      this.layerTextures.set(key, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Canvases are premultiplied internally; keep them so (correct filtering at glyph edges).
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, isCanvas);
    if (entry.w !== frame.width || entry.h !== frame.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    entry.w = frame.width;
    entry.h = frame.height;
    entry.version = frame.version;
    entry.origin = frame.source;
    entry.premultiplied = isCanvas || frame.premultiplied;
    this.stats.uploads += 1;
    return entry;
  }
}

const affineIdentityValue: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function concatAffine(t1: Affine, t2: Affine): Affine {
  return {
    a: t1.a * t2.a + t1.b * t2.c,
    b: t1.a * t2.b + t1.b * t2.d,
    c: t1.c * t2.a + t1.d * t2.c,
    d: t1.c * t2.b + t1.d * t2.d,
    tx: t1.tx * t2.a + t1.ty * t2.c + t2.tx,
    ty: t1.tx * t2.b + t1.ty * t2.d + t2.ty,
  };
}

function setSampling(gl: WebGL2RenderingContext, filter: number): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function setInt(gl: WebGL2RenderingContext, p: Program, name: string, v: number): void {
  const u = p.uniforms.get(name);
  if (u) gl.uniform1i(u.loc, v);
}

function setUniform(gl: WebGL2RenderingContext, loc: WebGLUniformLocation, type: number, v: number | number[]): void {
  if (typeof v === "number") {
    if (type === gl.INT || type === gl.BOOL) gl.uniform1i(loc, v);
    else gl.uniform1f(loc, v);
    return;
  }
  if (v.length === 2) gl.uniform2fv(loc, v);
  else if (v.length === 3) gl.uniform3fv(loc, v);
  else if (v.length === 4) gl.uniform4fv(loc, v);
  else if (v.length === 1) gl.uniform1f(loc, v[0] as number);
}

/** Column-major 3×3 (GL layout: m[col*3+row]); maps the unit square onto the quad p0..p3 (TL, TR, BR, BL). */
function squareToQuad(
  m: Float64Array, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
): void {
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (sx !== 0 || sy !== 0) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  // (u, v) → (a u + b v + c, d u + e v + f) / (g u + h v + 1)
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  m[0] = a; m[1] = d; m[2] = g;
  m[3] = b; m[4] = e; m[5] = h;
  m[6] = c; m[7] = f; m[8] = 1;
}

/** m ← m · A (apply affine A first). */
function preMultiplyAffine(m: Float64Array, t: Affine): void {
  const m0 = m[0] as number, m1 = m[1] as number, m2 = m[2] as number;
  const m3 = m[3] as number, m4 = m[4] as number, m5 = m[5] as number;
  const m6 = m[6] as number, m7 = m[7] as number, m8 = m[8] as number;
  m[0] = m0 * t.a + m3 * t.b; m[1] = m1 * t.a + m4 * t.b; m[2] = m2 * t.a + m5 * t.b;
  m[3] = m0 * t.c + m3 * t.d; m[4] = m1 * t.c + m4 * t.d; m[5] = m2 * t.c + m5 * t.d;
  m[6] = m0 * t.tx + m3 * t.ty + m6; m[7] = m1 * t.tx + m4 * t.ty + m7; m[8] = m2 * t.tx + m5 * t.ty + m8;
}

function invert3(out: Float32Array, m: Float64Array): void {
  const a = m[0] as number, b = m[1] as number, c = m[2] as number;
  const d = m[3] as number, e = m[4] as number, f = m[5] as number;
  const g = m[6] as number, h = m[7] as number, i = m[8] as number;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = det !== 0 ? 1 / det : 0;
  out[0] = A * k; out[3] = B * k; out[6] = C * k;
  out[1] = -(b * i - c * h) * k; out[4] = (a * i - c * g) * k; out[7] = -(a * h - b * g) * k;
  out[2] = (b * f - c * e) * k; out[5] = -(a * f - c * d) * k; out[8] = (a * e - b * d) * k;
}
