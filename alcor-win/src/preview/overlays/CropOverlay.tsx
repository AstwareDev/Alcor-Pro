import { For, Show, createMemo, onCleanup } from "solid-js";
import type { Editor } from "../../editor/editor";
import type { Size } from "../../model/geometry";
import { clipCropAt, clipTransformAt } from "../../model";
import { cropHitAt, cropRectLocal, toClipLocal, type CropHit } from "./cropMath";
import { createSurfaceDrag } from "./dragSurface";
import { beginCropDrag } from "./gestures";
import { handleSize } from "./overlayMetrics";
import { selectedCropClip } from "./overlaySelection";
import { clipRectPx, cornerList, resizeCursor, type Corner } from "./transformMath";

function cursorFor(hit: CropHit | null, rotation: number, dragging: boolean): string {
  if (!hit) return "default";
  if (hit.kind === "pan") return dragging ? "grabbing" : "grab";
  return resizeCursor(hit.corner, rotation);
}

/**
 * Port of `CropOverlayView`: dimmed outside, rule-of-thirds inside, drag the window to pan the crop and the corners to
 * resize it. Drawn in the clip's rotated frame; pointer deltas are mapped back into clip axes.
 */
export function CropOverlay(props: { editor: Editor; size: Size }) {
  const editor = props.editor;
  let surface: HTMLDivElement | undefined;
  const drag = createSurfaceDrag(() => surface, () => props.size);

  const clip = createMemo(() => selectedCropClip(editor));
  const layout = createMemo(() => {
    const c = clip();
    if (!c) return undefined;
    const frame = editor.ui.currentFrame;
    const t = clipTransformAt(c, frame);
    const clipRect = clipRectPx(t, props.size);
    const crop = cropRectLocal(clipCropAt(c, frame), clipRect);
    // Crop rect in overlay space before rotation (clip-local offset by the clip's top-left).
    const abs = { x: clipRect.x + crop.x, y: clipRect.y + crop.y, width: crop.width, height: crop.height };
    return { clipRect, crop, abs, rotation: t.rotation, cx: clipRect.x + clipRect.width / 2, cy: clipRect.y + clipRect.height / 2 };
  });
  onCleanup(() => drag.cancel());

  const hitAt = (e: PointerEvent): CropHit | null => {
    const l = layout();
    if (!l) return null;
    return cropHitAt(toClipLocal(drag.toLocal(e), l.clipRect, l.rotation), l.crop);
  };

  const onPointerDown = (e: PointerEvent): void => {
    const c = clip();
    if (e.button !== 0 || drag.active || !c) return;
    const hit = hitAt(e);
    if (!hit) return;
    const session = beginCropDrag(editor, c.id, hit, drag.toLocal(e), props.size);
    if (!session) return;
    e.preventDefault();
    drag.start(e, session);
    if (surface) surface.style.cursor = cursorFor(hit, layout()?.rotation ?? 0, true);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (drag.move(e) || !surface) return;
    surface.style.cursor = cursorFor(hitAt(e), layout()?.rotation ?? 0, false);
  };

  const cornerPoint = (abs: { x: number; y: number; width: number; height: number }, corner: Corner): { x: number; y: number } => ({
    x: corner === "topLeft" || corner === "bottomLeft" ? abs.x : abs.x + abs.width,
    y: corner === "topLeft" || corner === "topRight" ? abs.y : abs.y + abs.height,
  });

  return (
    <div
      class="ov-surface"
      ref={surface}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => drag.end(e)}
      onPointerCancel={() => drag.cancel()}
    >
      <svg class="ov-svg" width={props.size.width} height={props.size.height}>
        <Show when={layout()}>
          {(l) => (
            <g transform={`rotate(${l().rotation} ${l().cx} ${l().cy})`}>
              <rect class="ov-crop-dim" x={l().clipRect.x} y={l().clipRect.y} width={l().clipRect.width} height={Math.max(0, l().abs.y - l().clipRect.y)} />
              <rect class="ov-crop-dim" x={l().clipRect.x} y={l().abs.y + l().abs.height} width={l().clipRect.width} height={Math.max(0, l().clipRect.y + l().clipRect.height - l().abs.y - l().abs.height)} />
              <rect class="ov-crop-dim" x={l().clipRect.x} y={l().abs.y} width={Math.max(0, l().abs.x - l().clipRect.x)} height={l().abs.height} />
              <rect class="ov-crop-dim" x={l().abs.x + l().abs.width} y={l().abs.y} width={Math.max(0, l().clipRect.x + l().clipRect.width - l().abs.x - l().abs.width)} height={l().abs.height} />
              <For each={[1, 2]}>
                {(i) => (
                  <>
                    <line class="ov-crop-thirds" x1={l().abs.x + (l().abs.width * i) / 3} y1={l().abs.y} x2={l().abs.x + (l().abs.width * i) / 3} y2={l().abs.y + l().abs.height} />
                    <line class="ov-crop-thirds" x1={l().abs.x} y1={l().abs.y + (l().abs.height * i) / 3} x2={l().abs.x + l().abs.width} y2={l().abs.y + (l().abs.height * i) / 3} />
                  </>
                )}
              </For>
              <rect class="ov-crop-border" x={l().abs.x} y={l().abs.y} width={l().abs.width} height={l().abs.height} />
              <For each={cornerList}>
                {(corner) => (
                  <rect
                    class="ov-crop-handle"
                    x={cornerPoint(l().abs, corner).x - handleSize / 2}
                    y={cornerPoint(l().abs, corner).y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                  />
                )}
              </For>
            </g>
          )}
        </Show>
      </svg>
    </div>
  );
}
