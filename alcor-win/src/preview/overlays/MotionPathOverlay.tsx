import { Index, Show, createMemo, onCleanup } from "solid-js";
import type { Editor } from "../../editor/editor";
import { applyClipProperty, commitClipProperty, revertClipProperty } from "../../editor/mutations/clipMutations";
import { clipUpsertKeyframe, makeAnimPair } from "../../model";
import type { Point, Size } from "../../model/geometry";
import { centerPixelAt, motionKeyframePoints, motionPathPoints, topLeftForCenterPixel } from "./motionPath";
import { selectedVisualClip } from "./overlaySelection";
import "./motionPath.css";

const dotRadius = 4;

/**
 * Motion path of the selected clip: the center's route as a dotted line with a dot per position keyframe.
 * Dragging a dot rewrites that keyframe; one drag is one undo entry, Escape cancels.
 */
export function MotionPathOverlay(props: { editor: Editor; size: Size }) {
  const editor = props.editor;
  let svg!: SVGSVGElement;
  let cancelDrag: (() => void) | undefined;

  const clip = createMemo(() => {
    const c = selectedVisualClip(editor);
    return c?.positionTrack && c.positionTrack.keyframes.length > 0 ? c : undefined;
  });
  const path = createMemo(() => {
    const c = clip();
    return c ? motionPathPoints(c, props.size) : "";
  });
  const dots = createMemo(() => {
    const c = clip();
    return c ? motionKeyframePoints(c, props.size) : [];
  });
  const playhead = createMemo((): Point | undefined => {
    const c = clip();
    const frame = editor.ui.currentFrame;
    if (!c || frame < c.startFrame || frame >= c.startFrame + c.durationFrames) return undefined;
    return centerPixelAt(c, frame, props.size);
  });
  onCleanup(() => cancelDrag?.());

  const toLocal = (e: PointerEvent): Point => {
    const r = svg.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { x: e.clientX, y: e.clientY };
    return { x: ((e.clientX - r.left) * props.size.width) / r.width, y: ((e.clientY - r.top) * props.size.height) / r.height };
  };

  const startDrag = (e: PointerEvent, clipId: string, offset: number): void => {
    if (e.button !== 0 || cancelDrag) return;
    const target = e.currentTarget as SVGCircleElement;
    const startClip = editor.clipFor(clipId);
    if (!startClip) return;
    e.preventDefault();
    e.stopPropagation();
    target.setPointerCapture(e.pointerId);
    const frame = startClip.startFrame + offset;
    const write = (p: Point): void => {
      applyClipProperty(editor, clipId, (c) => {
        const tl = topLeftForCenterPixel(c, frame, p, props.size);
        clipUpsertKeyframe(c, "positionTrack", frame, makeAnimPair(tl.x, tl.y));
      });
    };
    const finish = (): void => {
      window.removeEventListener("keydown", onKey, true);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", cancel);
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      cancelDrag = undefined;
    };
    const onMove = (ev: PointerEvent): void => write(toLocal(ev));
    const onUp = (ev: PointerEvent): void => {
      write(toLocal(ev));
      finish();
      commitClipProperty(editor, clipId, () => undefined, "Move Keyframe Position");
    };
    const cancel = (): void => {
      finish();
      revertClipProperty(editor, clipId);
    };
    function onKey(ev: KeyboardEvent): void {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    }
    cancelDrag = cancel;
    window.addEventListener("keydown", onKey, true);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", cancel);
  };

  return (
    <Show when={clip()}>
      {(c) => (
        <svg ref={svg} class="motion-path" width={props.size.width} height={props.size.height}>
          <Show when={path() !== ""}>
            <polyline class="motion-path-under" points={path()} />
            <polyline class="motion-path-line" points={path()} />
          </Show>
          <Show when={playhead()}>{(p) => <circle class="motion-path-now" cx={p().x} cy={p().y} r={dotRadius - 1} />}</Show>
          {/* Index keeps each dot's element (and its pointer capture) alive while its keyframe moves. */}
          <Index each={dots()}>
            {(d) => (
              <circle
                class="motion-path-dot"
                cx={d().point.x}
                cy={d().point.y}
                r={dotRadius}
                onPointerDown={(e) => startDrag(e, c().id, d().offset)}
              />
            )}
          </Index>
        </svg>
      )}
    </Show>
  );
}
