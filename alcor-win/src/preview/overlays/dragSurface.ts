import type { Point, Size } from "../../model/geometry";
import type { DragSession } from "./gestures";

/** Pointer-capture plumbing shared by the overlays: one drag at a time, Escape cancels, release commits. */
export interface SurfaceDrag {
  /** Pointer position in overlay pixels (the surface's CSS box mapped onto `size`). */
  toLocal(e: PointerEvent): Point;
  readonly active: boolean;
  start(e: PointerEvent, session: DragSession): void;
  /** Returns true when a drag consumed the event. */
  move(e: PointerEvent): boolean;
  end(e: PointerEvent): void;
  cancel(): void;
}

export function createSurfaceDrag(surface: () => HTMLElement | undefined, size: () => Size): SurfaceDrag {
  let session: DragSession | null = null;
  let pointerId = -1;

  const release = (): void => {
    window.removeEventListener("keydown", onKey, true);
    const el = surface();
    if (el && pointerId >= 0 && el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    session = null;
    pointerId = -1;
  };
  const cancel = (): void => {
    const s = session;
    if (!s) return;
    release();
    s.cancel();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }

  const toLocal = (e: PointerEvent): Point => {
    const rect = surface()?.getBoundingClientRect();
    const { width, height } = size();
    if (!rect || !(rect.width > 0 && rect.height > 0)) return { x: e.clientX, y: e.clientY };
    return { x: ((e.clientX - rect.left) * width) / rect.width, y: ((e.clientY - rect.top) * height) / rect.height };
  };

  return {
    toLocal,
    get active() {
      return session !== null;
    },
    start(e, next) {
      const el = surface();
      if (!el) return;
      el.setPointerCapture(e.pointerId);
      pointerId = e.pointerId;
      session = next;
      window.addEventListener("keydown", onKey, true);
    },
    move(e) {
      if (!session) return false;
      session.move(toLocal(e), { shift: e.shiftKey });
      return true;
    },
    end(e) {
      const s = session;
      if (!s) return;
      const p = toLocal(e);
      release();
      s.commit(p, { shift: e.shiftKey });
    },
    cancel,
  };
}
