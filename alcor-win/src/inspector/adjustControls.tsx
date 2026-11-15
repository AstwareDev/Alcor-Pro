import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { CurvePoint } from "../model";
import { colorWheelsDisplayColor } from "../preview/effects/colorWheels";
import { AdjustSlider } from "../ui/AdjustSlider";
import { EditorResetButton } from "../ui/EditorPanel";
import { SegmentedControl } from "../ui/SegmentedControl";
import { grabPoint, movePoint, pointsToStore, removeNearestPoint, toScreen } from "./curveEditing";
import "./adjustControls.css";

export interface CurveChannelSpec {
  id: string;
  label: string;
  /** CSS color of the curve and its points. */
  tint: string;
}

/**
 * Shared body of `CurveEditorView` / `HueCurveEditorView`: channel picker, grid, curve, draggable points.
 * Drag grabs the nearest point (or adds one); double-click removes the nearest interior point; Escape cancels a drag.
 * The luma/RGB/hue histogram overlay needs the preview engine and is not drawn.
 */
export function CurveEditor(props: {
  channels: readonly CurveChannelSpec[];
  /** Stored points for a channel (empty = default). */
  stored: (channel: string) => readonly CurvePoint[];
  defaults: readonly CurvePoint[];
  evalCurve: (pts: readonly CurvePoint[], x: number) => number;
  vGrid: number;
  spectrum?: boolean;
  diagonal?: boolean;
  step: number;
  hint?: string;
  onChange: (channel: string, pts: CurvePoint[]) => void;
  onCommit: (channel: string, pts: CurvePoint[]) => void;
  /** Restores the active channel to its default curve (one undo entry). */
  onResetChannel: (channel: string) => void;
  onCancel: () => void;
}) {
  const [channel, setChannel] = createSignal(props.channels[0]?.id ?? "");
  const [live, setLive] = createSignal<{ points: CurvePoint[]; index: number } | null>(null);
  let svg: SVGSVGElement | undefined;
  let down: { x: number; y: number; moved: boolean } | null = null;
  let cancelled = false;

  const tint = (): string => props.channels.find((c) => c.id === channel())?.tint ?? "var(--text-primary)";
  const sorted = (): CurvePoint[] => {
    const stored = props.stored(channel());
    return [...(stored.length === 0 ? props.defaults : stored)].sort((a, b) => a.x - b.x);
  };
  const active = (): CurvePoint[] => live()?.points ?? sorted();
  const channelModified = (): boolean => pointsToStore(props.stored(channel()), props.defaults).length > 0;
  const [dims, setDims] = createSignal({ width: 300, height: 180 });
  const size = () => dims();
  onMount(() => {
    const measure = (): void => {
      const r = (svg as SVGSVGElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setDims({ width: r.width, height: r.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg as SVGSVGElement);
    onCleanup(() => observer.disconnect());
  });
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = (svg as SVGSVGElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const emit = (pts: CurvePoint[], commit: boolean): void => {
    const value = pointsToStore(pts, props.defaults);
    if (commit) props.onCommit(channel(), value);
    else props.onChange(channel(), value);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !down) return;
    e.stopPropagation();
    cancelled = true;
    down = null;
    setLive(null);
    props.onCancel();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const curvePath = (): string => {
    const { width, height } = size();
    const pts = active();
    const parts: string[] = [];
    for (let i = 0; i <= 1 + 1e-9; i += props.step) {
      const p = toScreen({ x: i, y: props.evalCurve(pts, i) }, { width, height });
      parts.push(`${parts.length === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    }
    return parts.join(" ");
  };

  return (
    <div class="curve-editor">
      <div class="curve-header">
        <SegmentedControl
          small
          value={channel()}
          onChange={(c) => setChannel(c)}
          options={props.channels.map((c) => ({ value: c.id, label: c.label }))}
        />
        <EditorResetButton title="Curve" modified={channelModified()} onClick={() => props.onResetChannel(channel())} />
      </div>
      <svg
        ref={svg}
        class="curve-canvas"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = local(e);
          down = { ...p, moved: false };
          cancelled = false;
        }}
        onPointerMove={(e) => {
          if (!down) return;
          const p = local(e);
          if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) < 3) return;
          if (!live()) setLive(grabPoint(sorted(), down.x, down.y, size()));
          down.moved = true;
          const l = live();
          if (!l) return;
          const next = { points: movePoint(l.points, l.index, p.x, p.y, size()), index: l.index };
          setLive(next);
          emit(next.points, false);
        }}
        onPointerUp={(e) => {
          const wasMoved = down?.moved ?? false;
          down = null;
          if (cancelled || !wasMoved) return;
          const l = live();
          const p = local(e);
          if (l) emit(movePoint(l.points, l.index, p.x, p.y, size()), true);
          setLive(null);
        }}
        onDblClick={(e) => {
          const p = local(e);
          const removed = removeNearestPoint(sorted(), p.x, p.y, size());
          if (removed) emit(removed, true);
        }}
      >
        <Show when={props.spectrum}>
          <foreignObject x="0" y="0" width="100%" height="100%">
            <div class="curve-spectrum" />
          </foreignObject>
        </Show>
        <For each={Array.from({ length: props.vGrid + 1 }, (_, i) => i / props.vGrid)}>
          {(s) => <line class="curve-grid" x1={`${s * 100}%`} x2={`${s * 100}%`} y1="0" y2="100%" />}
        </For>
        <Show when={!props.spectrum}>
          <For each={[0, 0.25, 0.5, 0.75, 1]}>{(s) => <line class="curve-grid" y1={`${s * 100}%`} y2={`${s * 100}%`} x1="0" x2="100%" />}</For>
        </Show>
        <Show when={props.spectrum}>
          <line class="curve-grid dashed" y1="50%" y2="50%" x1="0" x2="100%" />
        </Show>
        <Show when={props.diagonal}>
          <line class="curve-grid dashed" x1="0" y1="100%" x2="100%" y2="0" />
        </Show>
        <path d={curvePath()} fill="none" stroke={tint()} stroke-width="1.5" />
        <For each={active()}>
          {(pt) => {
            const s = () => toScreen(pt, size());
            return <circle cx={s().x} cy={s().y} r="4.5" fill={tint()} pointer-events="none" />;
          }}
        </For>
      </svg>
      <Show when={props.hint}>
        <span class="curve-hint">{props.hint}</span>
      </Show>
    </div>
  );
}

let wheelCache: HTMLCanvasElement | undefined;

/** Neutral gray centre fading to saturated hue at the rim; built once and shared by every pad. */
function wheelImage(): HTMLCanvasElement {
  if (wheelCache) return wheelCache;
  const d = 160;
  const c = d / 2;
  const canvas = document.createElement("canvas");
  canvas.width = d;
  canvas.height = d;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(d, d);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < d; i++) {
      const vx = (i - c) / c;
      const vy = (c - j) / c;
      const r = Math.hypot(vx, vy);
      if (r > 1.02) continue;
      const [cr, cg, cb] = colorWheelsDisplayColor(vx, vy);
      const a = r <= 1 ? 1 : Math.max(0, 1 - (r - 1) / 0.02);
      const o = (j * d + i) * 4;
      img.data[o] = Math.min(255, Math.max(0, cr * 255));
      img.data[o + 1] = Math.min(255, Math.max(0, cg * 255));
      img.data[o + 2] = Math.min(255, Math.max(0, cb * 255));
      img.data[o + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  wheelCache = canvas;
  return canvas;
}

/** Port of `ColorWheelPad`: unit-disk pad, y up. Double-click resets to the centre. */
export function ColorWheelPad(props: {
  x: number;
  y: number;
  onChanged: (x: number, y: number) => void;
  onCommit: (x: number, y: number) => void;
  onCancel: () => void;
}) {
  let host: HTMLDivElement | undefined;
  let dragging = false;
  let cancelled = false;
  onMount(() => {
    const canvas = wheelImage();
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d")?.drawImage(canvas, 0, 0);
    copy.className = "wheel-image";
    host?.prepend(copy);
  });
  const point = (e: PointerEvent): [number, number] => {
    const r = (host as HTMLDivElement).getBoundingClientRect();
    const radius = r.width / 2;
    let vx = (e.clientX - r.left - radius) / radius;
    let vy = (r.top + radius - e.clientY) / radius;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) {
      vx /= mag;
      vy /= mag;
    }
    return [vx, vy];
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !dragging) return;
    e.stopPropagation();
    cancelled = true;
    dragging = false;
    props.onCancel();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <div
      ref={host}
      class="wheel-pad"
      onPointerDown={(e) => {
        if (e.button !== 0 || e.detail >= 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging = true;
        cancelled = false;
        props.onChanged(...point(e));
      }}
      onPointerMove={(e) => {
        if (dragging) props.onChanged(...point(e));
      }}
      onPointerUp={(e) => {
        if (!dragging || cancelled) return;
        dragging = false;
        props.onCommit(...point(e));
      }}
      onDblClick={() => props.onCommit(0, 0)}
    >
      <span class="wheel-cross h" />
      <span class="wheel-cross v" />
      <span class="wheel-ring" />
      <span class="wheel-puck" style={{ left: `${50 + props.x * 50}%`, top: `${50 - props.y * 50}%` }} />
    </div>
  );
}

/** Port of `ColorWheelControl`: title, pad, master luma slider. */
export function ColorWheelControl(props: {
  title: string;
  x: number;
  y: number;
  master: number;
  masterMin: number;
  masterMax: number;
  masterDefault: number;
  modified: boolean;
  onReset: () => void;
  onColorChanged: (x: number, y: number) => void;
  onColorCommit: (x: number, y: number) => void;
  onMasterChanged: (v: number) => void;
  onMasterCommit: (v: number) => void;
  onCancel: () => void;
}) {
  return (
    <div class="wheel-control">
      <div class="wheel-title-row">
        <span class="wheel-title">{props.title}</span>
        <EditorResetButton title={props.title} modified={props.modified} onClick={props.onReset} />
      </div>
      <ColorWheelPad x={props.x} y={props.y} onChanged={props.onColorChanged} onCommit={props.onColorCommit} onCancel={props.onCancel} />
      <div style={{ width: "var(--wheel-pad)", display: "flex" }}>
        <AdjustSlider
          value={props.master}
          min={props.masterMin}
          max={props.masterMax}
          gradient="var(--slider-luma)"
          defaultValue={props.masterDefault}
          onChanged={props.onMasterChanged}
          onCommit={props.onMasterCommit}
          onCancel={props.onCancel}
          label={`${props.title} master`}
        />
      </div>
    </div>
  );
}
