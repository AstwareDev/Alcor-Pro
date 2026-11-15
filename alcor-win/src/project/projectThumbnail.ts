import type { Editor } from "../editor/editor";
import type { Timeline } from "../model";
import { pathKey } from "./projectPaths";

// Port of VideoProject.captureThumbnail: the project card thumbnail is the first usable video-track clip
// (image or video), long edge 640, JPEG quality 0.7. Here it is rendered through the offline compositor so the
// card shows what the timeline shows at that clip's first frame.

export const thumbnailLongestEdge = 640;
export const thumbnailJpegQuality = 0.7;
/** Minimum spacing between background captures while editing. */
export const thumbnailMinIntervalMs = 30_000;
/** A close-time capture gives up after this long so quitting never hangs on a stuck decode. */
export const thumbnailFlushTimeoutMs = 4000;

/**
 * Timeline frame to render: the start of the first image/video clip on the first video track that has one
 * (Swift walks tracks then clips and takes the first candidate). Null when the timeline has no such clip.
 */
export function thumbnailFrame(timeline: Timeline): number | null {
  for (const track of timeline.tracks) {
    if (track.type !== "video") continue;
    let best: number | null = null;
    for (const clip of track.clips) {
      if (clip.mediaType !== "image" && clip.mediaType !== "video") continue;
      if (best === null || clip.startFrame < best) best = clip.startFrame;
    }
    if (best !== null) return Math.max(0, best);
  }
  return null;
}

/** Renders the active timeline's thumbnail frame to JPEG bytes; null when there is nothing to show. */
export async function renderProjectThumbnail(editor: Editor): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const frame = thumbnailFrame(editor.timeline);
  if (frame === null) return null;
  const { renderTimelineFrameRaw } = await import("../agent/tools/renderTimelineFrame");
  const rendered = await renderTimelineFrameRaw(editor, frame, thumbnailLongestEdge);
  const blob = await rendered.canvas.convertToBlob({ type: "image/jpeg", quality: thumbnailJpegQuality });
  return new Uint8Array(await blob.arrayBuffer());
}

export interface ThumbnailSchedulerOptions {
  capture: () => Promise<Uint8Array | null>;
  onCaptured: (jpeg: Uint8Array) => void;
  isPlaying: () => boolean;
  minIntervalMs?: number;
  flushTimeoutMs?: number;
  now?: () => number;
}

/**
 * Throttles thumbnail captures: at most one per interval (leading edge when idle long enough, otherwise one
 * trailing capture), one in flight at a time, none while playing. `flush` is the close-time capture.
 */
export class ThumbnailScheduler {
  private readonly opts: Required<ThumbnailSchedulerOptions>;
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ThumbnailSchedulerOptions) {
    this.opts = {
      minIntervalMs: thumbnailMinIntervalMs,
      flushTimeoutMs: thumbnailFlushTimeoutMs,
      now: () => Date.now(),
      ...options,
    };
  }

  /** The document changed; capture now if the throttle allows, else once when it does. */
  request(): void {
    if (this.disposed || this.timer !== null || this.inFlight !== null) return;
    const wait = this.lastStart + this.opts.minIntervalMs - this.opts.now();
    if (wait <= 0) {
      void this.run();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  /** Close-time capture: ignores the throttle but still never runs during playback; bounded by a timeout. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    this.cancelTimer();
    if (this.inFlight === null && this.opts.isPlaying()) return;
    const work = this.inFlight ?? this.run();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((r) => { timeout = setTimeout(r, this.opts.flushTimeoutMs); })]);
    clearTimeout(timeout);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): Promise<void> {
    if (this.opts.isPlaying()) return Promise.resolve();
    this.lastStart = this.opts.now();
    const job = (async () => {
      try {
        const jpeg = await this.opts.capture();
        if (jpeg !== null && !this.disposed) this.opts.onCaptured(jpeg);
      } catch (error) {
        console.warn("project thumbnail capture failed", error);
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = job;
    return job;
  }
}

// MARK: - Cache buster

const launchStamp = Date.now();
const savedCounts = new Map<string, number>();

/** Bumped by the session after each captured thumbnail so Home's `<img>` refetches the re-saved file. */
export function noteThumbnailSaved(path: string): void {
  savedCounts.set(pathKey(path), (savedCounts.get(pathKey(path)) ?? 0) + 1);
}

export function thumbnailCacheBuster(path: string): string {
  return `${launchStamp}-${savedCounts.get(pathKey(path)) ?? 0}`;
}
