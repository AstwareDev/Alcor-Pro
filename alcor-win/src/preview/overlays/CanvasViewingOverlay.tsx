import { For, Show } from "solid-js";
import { canvasOverlays, canvasOverlaysEmpty, formatAspectRatios, formatContentRect, gridLinePositions, outsideRects, safeZoneInset, type CanvasGuide } from "./canvasGuides";
import "./overlays.css";

const centerArm = 14; // AppTheme.Spacing.lg

const rectPath = (x: number, y: number, w: number, h: number): string => `M${x} ${y}h${w}v${h}h${-w}z`;

// Each guide is stroked twice like `strokeGuide`: a dark under-stroke, then a light hairline.
function Stroke(props: { d: string; level: "prominent" | "medium" }) {
  return (
    <>
      <path d={props.d} class="ov-view-under" />
      <path d={props.d} class={`ov-view-line ${props.level}`} />
    </>
  );
}

/** Port of `CanvasViewingOverlay`: grid, safe-zone, center cross and format-reference mattes over the canvas. */
export function CanvasViewingOverlay(props: { size: { width: number; height: number } }) {
  const sel = canvasOverlays;
  const w = () => props.size.width;
  const h = () => props.size.height;
  const safePath = (guide: CanvasGuide): string => {
    const inset = safeZoneInset(guide) ?? 0;
    const dx = w() * inset;
    const dy = h() * inset;
    return rectPath(dx, dy, w() - dx * 2, h() - dy * 2);
  };
  const gridPath = (): string => {
    const g = sel().grid;
    if (g === null) return "";
    return gridLinePositions(g).map((p) => `M${w() * p} 0V${h()}M0 ${h() * p}H${w()}`).join("");
  };
  const centerPath = (): string =>
    `M${w() / 2 - centerArm} ${h() / 2}h${centerArm * 2}M${w() / 2} ${h() / 2 - centerArm}v${centerArm * 2}`;
  const format = () => {
    const f = sel().format;
    if (f === null) return null;
    const content = formatContentRect(formatAspectRatios[f], w(), h());
    return { content, bars: outsideRects(content, w(), h()) };
  };

  return (
    <Show when={!canvasOverlaysEmpty(sel())}>
      <svg class="ov-svg" width={w()} height={h()} aria-hidden="true">
        <Show when={format()}>
          {(f) => (
            <>
              <For each={f().bars}>{(r) => <rect class="ov-view-bar" x={r.x} y={r.y} width={r.width} height={r.height} />}</For>
              <Stroke d={rectPath(f().content.x, f().content.y, f().content.width, f().content.height)} level="medium" />
            </>
          )}
        </Show>
        <Show when={sel().grid !== null}><Stroke d={gridPath()} level="prominent" /></Show>
        <Show when={sel().guides.includes("actionSafe")}><Stroke d={safePath("actionSafe")} level="medium" /></Show>
        <Show when={sel().guides.includes("titleSafe")}><Stroke d={safePath("titleSafe")} level="prominent" /></Show>
        <Show when={sel().guides.includes("center")}><Stroke d={centerPath()} level="prominent" /></Show>
      </svg>
    </Show>
  );
}
