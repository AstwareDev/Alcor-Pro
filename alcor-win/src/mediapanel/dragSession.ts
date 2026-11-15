// Pointer-driven drag of media tiles. HTML5 drag and drop is unavailable inside a Tauri webview that has
// `dragDropEnabled` (needed for real OS file paths), so tiles are dragged with pointer events instead.
//
// Contract for drop targets (folder tiles, breadcrumb, the timeline):
//  - `activeMediaDrag()` is non-null while a drag is in flight (use it to show drop affordances);
//  - on release a bubbling `palmier-media-drop` CustomEvent<MediaDropDetail> is dispatched on the element under
//    the pointer; `payload` is the encoded text from `dragPayload.ts`;
//  - elements marked `data-drop-folder="<folderId | empty for Library>"` get `data-drop-hover` while hovered.
import { createSignal } from "solid-js";

export const mediaDropEventName = "palmier-media-drop";

export interface MediaDropDetail {
  payload: string;
  clientX: number;
  clientY: number;
}

export interface MediaDragSource {
  payload: string;
  label: string;
  /** Items in the drag (badge shown above 1). */
  count: number;
  /** Optional canvas to copy into the drag preview. */
  previewCanvas?: HTMLCanvasElement | null;
}

const [activeDrag, setActiveDrag] = createSignal<MediaDragSource | null>(null);
export { activeDrag as activeMediaDrag };

const dragThresholdPx = 4;

function buildGhost(source: MediaDragSource): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "media-drag-ghost";
  if (source.previewCanvas && source.previewCanvas.width > 0) {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 45;
    canvas.getContext("2d")?.drawImage(source.previewCanvas, 0, 0, 80, 45);
    ghost.append(canvas);
  } else {
    const name = document.createElement("span");
    name.textContent = source.label;
    ghost.append(name);
  }
  if (source.count > 1) {
    const badge = document.createElement("b");
    badge.textContent = String(source.count);
    ghost.append(badge);
  }
  return ghost;
}

function dropTargetAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

/** Arms a drag from a pointerdown: nothing happens until the pointer moves past the threshold. */
export function armMediaDrag(start: PointerEvent, resolve: () => MediaDragSource | null): void {
  if (start.button !== 0) return;
  const originX = start.clientX;
  const originY = start.clientY;
  let ghost: HTMLElement | null = null;
  let hover: HTMLElement | null = null;

  const setHover = (el: Element | null) => {
    const target = el?.closest<HTMLElement>("[data-drop-folder]") ?? null;
    if (target === hover) return;
    hover?.removeAttribute("data-drop-hover");
    target?.setAttribute("data-drop-hover", "");
    hover = target;
  };
  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - originX, e.clientY - originY) < dragThresholdPx) return;
      const source = resolve();
      if (!source) return finish(false, e);
      setActiveDrag(source);
      ghost = buildGhost(source);
      document.body.append(ghost);
      document.documentElement.classList.add("media-dragging");
    }
    ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    setHover(dropTargetAt(e.clientX, e.clientY));
  };
  const up = (e: PointerEvent) => finish(true, e);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish(false, null);
  };
  const cancel = () => finish(false, null);

  function finish(commit: boolean, e: PointerEvent | null): void {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    setHover(null);
    const source = activeDrag();
    const dragged = ghost !== null;
    ghost?.remove();
    ghost = null;
    document.documentElement.classList.remove("media-dragging");
    setActiveDrag(null);
    if (!dragged) return;
    // The click that follows a drag release must not select or open anything.
    const swallow = (ev: Event) => ev.stopImmediatePropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (commit && e && source) {
      const target = dropTargetAt(e.clientX, e.clientY);
      const detail: MediaDropDetail = { payload: source.payload, clientX: e.clientX, clientY: e.clientY };
      target?.dispatchEvent(new CustomEvent<MediaDropDetail>(mediaDropEventName, { bubbles: true, detail }));
    }
  }

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
