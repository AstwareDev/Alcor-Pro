import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { Clip } from "../model";
import { TextRenderer } from "../preview/textRenderer";
import { captionPreviewLoopFrames, drawCaptionPreviewFrame } from "./captionPreviewRender";

const fps = 30;

/**
 * Canvas that renders a synthetic caption clip with the compositor's text renderer: a settled `posterFrame`, or the
 * looping animation while `animating()` (port of the Swift `TimelineView(.periodic)` loops).
 */
export function AnimatedCaptionCanvas(props: {
  clip: Accessor<Clip>;
  /** CSS pixels. */
  width: Accessor<number>;
  height: Accessor<number>;
  animating: Accessor<boolean>;
  posterFrame: Accessor<number>;
  class?: string;
}) {
  let canvas: HTMLCanvasElement | undefined;
  const renderer = new TextRenderer();
  onCleanup(() => renderer.dispose());

  const draw = (frame: number): void => {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawCaptionPreviewFrame(renderer, ctx, props.clip(), frame, { width: canvas.width, height: canvas.height });
  };

  createEffect(() => {
    const clip = props.clip();
    const w = props.width();
    const h = props.height();
    if (!canvas || !(w >= 1 && h >= 1)) return;
    const scale = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const preset = clip.textAnimation?.preset ?? "none";
    const loop = captionPreviewLoopFrames(preset);
    if (!props.animating()) {
      draw(Math.min(props.posterFrame(), loop - 1));
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (): void => {
      draw(Math.floor(((performance.now() - start) / 1000) * fps) % loop);
      raf = requestAnimationFrame(tick);
    };
    tick();
    onCleanup(() => cancelAnimationFrame(raf));
  });

  return <canvas ref={canvas} class={props.class} style={{ width: `${props.width()}px`, height: `${props.height()}px` }} />;
}
