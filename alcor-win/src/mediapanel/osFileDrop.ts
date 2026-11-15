// Drop of OS files / folders onto the panel (MediaPanelDropArea). Tauri reports real paths through
// `onDragDropEvent` (physical pixel positions); the browser fallback only works for Files that carry a path.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface OsFileDropHandlers {
  onHover: (hovering: boolean) => void;
  /** `target` is the element under the pointer; a folder tile or breadcrumb chip ancestor picks the destination. */
  onDrop: (paths: string[], target: Element | null) => void;
  /** Browser drops without paths cannot be imported. */
  onUnsupported: (message: string) => void;
}

/** Returns an unsubscribe function. */
export function installOsFileDrop(root: HTMLElement, handlers: OsFileDropHandlers): () => void {
  if (isTauri()) return installTauriDrop(root, handlers);
  return installDomDrop(root, handlers);
}

function elementAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

function installTauriDrop(root: HTMLElement, handlers: OsFileDropHandlers): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const inside = (physical: { x: number; y: number }): Element | null => {
    const ratio = window.devicePixelRatio || 1;
    const el = elementAt(physical.x / ratio, physical.y / ratio);
    return el && root.contains(el) ? el : null;
  };
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") handlers.onHover(false);
      else if (p.type === "drop") {
        const target = inside(p.position);
        handlers.onHover(false);
        if (target && p.paths.length > 0) handlers.onDrop(p.paths, target);
      } else handlers.onHover(inside(p.position) !== null);
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

function filePath(file: File): string | undefined {
  const withPath = file as File & { path?: unknown };
  return typeof withPath.path === "string" && withPath.path !== "" ? withPath.path : undefined;
}

function installDomDrop(root: HTMLElement, handlers: OsFileDropHandlers): () => void {
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    handlers.onHover(true);
  };
  const leave = (e: DragEvent) => {
    if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
    handlers.onHover(false);
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    handlers.onHover(false);
    const paths = [...(e.dataTransfer?.files ?? [])].map(filePath).filter((p): p is string => p !== undefined);
    if (paths.length > 0) handlers.onDrop(paths, e.target instanceof Element ? e.target : null);
    else handlers.onUnsupported("This browser does not expose file paths; drop files in the desktop app to import them.");
  };
  root.addEventListener("dragover", over);
  root.addEventListener("dragleave", leave);
  root.addEventListener("drop", drop);
  return () => {
    root.removeEventListener("dragover", over);
    root.removeEventListener("dragleave", leave);
    root.removeEventListener("drop", drop);
  };
}
