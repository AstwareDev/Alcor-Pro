import { For, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { Editor } from "../editor/editor";
import { setInterpolations, type KeyframeRef } from "../editor/mutations/keyframes";
import { clipKeyframeAt, interpolationHandles, type BezierHandles } from "../model";
import { CapsuleButton } from "../ui/CapsuleButton";
import {
  clampHandles, cssCubicBezier, curvePresets, fromPixel, handlesEqual, interpolationForHandles, speedCurvePoints, toPixel,
  valueCurvePoints, type PlotBox,
} from "./curveMath";
import "./curveEditor.css";

const plotWidth = 220;
const plotHeight = 170;
const box: PlotBox = { x: 14, y: 10, width: plotWidth - 28, height: plotHeight - 20 };
const handleRadius = 5;
const previewTravel = 150;
const previewMs = 1400;

type Which = 0 | 1;

/** Graph editor for one keyframe's outgoing curve: two bezier handles, speed + value curves, motion preview, presets. */
export function CurveEditorPopover(props: { initial: BezierHandles; anchor: { x: number; y: number }; onApply: (h: BezierHandles) => void; onCancel: () => void }) {
  const [handles, setHandles] = createSignal<BezierHandles>(props.initial);
  let root!: HTMLDivElement;
  let svg!: SVGSVGElement;
  let dot!: HTMLDivElement;
  let anim: Animation | undefined;
  let dragging: Which | null = null;

  const restartPreview = (): void => {
    anim?.effect?.updateTiming({ easing: cssCubicBezier(handles()) });
  };

  const setHandle = (which: Which, x: number, y: number): void => {
    const h = handles();
    setHandles(clampHandles(which === 0 ? [x, y, h[2], h[3]] : [h[0], h[1], x, y]));
    restartPreview();
  };

  const pointer = (e: PointerEvent): { x: number; y: number } => {
    const r = svg.getBoundingClientRect();
    return fromPixel(box, ((e.clientX - r.left) * plotWidth) / r.width, ((e.clientY - r.top) * plotHeight) / r.height);
  };

  onMount(() => {
    anim = dot.animate([{ transform: "translateX(0)" }, { transform: `translateX(${previewTravel}px)` }], {
      duration: previewMs,
      iterations: Infinity,
      direction: "alternate",
      easing: cssCubicBezier(handles()),
      endDelay: 250,
    });
    const down = (e: PointerEvent): void => {
      if (!root.contains(e.target as Node)) props.onCancel();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onCancel();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        props.onApply(handles());
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      anim?.cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    });
  });

  const handlePoint = (which: Which) => {
    const h = handles();
    return toPixel(box, which === 0 ? h[0] : h[2], which === 0 ? h[1] : h[3]);
  };
  const origin = toPixel(box, 0, 0);
  const target = toPixel(box, 1, 1);

  return (
    <div
      ref={root}
      class="curve-editor"
      style={{ left: `${Math.max(4, Math.min(props.anchor.x, window.innerWidth - plotWidth - 40))}px`, top: `${Math.max(4, Math.min(props.anchor.y, window.innerHeight - 340))}px` }}
    >
      <svg
        ref={svg}
        class="curve-editor-plot"
        viewBox={`0 0 ${plotWidth} ${plotHeight}`}
        width={plotWidth}
        height={plotHeight}
        onPointerMove={(e) => {
          if (dragging === null) return;
          const p = pointer(e);
          setHandle(dragging, p.x, p.y);
        }}
        onPointerUp={() => {
          dragging = null;
        }}
        onPointerCancel={() => {
          dragging = null;
        }}
      >
        <rect class="curve-editor-box" x={box.x} y={box.y} width={box.width} height={box.height} />
        <line class="curve-editor-guide" x1={box.x} x2={box.x + box.width} y1={origin.y} y2={origin.y} />
        <line class="curve-editor-guide" x1={box.x} x2={box.x + box.width} y1={target.y} y2={target.y} />
        <polyline class="curve-editor-speed" points={speedCurvePoints(box, handles())} />
        <line class="curve-editor-stem" x1={origin.x} y1={origin.y} x2={handlePoint(0).x} y2={handlePoint(0).y} />
        <line class="curve-editor-stem" x1={target.x} y1={target.y} x2={handlePoint(1).x} y2={handlePoint(1).y} />
        <polyline class="curve-editor-value" points={valueCurvePoints(box, handles())} />
        <For each={[0, 1] as const}>
          {(which) => (
            <circle
              class="curve-editor-handle"
              cx={handlePoint(which).x}
              cy={handlePoint(which).y}
              r={handleRadius}
              onPointerDown={(e) => {
                e.preventDefault();
                dragging = which;
                svg.setPointerCapture(e.pointerId);
              }}
            />
          )}
        </For>
      </svg>
      <div class="curve-editor-legend">
        <span class="curve-editor-key value">Value</span>
        <span class="curve-editor-key speed">Speed</span>
        <span class="curve-editor-numbers">{handles().map((n) => n.toFixed(2)).join(", ")}</span>
      </div>
      <div class="curve-editor-preview">
        <div ref={dot} class="curve-editor-dot" />
      </div>
      <div class="curve-editor-presets">
        <For each={curvePresets}>
          {(p) => (
            <button
              type="button"
              class="curve-editor-preset"
              classList={{ selected: handlesEqual(handles(), p.handles) }}
              onClick={() => {
                setHandles([...p.handles]);
                restartPreview();
              }}
            >
              {p.name}
            </button>
          )}
        </For>
      </div>
      <div class="curve-editor-actions">
        <span class="curve-editor-spacer" />
        <CapsuleButton onClick={props.onCancel}>Cancel</CapsuleButton>
        <CapsuleButton variant="prominent" onClick={() => props.onApply(handles())}>Apply</CapsuleButton>
      </div>
    </div>
  );
}

// The popover opens where the context menu that launched it was.
let lastMenuPoint = { x: 200, y: 200 };
if (typeof window !== "undefined") {
  window.addEventListener("contextmenu", (e) => {
    lastMenuPoint = { x: e.clientX, y: e.clientY };
  }, true);
}

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;

export function closeCurveEditor(): void {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
}

/** Opens the graph editor for one keyframe; Apply is a single undo entry. */
export function openCurveEditor(editor: Editor, ref: KeyframeRef, anchor: { x: number; y: number } = lastMenuPoint): void {
  const clip = editor.clipFor(ref.clipId);
  const kf = clip ? clipKeyframeAt(clip, ref.property, ref.frame) : undefined;
  if (!kf) return;
  closeCurveEditor();
  host = document.createElement("div");
  document.body.appendChild(host);
  const initial = interpolationHandles(kf) ?? [0.42, 0, 0.58, 1];
  dispose = render(
    () => (
      <CurveEditorPopover
        initial={initial}
        anchor={anchor}
        onCancel={closeCurveEditor}
        onApply={(h) => {
          const stored = interpolationForHandles(h);
          setInterpolations(editor, [ref], stored.interpolation, stored.bezier);
          closeCurveEditor();
        }}
      />
    ),
    host,
  );
}
