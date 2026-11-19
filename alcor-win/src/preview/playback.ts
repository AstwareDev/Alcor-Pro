import { wetMediaRefs, wetPathFor } from "../denoise/denoiseState";
import { isWetMediaRef } from "../denoise/denoiseMix";
import { createEffect, createRoot, createSignal, on, untrack, type Accessor } from "solid-js";
import type { Editor } from "../editor/editor";
import { openLottieUrl, type LottieSource } from "../lottie/lottieSource";
import { mediaUrl } from "../media/mediaUrl";
import { timelineTotalFrames, type Timeline } from "../model/timeline";
import type { CubeLUT } from "./effects/lutLoader";
import {
  buildAudioGraph, buildFrameGraph, collectMediaLayers, type FrameGraph, type FrameGraphDocument, type MediaLayer,
} from "./frameGraph";
import type { PreviewSeekMode } from "./previewPlaybackRate";
import { Compositor, previewQualityScale, type PreviewQuality, type SourceFrame, type TextureProvider } from "./renderer";

export interface PlaybackEngineOptions {
  editor: Editor;
  canvas: HTMLCanvasElement;
  /** Media ref → playable URL. Defaults to the asset's path through the asset protocol. */
  resolveUrl?: (mediaRef: string) => string | null;
  loadLut?: (path: string) => CubeLUT | undefined;
}

export interface AudioLevels {
  left: number;
  right: number;
}

interface VideoSlot {
  el: HTMLVideoElement;
  key: string;
  url: string;
  usedTick: number;
  pendingTime: number | null;
  frameVersion: number;
  frame: SourceFrame;
  failed: boolean;
  onFrame: VideoFrameRequestCallback;
}

interface AudioSlot {
  el: HTMLAudioElement;
  url: string;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  usedTick: number;
}

interface LottieEntry {
  source: LottieSource | null;
  disposed: boolean;
  usedTick: number;
}

interface ImageEntry {
  frame: SourceFrame | null;
  failed: boolean;
}

const prerollSeconds = 0.75;
const idleSlotTicks = 120;
const maxIdleVideos = 6;
const minElementRate = 0.0625;
const maxElementRate = 16;

/**
 * Owns the preview clock and media elements: one muted <video> per active video clip (pooled, prerolled), WebAudio for
 * audio-track clips, master clock = AudioContext time × rate. Renders through `Compositor` once per timeline frame.
 * Reverse playback (J) is stepped seeking. No rAF runs while paused and nothing changes.
 */
export class PlaybackEngine {
  readonly compositor: Compositor;
  readonly frame: Accessor<number>;
  readonly playing: Accessor<boolean>;
  readonly quality: Accessor<PreviewQuality>;
  /** Signed shuttle rate (J/K/L); 0 when stopped. */
  readonly shuttle: Accessor<number>;
  /** Last render cost in ms (CPU-side submit, not GPU time). */
  lastRenderMs = 0;

  private readonly editor: Editor;
  private readonly resolveUrl: (mediaRef: string) => string | null;
  private readonly setFrame: (v: number) => void;
  private readonly setPlaying: (v: boolean) => void;
  private readonly setQualitySignal: (v: PreviewQuality) => void;
  private readonly setShuttle: (v: number) => void;
  private readonly disposeRoot: () => void;
  private readonly videos = new Map<string, VideoSlot>();
  private readonly idleVideos: VideoSlot[] = [];
  private readonly audios = new Map<string, AudioSlot>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly lotties = new Map<string, LottieEntry>();
  private readonly mediaScratch: MediaLayer[] = [];
  private readonly provider: TextureProvider;
  private audioCtx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analysers: [AnalyserNode, AnalyserNode] | null = null;
  private readonly levelBuffer = new Float32Array(2048);
  private readonly levelOut: AudioLevels = { left: 0, right: 0 };
  private raf = 0;
  private renderQueued = false;
  private tick = 0;
  private dirty = true;
  private anchorClock = 0;
  private anchorFrame = 0;
  private useAudioClock = false;
  private rate = 1;
  private direction = 1;
  private lastWrittenFrame = -1;
  private disposed = false;

  constructor(options: PlaybackEngineOptions) {
    this.editor = options.editor;
    this.resolveUrl = options.resolveUrl ?? ((ref) => {
      const asset = this.document().mediaAssets?.find((a) => a.id === ref);
      return asset ? mediaUrl(asset.url) : null;
    });
    this.compositor = new Compositor(options.canvas, { loadLut: options.loadLut });
    this.compositor.onContextRestored = () => this.invalidate();
    const [frame, setFrame] = createSignal(untrack(() => this.editor.ui.currentFrame));
    const [playing, setPlaying] = createSignal(false);
    const [quality, setQuality] = createSignal<PreviewQuality>("full");
    const [shuttle, setShuttle] = createSignal(0);
    this.frame = frame;
    this.playing = playing;
    this.quality = quality;
    this.shuttle = shuttle;
    this.setFrame = setFrame;
    this.setPlaying = setPlaying;
    this.setQualitySignal = setQuality;
    this.setShuttle = setShuttle;
    this.provider = { media: (layer) => this.mediaFrame(layer) };

    this.disposeRoot = createRoot((dispose) => {
      // Document edits re-render the current frame; graph diffing keeps unchanged elements.
      createEffect(on(() => this.editor.store.revision, () => this.invalidate(), { defer: true }));
      // A denoised twin finished baking: rebuild the audio sources without pausing (`videoEngine.rebuild()`).
      createEffect(on(wetMediaRefs, () => this.invalidate(), { defer: true }));
      // Playhead moved by someone else (timeline click, agent) → seek.
      createEffect(on(() => this.editor.ui.currentFrame, (f) => {
        if (f !== this.lastWrittenFrame) this.seek(f, "exact");
      }, { defer: true }));
      // Play/pause requested elsewhere (timeline Space, toolbar, agent).
      createEffect(on(() => this.editor.ui.isPlaying, (wanted) => {
        if (wanted && !this.playing()) this.play();
        else if (!wanted && this.playing()) this.pause();
      }, { defer: true }));
      return dispose;
    });
    this.invalidate();
  }

  /** Runs one clock tick synchronously (drivers without rAF: hidden pages, tests). */
  pump(): void {
    this.renderQueued = false;
    cancelAnimationFrame(this.raf);
    this.onAnimationFrame();
  }

  /** Animation-frame callbacks run so far (idle check: stays constant while paused). */
  get ticks(): number {
    return this.tick;
  }

  // MARK: - Transport

  play(): void {
    this.startShuttle(1, Math.abs(this.editor.ui.playbackRate) || 1);
  }

  pause(): void {
    if (!this.playing()) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.renderQueued = false;
    this.setPlaying(false);
    this.setShuttle(0);
    this.editor.ui.isPlaying = false;
    for (const slot of this.audios.values()) slot.el.pause();
    for (const slot of this.videos.values()) slot.el.pause();
    this.writeFrame(this.frame());
    this.invalidate();
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  /** J/K/L: signed rate; 0 pauses. Negative rates play backwards by stepped seeking. */
  setRate(rate: number): void {
    if (rate === 0) {
      this.pause();
      return;
    }
    this.startShuttle(Math.sign(rate), Math.abs(rate));
  }

  /** Menu playback speed (PreviewPlaybackRate); applies to running forward playback. */
  setPlaybackRate(rate: number): void {
    this.editor.ui.playbackRate = rate;
    if (this.playing() && this.direction > 0) this.startShuttle(1, rate);
  }

  setQuality(quality: PreviewQuality): void {
    this.setQualitySignal(quality);
    this.compositor.setScale(previewQualityScale[quality]);
    this.invalidate();
  }

  seek(frame: number, mode: PreviewSeekMode = "exact"): void {
    const total = this.totalFrames();
    const clamped = Math.min(Math.max(0, Math.trunc(frame)), Math.max(0, total));
    if ((mode === "audibleStepForward" || mode === "audibleStepBackward") && this.playing()) this.pause();
    if (this.playing()) {
      this.anchorFrame = clamped;
      this.anchorClock = this.clock();
    }
    this.setFrame(clamped);
    this.writeFrame(clamped);
    this.invalidate();
  }

  /** Current L/R levels (linear peak, 0…1) from the master analysers. */
  levels(): AudioLevels {
    const out = this.levelOut;
    if (!this.analysers || !this.playing()) {
      out.left = 0;
      out.right = 0;
    } else {
      out.left = this.peak(this.analysers[0]);
      out.right = this.peak(this.analysers[1]);
    }
    return out;
  }

  /** Renders the current frame at Full quality and returns it as PNG. */
  async captureFrame(): Promise<Blob> {
    const scale = this.compositor.scale;
    this.compositor.setScale(1);
    const graph = this.graphAt(this.visibleFrame(this.frame()));
    this.compositor.render(graph, this.provider);
    const { width, height } = this.compositor.outputSize(graph.width, graph.height);
    const pixels = this.compositor.readPixels(0, 0, width, height);
    this.compositor.setScale(scale);
    this.invalidate();
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }

  /** Fills `out` (cols*rows*4 RGBA8) with a downscaled copy of the last rendered frame; returns false when there is none. */
  sampleFrame(cols: number, rows: number, out: Uint8Array): boolean {
    const timeline = this.timeline();
    if (!timeline) return false;
    const { width, height } = this.compositor.outputSize(timeline.width, timeline.height);
    return this.compositor.sampleGrid(width, height, cols, rows, out);
  }

  /** Mean RGB (0...1) of a (2r+1) pixel square around a normalized canvas point in the last rendered frame. */
  sampleRenderedRGB(nx: number, ny: number, radius = 4): { r: number; g: number; b: number } | undefined {
    const timeline = this.timeline();
    if (!timeline || !(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return undefined;
    const { width, height } = this.compositor.outputSize(timeline.width, timeline.height);
    const cx = Math.min(width - 1, Math.floor(nx * width));
    const cy = Math.min(height - 1, Math.floor(ny * height));
    const x0 = Math.max(0, cx - radius), y0 = Math.max(0, cy - radius);
    const w = Math.min(width - 1, cx + radius) - x0 + 1;
    const h = Math.min(height - 1, cy + radius) - y0 + 1;
    const px = this.compositor.readPixels(x0, y0, w, h);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < w * h; i++) {
      r += px[i * 4] as number;
      g += px[i * 4 + 1] as number;
      b += px[i * 4 + 2] as number;
    }
    const n = w * h * 255;
    return { r: r / n, g: g / n, b: b / n };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.disposeRoot();
    for (const slot of [...this.videos.values(), ...this.idleVideos]) releaseVideo(slot.el);
    this.videos.clear();
    this.idleVideos.length = 0;
    for (const slot of this.audios.values()) {
      slot.el.pause();
      slot.node.disconnect();
      slot.gain.disconnect();
      releaseVideo(slot.el);
    }
    this.audios.clear();
    for (const entry of this.images.values()) {
      const src = entry.frame?.source;
      if (src instanceof ImageBitmap) src.close();
    }
    this.images.clear();
    for (const entry of this.lotties.values()) this.releaseLottie(entry);
    this.lotties.clear();
    void this.audioCtx?.close();
    this.compositor.dispose();
  }

  // MARK: - Clock

  private startShuttle(direction: number, rate: number): void {
    if (this.totalFrames() <= 0) return;
    let start = this.frame();
    if (direction > 0 && start >= this.totalFrames()) start = 0;
    this.direction = direction;
    this.rate = rate;
    this.ensureAudio();
    this.useAudioClock = this.audioCtx?.state === "running";
    this.anchorFrame = start;
    this.anchorClock = this.clock();
    this.setShuttle(direction * rate);
    if (!this.playing()) {
      this.setPlaying(true);
      this.editor.ui.isPlaying = true;
    }
    this.dirty = true;
    this.schedule();
  }

  private clock(): number {
    return this.useAudioClock && this.audioCtx ? this.audioCtx.currentTime : performance.now() / 1000;
  }

  private ensureAudio(): void {
    if (this.audioCtx || typeof AudioContext === "undefined") return;
    const ctx = new AudioContext({ latencyHint: "playback" });
    const master = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = 2048;
    right.fftSize = 2048;
    master.connect(ctx.destination);
    master.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    this.audioCtx = ctx;
    this.master = master;
    this.analysers = [left, right];
    void ctx.resume();
  }

  private peak(a: AnalyserNode): number {
    const buf = this.levelBuffer.subarray(0, a.fftSize);
    a.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] as number);
      if (v > p) p = v;
    }
    return p;
  }

  // MARK: - Scheduling

  /** Re-renders the current frame (e.g. after an async resource such as a LUT finished loading). */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.renderQueued) return;
    this.renderQueued = true;
    this.raf = requestAnimationFrame(this.onAnimationFrame);
  }

  private readonly onAnimationFrame = (): void => {
    this.renderQueued = false;
    if (this.disposed) return;
    this.tick += 1;
    if (this.playing()) {
      this.playTick();
      if (this.playing()) this.schedule();
    } else if (this.dirty) {
      this.renderAt(this.frame(), false);
    }
  };

  private playTick(): void {
    const fps = this.timeline()?.fps ?? 30;
    const total = this.totalFrames();
    const elapsed = (this.clock() - this.anchorClock) * this.rate * this.direction;
    let frame = this.anchorFrame + Math.floor(elapsed * fps + 1e-6);
    let ended = false;
    if (this.direction > 0 && frame >= total) {
      frame = total;
      ended = true;
    } else if (this.direction < 0 && frame <= 0) {
      frame = 0;
      ended = true;
    }
    if (frame !== this.frame()) {
      this.setFrame(frame);
      this.writeFrame(frame);
      this.dirty = true;
    }
    if (this.dirty) this.renderAt(frame, !ended);
    if (ended) this.pause();
  }

  private writeFrame(frame: number): void {
    if (this.editor.ui.currentFrame === frame) return;
    this.lastWrittenFrame = frame;
    this.editor.ui.currentFrame = frame;
  }

  /** At the end of the timeline the last frame stays on screen (AVPlayer holds it). */
  private visibleFrame(frame: number): number {
    const total = this.totalFrames();
    return total > 0 ? Math.min(frame, total - 1) : frame;
  }

  private renderAt(frame: number, playing: boolean): void {
    this.dirty = false;
    const shown = this.visibleFrame(frame);
    const graph = this.graphAt(shown);
    const forward = playing && this.direction > 0;
    this.syncVideos(graph, shown, forward);
    this.syncAudio(shown, forward && this.rate <= 2);
    this.retireIdle();
    const t0 = performance.now();
    this.compositor.render(graph, this.provider);
    this.lastRenderMs = performance.now() - t0;
  }

  // MARK: - Graph

  private document(): FrameGraphDocument {
    return this.editor.store.committed;
  }

  private timeline(): Timeline | undefined {
    const doc = this.editor.store.committed;
    return doc.timelines.find((t) => t.id === doc.activeTimelineId);
  }

  private totalFrames(): number {
    const t = this.timeline();
    return t ? timelineTotalFrames(t) : 0;
  }

  private graphAt(frame: number): FrameGraph {
    const doc = this.editor.store.committed;
    return buildFrameGraph(doc, doc.activeTimelineId, frame, { missingMediaRefs: untrack(() => this.editor.ui.missingMediaRefs) });
  }

  // MARK: - Video

  private syncVideos(graph: FrameGraph, frame: number, forward: boolean): void {
    const layers = collectMediaLayers(graph.layers, this.mediaScratch);
    const fps = graph.fps;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] as MediaLayer;
      if (layer.mediaType !== "video") continue;
      const slot = this.videoSlot(layer);
      if (!slot) continue;
      slot.usedTick = this.tick;
      const el = slot.el;
      if (forward) {
        const elementRate = Math.min(maxElementRate, Math.max(minElementRate, layer.sourceRate * this.rate));
        if (el.playbackRate !== elementRate) el.playbackRate = elementRate;
        const tolerance = (2 / fps) * Math.max(1, layer.sourceRate * this.rate);
        if (el.paused) {
          this.seekSlot(slot, layer.sourceTime);
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - layer.sourceTime) > tolerance) {
          this.seekSlot(slot, layer.sourceTime);
        }
      } else {
        if (!el.paused) el.pause();
        this.seekSlot(slot, layer.sourceTime);
      }
    }
    this.mediaScratch.length = 0;

    // Preroll clips that start shortly so their first frame is decoded before they appear.
    if (forward && this.tick % 8 === 0) {
      const ahead = this.graphAt(frame + Math.round(fps * prerollSeconds * this.rate));
      const upcoming = collectMediaLayers(ahead.layers, this.mediaScratch);
      for (const layer of upcoming) {
        if (layer.mediaType !== "video" || layer.clip.startFrame <= frame) continue;
        const slot = this.videoSlot(layer);
        if (!slot) continue;
        // Leased until the clip starts (preroll runs every 8 ticks).
        slot.usedTick = Math.max(slot.usedTick, this.tick + 16);
        if (!slot.el.paused) slot.el.pause();
        this.seekSlot(slot, layer.sourceStart);
      }
      this.mediaScratch.length = 0;
    }
  }

  private videoSlot(layer: MediaLayer): VideoSlot | undefined {
    const key = `${layer.key}|${layer.mediaRef}`;
    const existing = this.videos.get(key);
    if (existing) return existing.failed ? undefined : existing;
    const url = this.resolveUrl(layer.mediaRef);
    if (!url) return undefined;
    const reuse = this.idleVideos.findIndex((s) => s.url === url);
    let slot: VideoSlot;
    if (reuse >= 0) {
      slot = this.idleVideos.splice(reuse, 1)[0] as VideoSlot;
      slot.key = key;
    } else {
      const el = document.createElement("video");
      el.muted = true;
      el.preload = "auto";
      el.playsInline = true;
      el.crossOrigin = "anonymous";
      el.src = url;
      const s: VideoSlot = {
        el, key, url, usedTick: this.tick, pendingTime: null, frameVersion: 0, failed: false,
        frame: { source: null, width: 0, height: 0, version: 0, premultiplied: false },
        onFrame: () => {
          s.frameVersion += 1;
          if (!this.disposed) {
            el.requestVideoFrameCallback(s.onFrame);
            if (!this.playing()) this.invalidate();
            else this.dirty = true;
          }
        },
      };
      el.addEventListener("seeked", () => {
        if (s.pendingTime !== null) {
          const t = s.pendingTime;
          s.pendingTime = null;
          el.currentTime = t;
          return;
        }
        s.frameVersion += 1;
        if (!this.playing()) this.invalidate();
      });
      el.addEventListener("loadeddata", () => this.invalidate());
      el.addEventListener("error", () => {
        s.failed = true;
      });
      el.requestVideoFrameCallback(s.onFrame);
      slot = s;
    }
    this.videos.set(key, slot);
    return slot;
  }

  /** Coalesced seek: while a seek is in flight only the latest target is kept. */
  private seekSlot(slot: VideoSlot, time: number): void {
    const el = slot.el;
    const fps = this.timeline()?.fps ?? 30;
    if (el.seeking) {
      slot.pendingTime = time;
      return;
    }
    if (Math.abs(el.currentTime - time) < 0.5 / fps) return;
    el.currentTime = time;
  }

  private mediaFrame(layer: MediaLayer): SourceFrame | null {
    if (layer.mediaType === "image") return this.imageFrame(layer.mediaRef);
    if (layer.mediaType === "lottie") return this.lottieFrame(layer);
    if (layer.mediaType !== "video") return null;
    const slot = this.videos.get(`${layer.key}|${layer.mediaRef}`);
    if (!slot || slot.failed) return null;
    const el = slot.el;
    const f = slot.frame;
    if (el.readyState < 2 || el.videoWidth === 0) {
      f.source = null;
      return f;
    }
    f.source = el;
    f.width = el.videoWidth;
    f.height = el.videoHeight;
    f.version = slot.frameVersion;
    return f;
  }

  private lottieFrame(layer: MediaLayer): SourceFrame | null {
    let entry = this.lotties.get(layer.mediaRef);
    if (!entry) {
      const created: LottieEntry = { source: null, disposed: false, usedTick: this.tick };
      entry = created;
      this.lotties.set(layer.mediaRef, created);
      const url = this.resolveUrl(layer.mediaRef);
      if (url) {
        void openLottieUrl(url, layer.natSize).then((source) => {
          if (created.disposed) source?.dispose();
          else if (source) {
            created.source = source;
            this.invalidate();
          }
        });
      }
    }
    entry.usedTick = this.tick;
    return entry.source?.frameAt(layer.sourceTime) ?? null;
  }

  private releaseLottie(entry: LottieEntry): void {
    entry.disposed = true;
    entry.source?.dispose();
  }

  private imageFrame(mediaRef: string): SourceFrame | null {
    const entry = this.images.get(mediaRef);
    if (entry) return entry.frame;
    const url = this.resolveUrl(mediaRef);
    const created: ImageEntry = { frame: null, failed: false };
    this.images.set(mediaRef, created);
    if (url) {
      void fetch(url)
        .then((r) => r.blob())
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "premultiply", imageOrientation: "from-image" }))
        .then((bitmap) => {
          if (this.disposed) {
            bitmap.close();
            return;
          }
          created.frame = { source: bitmap, width: bitmap.width, height: bitmap.height, version: 1, premultiplied: true };
          this.invalidate();
        })
        .catch(() => {
          created.failed = true;
        });
    }
    return null;
  }

  /** Clips no longer on screen release their element to a small idle pool keyed by URL. */
  private retireIdle(): void {
    for (const [ref, entry] of this.lotties) {
      if (this.tick - entry.usedTick <= idleSlotTicks) continue;
      this.releaseLottie(entry);
      this.lotties.delete(ref);
    }
    for (const [key, slot] of this.videos) {
      if (this.tick - slot.usedTick < 2) continue;
      slot.el.pause();
      this.videos.delete(key);
      this.compositor.forgetLayer(slot.key.split("|")[0] as string);
      if (slot.failed) {
        releaseVideo(slot.el);
        continue;
      }
      this.idleVideos.push(slot);
      while (this.idleVideos.length > maxIdleVideos) releaseVideo((this.idleVideos.shift() as VideoSlot).el);
    }
    for (const [key, slot] of this.audios) {
      if (slot.usedTick === this.tick) continue;
      if (!slot.el.paused) slot.el.pause();
      if (this.tick - slot.usedTick > idleSlotTicks) {
        slot.node.disconnect();
        slot.gain.disconnect();
        releaseVideo(slot.el);
        this.audios.delete(key);
      }
    }
  }

  // MARK: - Audio

  private syncAudio(frame: number, audible: boolean): void {
    if (!this.audioCtx || !this.master) return;
    const doc = this.editor.store.committed;
    const graph = buildAudioGraph(doc, doc.activeTimelineId, frame, {
      missingMediaRefs: untrack(() => this.editor.ui.missingMediaRefs),
      wetMediaRefs: untrack(wetMediaRefs),
    });
    const fps = this.timeline()?.fps ?? 30;
    for (const source of graph.sources) {
      let slot = this.audios.get(source.key);
      const wetPath = isWetMediaRef(source.mediaRef) ? wetPathFor(source.mediaRef) : undefined;
      const url = isWetMediaRef(source.mediaRef) ? (wetPath ? mediaUrl(wetPath) : null) : this.resolveUrl(source.mediaRef);
      if (!url) continue;
      if (!slot || slot.url !== url) {
        if (slot) {
          slot.node.disconnect();
          slot.gain.disconnect();
          releaseVideo(slot.el);
        }
        const el = new Audio();
        el.crossOrigin = "anonymous";
        el.preload = "auto";
        el.src = url;
        const node = this.audioCtx.createMediaElementSource(el);
        const gain = this.audioCtx.createGain();
        node.connect(gain);
        gain.connect(this.master);
        slot = { el, url, node, gain, usedTick: this.tick };
        this.audios.set(source.key, slot);
      }
      slot.usedTick = this.tick;
      slot.gain.gain.value = Number.isFinite(source.gain) ? Math.max(0, source.gain) : 0;
      const el = slot.el;
      if (!audible) {
        if (!el.paused) el.pause();
        continue;
      }
      const elementRate = Math.min(maxElementRate, Math.max(minElementRate, source.sourceRate * this.rate));
      if (el.playbackRate !== elementRate) el.playbackRate = elementRate;
      if (el.paused || Math.abs(el.currentTime - source.sourceTime) > (2 / fps) * Math.max(1, elementRate) + 0.04) {
        if (!el.seeking) el.currentTime = source.sourceTime;
      }
      if (el.paused) void el.play().catch(() => undefined);
    }
  }
}

function releaseVideo(el: HTMLMediaElement): void {
  el.pause();
  el.removeAttribute("src");
  el.load();
}
