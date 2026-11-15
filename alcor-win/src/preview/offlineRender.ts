import {
  ALL_FORMATS, Input, UrlSource, VideoSampleSink,
  type VideoSample,
} from "mediabunny";
import type { MediaAsset } from "../model/mediaAsset";
import type { Timeline } from "../model/timeline";
import {
  buildFrameGraph, collectMediaLayers, type FrameGraphDocument, type FrameGraphOptions, type MediaLayer,
} from "./frameGraph";
import { Compositor, type SourceFrame, type TextureProvider } from "./renderer";

/*
 * Offline (non-realtime) decode and render helpers shared by the video export and the agent's frame tools
 * (inspect_timeline, capture_frame, inspect_color). Frame-accurate: each layer's source time is decoded with a
 * mediabunny VideoSampleSink and drawn through the preview Compositor into an offscreen canvas.
 */

// Sample timestamps are rational; the tolerance absorbs float error without crossing a frame boundary.
const timeEpsilon = 1e-4;

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// MARK: - Sources


export class MediaInputs {
  private readonly inputs = new Map<string, Promise<Input | null>>();
  private readonly assets: Map<string, MediaAsset>;

  constructor(assets: readonly MediaAsset[], private readonly warn: (message: string) => void) {
    this.assets = new Map(assets.map((a) => [a.id, a]));
  }

  asset(mediaRef: string): MediaAsset | undefined {
    return this.assets.get(mediaRef);
  }

  get(mediaRef: string): Promise<Input | null> {
    let p = this.inputs.get(mediaRef);
    if (!p) {
      p = this.open(mediaRef);
      this.inputs.set(mediaRef, p);
    }
    return p;
  }

  private async open(mediaRef: string): Promise<Input | null> {
    const asset = this.assets.get(mediaRef);
    if (!asset) {
      this.warn(`Media ${mediaRef} is not in the project and was skipped.`);
      return null;
    }
    try {
      const input = new Input({ source: new UrlSource(asset.url), formats: ALL_FORMATS });
      await input.getFormat();
      return input;
    } catch (e) {
      this.warn(`${asset.name} could not be opened and was skipped (${errorText(e)}).`);
      return null;
    }
  }

  dispose(): void {
    for (const p of this.inputs.values()) void p.then((i) => i?.dispose());
    this.inputs.clear();
  }
}

/** Walks a clip's video forward in timestamp order, holding the latest sample at or before the requested time. */
export class VideoCursor {
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private current: VideoSample | null = null;
  private next: VideoSample | null = null;
  private ended = false;
  private advanced = false;
  private frame: VideoFrame | null = null;
  private canvas: OffscreenCanvas | null = null;
  private served: SourceFrame | null = null;
  private version = 0;
  private blendCanvas: OffscreenCanvas | null = null;

  constructor(private readonly sink: VideoSampleSink) {}

  private async pull(): Promise<VideoSample | null> {
    if (!this.iter) return null;
    const r = await this.iter.next();
    if (r.done) {
      this.ended = true;
      return null;
    }
    return r.value;
  }

  private async reset(): Promise<void> {
    this.releaseFrame();
    this.current?.close();
    this.next?.close();
    this.current = this.next = null;
    await this.iter?.return(undefined);
    this.iter = null;
    this.ended = false;
    this.advanced = false;
    this.served = null;
  }

  /** Frame blending: the frame at `t` mixed with its successor by how far `t` lies between them. */
  async blendedFrameAt(t: number): Promise<SourceFrame | null> {
    const base = await this.frameAt(t);
    const cur = this.current;
    const next = this.next;
    if (!base || !cur || !next) return base;
    const span = next.timestamp - cur.timestamp;
    const alpha = span > 0 ? (t - cur.timestamp) / span : 0;
    if (!(alpha > 0.02 && alpha < 0.98)) return base;
    const w = cur.displayWidth, h = cur.displayHeight;
    if (!this.blendCanvas || this.blendCanvas.width !== w || this.blendCanvas.height !== h) this.blendCanvas = new OffscreenCanvas(w, h);
    const ctx = this.blendCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    cur.draw(ctx, 0, 0);
    ctx.globalAlpha = alpha;
    next.draw(ctx, 0, 0);
    ctx.globalAlpha = 1;
    this.version += 1;
    return { source: this.blendCanvas, width: w, height: h, version: this.version, premultiplied: true };
  }

  async frameAt(t: number): Promise<SourceFrame | null> {
    if (this.current && this.advanced && t < this.current.timestamp - 0.25) await this.reset();
    if (!this.iter) this.iter = this.sink.samples(Math.max(0, t));
    if (!this.current) {
      this.current = await this.pull();
      this.served = null;
    }
    if (!this.current) return null;
    for (;;) {
      if (!this.next && !this.ended) this.next = await this.pull();
      if (this.next && this.next.timestamp <= t + timeEpsilon) {
        this.current.close();
        this.current = this.next;
        this.next = null;
        this.advanced = true;
        this.served = null;
      } else break;
    }
    return (this.served ??= this.makeFrame(this.current));
  }

  private releaseFrame(): void {
    this.frame?.close();
    this.frame = null;
  }

  private makeFrame(sample: VideoSample): SourceFrame {
    this.releaseFrame();
    this.version += 1;
    const w = sample.displayWidth, h = sample.displayHeight;
    if (sample.rotation === 0 && !sample.flip) {
      this.frame = sample.toVideoFrame();
      return { source: this.frame, width: w, height: h, version: this.version, premultiplied: false };
    }
    // Rotated / flipped phone footage: `draw` applies the container's orientation.
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) this.canvas = new OffscreenCanvas(w, h);
    const ctx = this.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    sample.draw(ctx, 0, 0);
    return { source: this.canvas, width: w, height: h, version: this.version, premultiplied: true };
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

export class Feeder implements TextureProvider {
  private readonly cursors = new Map<string, VideoCursor>();
  private readonly cursorFailed = new Set<string>();
  private readonly images = new Map<string, Promise<ImageBitmap | null>>();
  private frames = new Map<string, SourceFrame>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly inputs: MediaInputs,
    private readonly compositor: Compositor,
    private readonly warn: (message: string) => void,
  ) {}

  media(layer: MediaLayer): SourceFrame | null {
    return this.frames.get(layer.key) ?? null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  private async cursorFor(layer: MediaLayer): Promise<VideoCursor | null> {
    const existing = this.cursors.get(layer.key);
    if (existing) return existing;
    if (this.cursorFailed.has(layer.key)) return null;
    const input = await this.inputs.get(layer.mediaRef);
    const track = input ? await input.getPrimaryVideoTrack() : null;
    if (!input || !track || !(await track.canDecode())) {
      this.cursorFailed.add(layer.key);
      if (input) this.warnOnce(layer.mediaRef, `${this.inputs.asset(layer.mediaRef)?.name ?? layer.mediaRef} has no video this system can decode and was skipped.`);
      return null;
    }
    const cursor = new VideoCursor(new VideoSampleSink(track));
    this.cursors.set(layer.key, cursor);
    return cursor;
  }

  private image(mediaRef: string): Promise<ImageBitmap | null> {
    let p = this.images.get(mediaRef);
    if (!p) {
      p = (async () => {
        const asset = this.inputs.asset(mediaRef);
        if (!asset) return null;
        try {
          const res = await fetch(asset.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await createImageBitmap(await res.blob(), { imageOrientation: "from-image" });
        } catch (e) {
          this.warnOnce(mediaRef, `${asset.name} could not be decoded and was skipped (${errorText(e)}).`);
          return null;
        }
      })();
      this.images.set(mediaRef, p);
    }
    return p;
  }

  /** Decodes the frame each media layer shows, then drops cursors whose layer left the graph. */
  async prepare(layers: readonly MediaLayer[]): Promise<void> {
    const next = new Map<string, SourceFrame>();
    await Promise.all(layers.map(async (layer) => {
      let frame: SourceFrame | null = null;
      if (layer.mediaType === "video") {
        const cursor = await this.cursorFor(layer);
        frame = cursor ? await (layer.frameBlend ? cursor.blendedFrameAt(layer.sourceTime) : cursor.frameAt(layer.sourceTime)) : null;
      } else if (layer.mediaType === "image") {
        const bitmap = await this.image(layer.mediaRef);
        if (bitmap) frame = { source: bitmap, width: bitmap.width, height: bitmap.height, version: layer.mediaRef, premultiplied: false };
      } else {
        this.warnOnce(layer.mediaRef, "Lottie animations are not supported in video export and were skipped.");
      }
      if (frame) next.set(layer.key, frame);
    }));
    this.frames = next;
    const live = new Set(layers.map((l) => l.key));
    for (const [key, cursor] of this.cursors) {
      if (live.has(key)) continue;
      this.cursors.delete(key);
      this.compositor.forgetLayer(key);
      await cursor.close();
    }
  }

  async close(): Promise<void> {
    this.frames = new Map();
    const cursors = [...this.cursors.values()];
    this.cursors.clear();
    await Promise.all(cursors.map((c) => c.close()));
    for (const p of this.images.values()) void p.then((b) => b?.close());
    this.images.clear();
  }
}


// MARK: - Single frame render

/** Plain data a render needs; the export worker spec has the same fields. */
export interface OfflineRenderSpec {
  timelines: readonly Timeline[];
  /** Assets whose `url` is directly fetchable (asset-protocol or blob URL). */
  mediaAssets: readonly MediaAsset[];
  timelineId: string;
  missingMediaRefs: readonly string[];
}

export interface OfflineFrame {
  /** 2D canvas holding the composited frame, rows top to bottom. */
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  warnings: string[];
}

/** Aspect-preserving size whose longest edge is at most `longestEdge` (never upscales). */
export function fitLongestEdge(width: number, height: number, longestEdge: number | undefined): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longestEdge === undefined || !(longest > longestEdge)) return { width, height };
  const scale = longestEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Renders one timeline frame on the timeline's frame grid. `longestEdge` undefined renders at full size. */
export async function renderTimelineFrameCanvas(spec: OfflineRenderSpec, frame: number, longestEdge?: number): Promise<OfflineFrame> {
  const timeline = spec.timelines.find((t) => t.id === spec.timelineId);
  if (!timeline) throw new Error("The timeline to render no longer exists.");
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const doc: FrameGraphDocument = { timelines: spec.timelines, mediaAssets: spec.mediaAssets };
  const byId = new Map(spec.timelines.map((t) => [t.id, t]));
  const options: FrameGraphOptions = {
    resolveTimeline: (id) => byId.get(id),
    missingMediaRefs: new Set(spec.missingMediaRefs),
  };
  const target = fitLongestEdge(timeline.width, timeline.height, longestEdge);
  const glCanvas = new OffscreenCanvas(target.width, target.height);
  const compositor = new Compositor(glCanvas);
  const inputs = new MediaInputs(spec.mediaAssets, warn);
  const feeder = new Feeder(inputs, compositor, warn);
  try {
    compositor.setScale(target.width / timeline.width);
    const graph = buildFrameGraph(doc, timeline.id, frame, options);
    await feeder.prepare(collectMediaLayers(graph.layers, []));
    if (!compositor.render(graph, feeder)) throw new Error("The graphics context was lost while rendering.");
    const out = compositor.outputSize(timeline.width, timeline.height);
    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.drawImage(glCanvas, 0, 0);
    return { canvas, width: out.width, height: out.height, warnings };
  } finally {
    await feeder.close().catch(() => undefined);
    inputs.dispose();
    compositor.dispose();
  }
}

// MARK: - Source frame

export class SourceFrameError extends Error {}

export interface SourceFrameRequest {
  /** Absolute track time (seconds) to decode. */
  time: number;
  capturesLastFrame: boolean;
}

const mediaDurationReceiptTolerance = 0.001;

/** Port of `FrameCaptureRenderer.sourceFrameRequest`: maps source-relative seconds to a track time. */
export function sourceFrameRequest(
  sourceSeconds: number,
  timeRange: { start: number; duration: number },
  minimumFrameDuration: number,
): SourceFrameRequest {
  const { start, duration } = timeRange;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || !(duration > 0)) {
    throw new SourceFrameError("The video has no finite duration.");
  }
  if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0 || sourceSeconds > duration + mediaDurationReceiptTolerance) {
    throw new SourceFrameError(`Source time ${sourceSeconds.toFixed(3)}s is outside 0…${duration.toFixed(3)}s.`);
  }
  const capturesLastFrame = sourceSeconds >= duration - minimumFrameDuration;
  const time = capturesLastFrame ? Math.max(start, start + duration - minimumFrameDuration) : start + sourceSeconds;
  return { time, capturesLastFrame };
}

export interface DecodedSourceFrame {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  /** Source-relative seconds of the frame that was actually decoded. */
  actualSourceSeconds: number;
}

/** Decodes the frame of a video file at `sourceSeconds` (source-relative), orientation applied. */
export async function decodeSourceFrame(url: string, sourceSeconds: number): Promise<DecodedSourceFrame> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new SourceFrameError("No video track is available.");
    if (!(await track.canDecode())) throw new SourceFrameError("Could not render the frame: this system cannot decode the video.");
    const start = await track.getFirstTimestamp();
    const duration = (await track.computeDuration()) - start;
    const stats = await track.computePacketStats(50);
    const minimumFrameDuration = stats.averagePacketRate > 0 ? 1 / stats.averagePacketRate : 1 / 600;
    const request = sourceFrameRequest(sourceSeconds, { start, duration }, minimumFrameDuration);
    const sink = new VideoSampleSink(track);
    let sample: VideoSample | null = await sink.getSample(request.time);
    if (!sample && request.capturesLastFrame) sample = await sink.getSample(request.time - minimumFrameDuration);
    if (!sample) throw new SourceFrameError("Could not render the frame: no frame could be decoded at that time.");
    try {
      const w = sample.displayWidth, h = sample.displayHeight;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new SourceFrameError("Could not render the frame: canvas 2D unavailable.");
      sample.draw(ctx, 0, 0);
      return { canvas, width: w, height: h, actualSourceSeconds: sample.timestamp - start };
    } finally {
      sample.close();
    }
  } finally {
    input.dispose();
  }
}
