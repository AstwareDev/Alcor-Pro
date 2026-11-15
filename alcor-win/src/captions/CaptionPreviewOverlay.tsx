import CaptionsIcon from "lucide-solid/icons/captions";
import { createMemo, createSignal, Show } from "solid-js";
import { makeTransform, textLayoutNaturalSize } from "../model";
import { canvasTextMeasurer } from "../preview/textRenderer";
import { AnimatedCaptionCanvas } from "./AnimatedCaptionCanvas";
import { movedCenter, type Point2, type Size2 } from "./captionPreviewPlacement";
import { captionPreviewClip } from "./captionPreviewRender";
import { captionCenterSnapValue, captionPreviewMaxTextWidthRatio } from "./constants";
import {
  captionPreviewConfiguration, captionPreviewEnabled, notifyCaptionPreviewCenterChange,
} from "./previewState";
import "./captions.css";

const minHit = 30;

/**
 * Port of `CaptionPreviewOverlay`: the live caption sample (draggable, with centre snap guides) over the timeline
 * preview. `size` is the displayed canvas size in CSS pixels, `canvas` the timeline size. Mount it inside the
 * preview canvas area with the same box as the canvas; it renders nothing while no captions tab is open.
 */
export function CaptionPreviewOverlay(props: { canvas: Size2; size: Size2 }) {
  const [dragStart, setDragStart] = createSignal<{ center: Point2; x: number; y: number } | null>(null);
  const config = createMemo(() => (captionPreviewEnabled() ? captionPreviewConfiguration() : null));

  return (
    <Show when={config()}>
      {(c) => {
        const natural = createMemo(() =>
          textLayoutNaturalSize(c().text, c().style, props.canvas.width * captionPreviewMaxTextWidthRatio, props.canvas.height, canvasTextMeasurer),
        );
        const clip = createMemo(() =>
          captionPreviewClip({
            content: c().text,
            style: c().style,
            transform: makeTransform({
              centerX: c().center.x,
              centerY: c().center.y,
              width: natural().width / props.canvas.width,
              height: natural().height / props.canvas.height,
            }),
            preset: c().preset,
            highlight: c().highlight,
          }),
        );
        const onPointerDown = (e: PointerEvent): void => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragStart({ center: c().center, x: e.clientX, y: e.clientY });
        };
        const onPointerMove = (e: PointerEvent): void => {
          const start = dragStart();
          if (!start) return;
          notifyCaptionPreviewCenterChange(movedCenter(start.center, { width: e.clientX - start.x, height: e.clientY - start.y }, props.size));
        };
        const onPointerUp = (e: PointerEvent): void => {
          onPointerMove(e);
          setDragStart(null);
        };
        return (
          <div class="cap-overlay" style={{ width: `${props.size.width}px`, height: `${props.size.height}px` }}>
            <Show when={c().center.x === captionCenterSnapValue}>
              <div class="cap-guide vertical" />
            </Show>
            <Show when={c().center.y === captionCenterSnapValue}>
              <div class="cap-guide horizontal" />
            </Show>
            <AnimatedCaptionCanvas
              class="cap-overlay-canvas"
              clip={clip}
              width={() => props.size.width}
              height={() => props.size.height}
              animating={() => c().preset !== "none"}
              posterFrame={() => 0}
            />
            <div
              class="cap-overlay-drag"
              classList={{ dragging: dragStart() !== null }}
              style={{
                width: `${Math.max(minHit, (natural().width / props.canvas.width) * props.size.width)}px`,
                height: `${Math.max(minHit, (natural().height / props.canvas.height) * props.size.height)}px`,
                left: `${c().center.x * props.size.width}px`,
                top: `${c().center.y * props.size.height}px`,
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDragStart(null)}
            />
            <span class="cap-overlay-tag">
              <CaptionsIcon size={12} />
              Preview
            </span>
          </div>
        );
      }}
    </Show>
  );
}
