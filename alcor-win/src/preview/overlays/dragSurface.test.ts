import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSurfaceDrag } from "./dragSurface";
import type { DragSession } from "./gestures";

function fakeSurface() {
  const captured = new Set<number>();
  return {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    captured,
  };
}

const pointer = (x: number, y: number, extra: Partial<PointerEvent> = {}): PointerEvent =>
  ({ clientX: x, clientY: y, pointerId: 3, shiftKey: false, ...extra }) as PointerEvent;

function session() {
  const calls: string[] = [];
  const s: DragSession = {
    move: (p) => calls.push(`move:${p.x},${p.y}`),
    commit: (p) => calls.push(`commit:${p.x},${p.y}`),
    cancel: () => calls.push("cancel"),
  };
  return { s, calls };
}

describe("createSurfaceDrag", () => {
  let target: EventTarget;
  beforeEach(() => {
    target = new EventTarget();
    vi.stubGlobal("window", target);
  });
  afterEach(() => vi.unstubAllGlobals());

  const escape = (): Event => Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });

  it("mapsClientPixelsOntoTheOverlaySize", () => {
    const el = fakeSurface();
    const drag = createSurfaceDrag(() => el as unknown as HTMLElement, () => ({ width: 400, height: 300 }));
    expect(drag.toLocal(pointer(200, 100))).toEqual({ x: 200, y: 150 });
  });

  it("releaseCommitsOnceAndReleasesCapture", () => {
    const el = fakeSurface();
    const drag = createSurfaceDrag(() => el as unknown as HTMLElement, () => ({ width: 200, height: 100 }));
    const { s, calls } = session();
    drag.start(pointer(110, 60), s);
    expect(drag.active).toBe(true);
    expect(el.captured.has(3)).toBe(true);
    expect(drag.move(pointer(150, 80))).toBe(true);
    drag.end(pointer(160, 90));
    drag.end(pointer(170, 95));
    expect(calls).toEqual(["move:50,30", "commit:60,40"]);
    expect(drag.active).toBe(false);
    expect(el.captured.size).toBe(0);
  });

  it("escapeCancelsTheDragAndASubsequentReleaseDoesNotCommit", () => {
    const el = fakeSurface();
    const drag = createSurfaceDrag(() => el as unknown as HTMLElement, () => ({ width: 200, height: 100 }));
    const { s, calls } = session();
    drag.start(pointer(110, 60), s);
    drag.move(pointer(150, 80));
    target.dispatchEvent(escape());
    drag.end(pointer(160, 90));
    expect(calls).toEqual(["move:50,30", "cancel"]);
    expect(drag.active).toBe(false);
    expect(drag.move(pointer(1, 1))).toBe(false);
  });

  it("escapeIsIgnoredWhenNoDragIsActive", () => {
    const el = fakeSurface();
    const drag = createSurfaceDrag(() => el as unknown as HTMLElement, () => ({ width: 200, height: 100 }));
    const { s, calls } = session();
    drag.start(pointer(110, 60), s);
    drag.end(pointer(110, 60));
    target.dispatchEvent(escape());
    expect(calls).toEqual(["commit:10,10"]);
  });
});
