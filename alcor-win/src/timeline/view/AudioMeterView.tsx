import { createEffect, on, onCleanup, onMount } from "solid-js";
import type { Editor } from "../../editor/editor";
import {
  AudioMeterHub,
  METER_CEILING_DB,
  METER_FLOOR_DB,
  activeSegmentCount,
  meterBand,
  meterLayout,
  readMeterSource,
  segmentDb,
  segmentY,
  tickY,
  type AudioMeterChannelDisplay,
  type MeterLayout,
} from "../../preview/audioMeter";

const BAR_W = 8;
const RULER_X = BAR_W * 2 + 2;
const RULER_STEP_DB = 6;
const RULER_MAJOR_DB = 12;
const REFRESH_MS = 1000 / 30;
const CANVAS_W = RULER_X + 4;

interface Palette {
  bg: string;
  muted: string;
  green: string;
  yellow: string;
  red: string;
  error: string;
}

/** Port of AudioMeterView: stereo segmented master meter beside the timeline. Draws only while playing or decaying. */
export function AudioMeterView(props: { editor: Editor }) {
  let canvas!: HTMLCanvasElement;
  const hub = new AudioMeterHub();
  let ctx: CanvasRenderingContext2D | null = null;
  let palette: Palette | null = null;
  let layout: MeterLayout = meterLayout(0);
  let cssHeight = 0;
  let raf = 0;
  let lastDraw = 0;

  const now = () => performance.now() / 1000;

  const readPalette = (): Palette => {
    const cs = getComputedStyle(canvas);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
      bg: v("--bg-preview-canvas"),
      muted: v("--text-muted"),
      green: v("--meter-green"),
      yellow: v("--meter-yellow"),
      red: v("--meter-red"),
      error: v("--status-error"),
    };
  };

  const fillBand = (p: Palette, db: number) => {
    const band = meterBand(db);
    return band === "red" ? p.red : band === "yellow" ? p.yellow : p.green;
  };

  const drawChannel = (c: CanvasRenderingContext2D, p: Palette, ch: AudioMeterChannelDisplay, x: number) => {
    const active = activeSegmentCount(layout, ch.levelDb);
    for (let i = 0; i < active; i++) {
      c.fillStyle = ch.clipped && i === layout.count - 1 ? p.error : fillBand(p, segmentDb(layout, i));
      c.fillRect(x, segmentY(layout, i), BAR_W, layout.segmentHeight);
    }
    if (ch.clipped && active < layout.count) {
      c.fillStyle = p.error;
      c.fillRect(x, segmentY(layout, layout.count - 1), BAR_W, layout.segmentHeight);
    }
    if (ch.peakDb > METER_FLOOR_DB && layout.height > 0) {
      const lh = Math.min(1, layout.height);
      const y = Math.min(layout.height - lh, Math.max(0, tickY(layout, ch.peakDb, lh)));
      c.fillStyle = fillBand(p, ch.peakDb);
      c.fillRect(x, y, BAR_W, lh);
    }
  };

  const draw = (t: number) => {
    if (!ctx) return;
    palette ??= readPalette();
    const p = palette;
    const c = ctx;
    c.clearRect(0, 0, CANVAS_W, cssHeight);
    if (layout.count > 0) {
      c.fillStyle = p.bg;
      for (let i = 0; i < layout.count; i++) {
        const y = segmentY(layout, i);
        c.fillRect(0, y, BAR_W, layout.segmentHeight);
        c.fillRect(BAR_W, y, BAR_W, layout.segmentHeight);
      }
      c.fillStyle = p.muted;
      for (let db = METER_CEILING_DB; db >= METER_FLOOR_DB; db -= RULER_STEP_DB) {
        c.fillRect(RULER_X, tickY(layout, db), db % RULER_MAJOR_DB === 0 ? 4 : 2, 0.5);
      }
      drawChannel(c, p, hub.left.display(t), 0);
      drawChannel(c, p, hub.right.display(t), BAR_W);
      c.fillStyle = p.bg;
      c.fillRect(BAR_W - 0.5, 0, 1, cssHeight);
    }
  };

  const frame = (ms: number) => {
    raf = 0;
    const playing = props.editor.ui.isPlaying;
    if (ms - lastDraw >= REFRESH_MS) {
      lastDraw = ms;
      const t = now();
      const levels = readMeterSource();
      if (levels) hub.ingest(levels.left, levels.right, t);
      draw(t);
    }
    if (playing || !hub.settled(now())) raf = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const resize = () => {
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cssHeight = h;
    canvas.width = Math.round(CANVAS_W * dpr);
    canvas.height = Math.round(h * dpr);
    ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = meterLayout(h);
    draw(now());
  };

  onMount(() => {
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    onCleanup(() => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    });
  });

  // Play starts the loop; pause lets it run until the meter has decayed to the floor, then it stops.
  createEffect(on(() => props.editor.ui.isPlaying, kick));

  return (
    <div
      class="audio-meter"
      title="Reset Clipping Indicators"
      role="img"
      aria-label="Master Audio Meter"
      onClick={() => {
        hub.resetClipping();
        draw(now());
      }}
    >
      <canvas ref={canvas} class="audio-meter-canvas" style={{ width: `${CANVAS_W}px` }} />
    </div>
  );
}
