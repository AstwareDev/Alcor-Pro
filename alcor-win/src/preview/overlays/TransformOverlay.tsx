import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { Editor } from "../../editor/editor";
import { selectPreviewClip } from "../../editor/mutations/selection";
import type { Point, Size } from "../../model/geometry";
import { clipTransformAt } from "../../model";
import { createSurfaceDrag } from "./dragSurface";
import { beginTransformDrag } from "./gestures";
import { previewClipIdAt } from "./hitTester";
import { handleSize, rotateHandleSize } from "./overlayMetrics";
import { selectedVisualClip } from "./overlaySelection";
import { boxGeometry, cornerList, resizeCursor, transformHitAt, type BoxGeometry, type CenterGuides, type TransformHit } from "./transformMath";

const noGuides: CenterGuides = { x: false, y: false };

function cursorFor(hit: TransformHit | null, g: BoxGeometry | undefined): string {
  if (!hit) return "default";
  switch (hit.kind) {
    case "rotate": return "grab";
    case "move": return "move";
    case "resize": return resizeCursor(hit.corner, g?.rotation ?? 0);
  }
}

const pointsOf = (g: BoxGeometry): string => {
  const c = g.corners;
  return `${c.topLeft.x},${c.topLeft.y} ${c.topRight.x},${c.topRight.y} ${c.bottomRight.x},${c.bottomRight.y} ${c.bottomLeft.x},${c.bottomLeft.y}`;
};

/**
 * Port of `TransformOverlayView` plus click-to-select (`PreviewHitTester`) and a rotation handle: drag the box to move,
 * corners to resize (text scales), the round handle to rotate. One pointer drag is one undo entry; Escape cancels.
 */
export function TransformOverlay(props: { editor: Editor; size: Size }) {
  const editor = props.editor;
  let surface: HTMLDivElement | undefined;
  const drag = createSurfaceDrag(() => surface, () => props.size);
  const [guides, setGuides] = createSignal<CenterGuides>(noGuides, { equals: (a, b) => a.x === b.x && a.y === b.y });

  const selected = createMemo(() => selectedVisualClip(editor));
  const geometry = createMemo(() => {
    const clip = selected();
    if (!clip) return undefined;
    return boxGeometry(clipTransformAt(clip, editor.ui.currentFrame), props.size, clip.mediaType === "text");
  });
  onCleanup(() => drag.cancel());

  const hitAt = (p: Point): TransformHit | null => {
    const g = geometry();
    return g ? transformHitAt(p, g) : null;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || drag.active) return;
    const p = drag.toLocal(e);
    let hit = hitAt(p);
    if (!hit) {
      const id = previewClipIdAt(editor, p, props.size);
      if (id === undefined) return;
      selectPreviewClip(editor, id);
      if (!selected()) return;
      hit = { kind: "move" };
    }
    const clip = selected();
    if (!clip) return;
    const session = beginTransformDrag(editor, clip.id, hit, p, props.size, setGuides);
    if (!session) return;
    e.preventDefault();
    drag.start(e, session);
    if (surface) surface.style.cursor = hit.kind === "rotate" ? "grabbing" : cursorFor(hit, geometry());
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (drag.move(e) || !surface) return;
    surface.style.cursor = cursorFor(hitAt(drag.toLocal(e)), geometry());
  };
  const onPointerUp = (e: PointerEvent): void => drag.end(e);

  return (
    <div
      class="ov-surface"
      ref={surface}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => drag.cancel()}
    >
      <svg class="ov-svg" width={props.size.width} height={props.size.height}>
        <Show when={geometry()}>
          {(g) => (
            <>
              <polygon class="ov-outline" points={pointsOf(g())} />
              <line
                class="ov-stem"
                x1={(g().corners.topLeft.x + g().corners.topRight.x) / 2}
                y1={(g().corners.topLeft.y + g().corners.topRight.y) / 2}
                x2={g().rotateHandle.x}
                y2={g().rotateHandle.y}
              />
              <circle class="ov-rotate" cx={g().rotateHandle.x} cy={g().rotateHandle.y} r={rotateHandleSize / 2} />
              <For each={cornerList}>
                {(corner) => (
                  <rect
                    class="ov-handle"
                    x={g().corners[corner].x - handleSize / 2}
                    y={g().corners[corner].y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    transform={`rotate(${g().rotation} ${g().corners[corner].x} ${g().corners[corner].y})`}
                  />
                )}
              </For>
            </>
          )}
        </Show>
        <Show when={selected() && guides().x}>
          <line class="ov-guide" x1={props.size.width / 2} y1={0} x2={props.size.width / 2} y2={props.size.height} />
        </Show>
        <Show when={selected() && guides().y}>
          <line class="ov-guide" x1={0} y1={props.size.height / 2} x2={props.size.width} y2={props.size.height / 2} />
        </Show>
      </svg>
    </div>
  );
}
