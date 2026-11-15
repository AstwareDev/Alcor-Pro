// Runtime half of Search/Indexing/FrameSampler.swift: decodes candidate frames with mediabunny and streams the ones the
// ShotSelector keeps, each as a squash-resized RGBA square ready for the embedder. Selection rules live in `shots.ts`.
import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";
import { abortError, throwIfAborted } from "../media/concurrency";
import { mediaUrl } from "../media/mediaUrl";
import { candidateTimes, defaultSamplerOptions, lumaCells, lumaGrid, ShotSelector, type SamplerOptions } from "./shots";

export interface SampledFrame {
  time: number;
  isNewShot: boolean;
  /** RGBA, size x size. */
  pixels: Uint8ClampedArray;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function context(canvas: HTMLCanvasElement | OffscreenCanvas): Ctx2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas is unavailable.");
  return ctx as Ctx2D;
}

/** Visually distinct frames of a video, in time order. Aborting `signal` ends the stream. */
export async function* sampleVideoFrames(
  path: string,
  duration: number,
  size: number,
  signal?: AbortSignal,
  options: SamplerOptions = defaultSamplerOptions,
): AsyncGenerator<SampledFrame> {
  const times = candidateTimes(duration, options);
  if (times.length === 0) return;
  const input = new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return;
    const first = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { width: size, height: size, fit: "fill" });
    const small = new OffscreenCanvas(lumaCells, lumaCells);
    const smallCtx = context(small);
    smallCtx.imageSmoothingQuality = "high";
    const selector = new ShotSelector(options);
    const requested = times.map((t) => Math.max(t, first));
    for await (const wrapped of sink.canvasesAtTimestamps(requested)) {
      throwIfAborted(signal);
      if (!wrapped) continue;
      smallCtx.drawImage(wrapped.canvas, 0, 0, lumaCells, lumaCells);
      const grid = lumaGrid(smallCtx.getImageData(0, 0, lumaCells, lumaCells).data);
      const time = wrapped.timestamp;
      const { keep, isNewShot } = selector.consider(time, grid);
      if (!keep) continue;
      yield { time, isNewShot, pixels: context(wrapped.canvas).getImageData(0, 0, size, size).data };
    }
  } finally {
    input.dispose();
  }
}

/** A still, squash-resized to a size x size RGBA square; undefined when it cannot be decoded. */
export async function decodeStill(path: string, size: number, signal?: AbortSignal): Promise<Uint8ClampedArray | undefined> {
  const res = await fetch(mediaUrl(path));
  if (!res.ok) return undefined;
  const blob = await res.blob();
  if (signal?.aborted) throw abortError();
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = context(canvas);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  } finally {
    bitmap.close();
  }
}
