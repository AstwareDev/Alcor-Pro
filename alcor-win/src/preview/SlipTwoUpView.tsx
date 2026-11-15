import { createEffect, onCleanup, type JSX } from "solid-js";
import { formatTimecode } from "../util/timeFormatting";
import { decodeSourceFrame } from "./offlineRender";
import type { SlipPreviewState } from "./slipPreview";
import "./SlipTwoUpView.css";

/** AppTheme.Anim.slipPreviewRefresh. */
export const slipPreviewRefreshMs = 67;

/** Decodes the two frames; either may be missing when a decode fails. */
async function loadFrames(state: SlipPreviewState): Promise<[OffscreenCanvas | null, OffscreenCanvas | null]> {
  if (!(state.fps > 0)) return [null, null];
  const grab = (frame: number) =>
    decodeSourceFrame(state.url, Math.max(0, frame) / state.fps).then((d) => d.canvas, () => null);
  return Promise.all([grab(state.inSourceFrame), grab(state.outSourceFrame)]);
}

function drawFit(target: HTMLCanvasElement, source: OffscreenCanvas): void {
  const box = target.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w / source.width, h / source.height);
  const dw = source.width * scale;
  const dh = source.height * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function Pane(props: { label: string; frame: number; fps: number; canvasRef: (el: HTMLCanvasElement) => void }): JSX.Element {
  return (
    <div class="slip-pane">
      <canvas class="slip-canvas" ref={props.canvasRef} />
      <div class="slip-badge">
        <span class="slip-badge-label">{props.label}</span>
        <span class="slip-badge-time timecode">{formatTimecode(props.frame, props.fps)}</span>
      </div>
    </div>
  );
}

/** Port of `SlipTwoUpView`: the slipped clip's new first and last frame, refreshed live during the drag. */
export function SlipTwoUpView(props: { state: SlipPreviewState }): JSX.Element {
  let inCanvas: HTMLCanvasElement | undefined;
  let outCanvas: HTMLCanvasElement | undefined;
  let pending: SlipPreviewState | null = null;
  let running = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Latest-wins loader, one decode round at a time, spaced by the refresh interval (enqueue/loaderTask in Swift).
  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    while (pending !== null && !disposed) {
      const state = pending;
      pending = null;
      const [start, end] = await loadFrames(state);
      if (disposed) break;
      if (start && inCanvas) drawFit(inCanvas, start);
      if (end && outCanvas) drawFit(outCanvas, end);
      await new Promise<void>((resolve) => { timer = setTimeout(resolve, slipPreviewRefreshMs); });
    }
    running = false;
  };

  createEffect(() => {
    pending = props.state;
    void pump();
  });
  onCleanup(() => {
    disposed = true;
    pending = null;
    if (timer !== undefined) clearTimeout(timer);
  });

  return (
    <div class="slip-two-up">
      <Pane label="Start" frame={props.state.inSourceFrame} fps={props.state.fps} canvasRef={(el) => (inCanvas = el)} />
      <Pane label="End" frame={props.state.outSourceFrame} fps={props.state.fps} canvasRef={(el) => (outCanvas = el)} />
    </div>
  );
}
