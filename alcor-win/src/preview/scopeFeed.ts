import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { Editor } from "../editor/editor";
import { histogramYRGB, hueHistogram, makeHistogram, type HistogramYRGB } from "./histogram";

/** Downscaled readback of the preview frame; registered by the preview engine, null when none is mounted. */
export type FrameSampler = (cols: number, rows: number, out: Uint8Array) => boolean;
let sampler: FrameSampler | null = null;
export function setFrameSampler(next: FrameSampler | null): void {
  sampler = next;
}

const COLS = 128;
const ROWS = 72;
const THROTTLE_MS = 150;
const LUMA_BINS = 256;
const HUE_BINS = 96;

export interface ScopeFeed {
  /** Bumps whenever `histogram` / `hue` were refilled in place. */
  revision: Accessor<number>;
  histogram: HistogramYRGB;
  hue: Float32Array;
  /** False until a frame has been measured. */
  ready: Accessor<boolean>;
}

/**
 * Port of the CurveEditorView histogram refresh: remeasure the preview frame when the document or playhead changes,
 * never while playing, one pass at a time, throttled. Call from a component that exists only while the Adjust tab is visible.
 */
export function createScopeFeed(editor: Editor): ScopeFeed {
  const frame = new Uint8Array(COLS * ROWS * 4);
  const histogram = makeHistogram(LUMA_BINS);
  const hue = new Float32Array(HUE_BINS);
  const [revision, setRevision] = createSignal(0);
  const [ready, setReady] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;

  const measure = (): void => {
    timer = undefined;
    last = performance.now();
    if (!sampler || editor.ui.isPlaying || !sampler(COLS, ROWS, frame)) return;
    histogramYRGB(frame, COLS * ROWS, histogram);
    hueHistogram(frame, COLS * ROWS, hue);
    setReady(true);
    setRevision((n) => n + 1);
  };
  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(measure, Math.max(THROTTLE_MS - (performance.now() - last), 60));
  };

  createEffect(
    on(
      [() => editor.store.revision, () => editor.ui.currentFrame, () => editor.ui.isPlaying],
      () => schedule(),
    ),
  );
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return { revision, histogram, hue, ready };
}
