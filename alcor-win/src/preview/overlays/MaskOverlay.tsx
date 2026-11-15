import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Editor } from "../../editor/editor";
import { addMask, applyMask, cancelMask, commitMask, removeMask } from "../../editor/mutations/masks";
import type { Point, Size } from "../../model/geometry";
import {
  clipTransformAt, makeEllipsePath, makeMaskPath, makeMaskVertex, makeRectanglePath, maskFeatherAt, maskPathAt,
  type Clip, type Mask, type MaskPath, type MaskShape,
} from "../../model";
import { localToOverlay, localToRect, maskSpace, overlayToLocal, type MaskSpace } from "../masks/maskSpace";
import {
  insertVertex, moveVertex, movePath, nearestOnPath, pathContains, rectBetween, removeVertex, segmentAt, segmentCount, setClosed,
  setTangent, bezierPoint,
} from "../masks/pathMath";
import { createSurfaceDrag } from "./dragSurface";
import type { DragSession } from "./gestures";
import { selectedVisualClip } from "./overlaySelection";

const vertexHitRadius = 8;
const handleHitRadius = 7;
const segmentHitRadius = 6;
/** Distance of the feather handle beyond the shape's right edge when feather is 0. */
const featherBaseOffset = 16;
const minDrawnFraction = 0.01;

type Hit =
  | { kind: "vertex"; index: number }
  | { kind: "tangent"; index: number; side: "in" | "out" }
  | { kind: "feather" }
  | { kind: "segment"; segment: number; t: number }
  | { kind: "inside" };

/** The mask shown in the overlay, or undefined when none is selected on the clip. */
function selectedMask(editor: Editor, clip: Clip | undefined): Mask | undefined {
  const id = editor.ui.selectedMaskId;
  return id === null ? undefined : clip?.masks?.find((m) => m.id === id);
}

/** Whether the mask overlay takes over the preview: a mask tool is armed, or a mask of the selected clip is selected. */
export function maskOverlayActive(editor: Editor): boolean {
  const clip = selectedVisualClip(editor);
  if (!clip) return false;
  return editor.ui.maskTool !== null || selectedMask(editor, clip) !== undefined;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * On-canvas mask editing in the clip's local space (follows its transform): drag vertices, tangents (Alt on a vertex pulls
 * one out, Alt on a handle breaks it), click an outline to insert a vertex, drag inside to move the mask, drag the diamond
 * for feather; pen / rectangle / ellipse tools draw new masks. Every gesture is one undo entry; Escape cancels it.
 */
export function MaskOverlay(props: { editor: Editor; size: Size }) {
  const editor = props.editor;
  let surface: HTMLDivElement | undefined;
  const drag = createSurfaceDrag(() => surface, () => props.size);
  const [selectedVertex, setSelectedVertex] = createSignal<number | null>(null);
  const [penPoints, setPenPoints] = createSignal<MaskPath>(makeMaskPath([], false));
  const [draftRect, setDraftRect] = createSignal<{ a: Point; b: Point } | null>(null);
  const [cursor, setCursor] = createSignal("default");

  const clip = createMemo(() => selectedVisualClip(editor));
  const mask = createMemo(() => selectedMask(editor, clip()));
  const space = createMemo((): MaskSpace | undefined => {
    const c = clip();
    return c ? maskSpace(clipTransformAt(c, editor.ui.currentFrame), props.size) : undefined;
  });
  const offset = (): number => editor.ui.currentFrame - (clip()?.startFrame ?? 0);
  const path = createMemo((): MaskPath | undefined => {
    const m = mask();
    return m ? maskPathAt(m, offset()) : undefined;
  });
  /** Overlay pixels per timeline pixel, for feather. */
  const pxPerTimelinePx = (): number => props.size.width / Math.max(1, editor.timeline.width);

  // Leaving the tool or switching masks drops transient state.
  createEffect(() => {
    if (editor.ui.maskTool !== "pen") setPenPoints(makeMaskPath([], false));
    mask()?.id;
    setSelectedVertex(null);
  });
  onCleanup(() => drag.cancel());

  const toLocal = (p: Point): Point => {
    const s = space();
    return s ? overlayToLocal(s, p) : p;
  };
  const px = (s: MaskSpace, u: number, v: number): Point => localToOverlay(s, u, v);

  // MARK: Geometry for drawing and hit testing

  const outline = (s: MaskSpace, p: MaskPath): string => {
    if (p.vertices.length === 0) return "";
    const first = p.vertices[0];
    if (!first) return "";
    const at = (x: number, y: number): string => {
      const q = localToRect(s, x, y);
      return `${q.x} ${q.y}`;
    };
    let d = `M ${at(first.x, first.y)}`;
    for (let i = 0; i < segmentCount(p); i++) {
      const seg = segmentAt(p, i);
      d += ` C ${at(seg.c1.x, seg.c1.y)} ${at(seg.c2.x, seg.c2.y)} ${at(seg.p3.x, seg.p3.y)}`;
    }
    return p.closed ? `${d} Z` : d;
  };

  /** Feather handle: right of the shape's bounds, in unrotated rect pixels. */
  const featherHandle = (s: MaskSpace, feather: number, p: MaskPath): Point | undefined => {
    if (p.vertices.length < 3) return undefined;
    let maxX = -Infinity, sumY = 0;
    for (const v of p.vertices) {
      maxX = Math.max(maxX, v.x);
      sumY += v.y;
    }
    const edge = localToRect(s, maxX, sumY / p.vertices.length);
    const dir = s.flipH ? -1 : 1;
    return { x: edge.x + dir * (featherBaseOffset + feather * pxPerTimelinePx()), y: edge.y };
  };
  const rectToOverlay = (s: MaskSpace, q: Point): Point => {
    if (s.rotation === 0) return q;
    const c = { x: s.cx, y: s.cy };
    const a = (s.rotation * Math.PI) / 180;
    const dx = q.x - c.x, dy = q.y - c.y;
    return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
  };

  const hitAt = (p: Point): Hit | null => {
    const s = space(), m = mask(), mp = path();
    if (!s || !m || !mp) return null;
    const sel = selectedVertex();
    if (sel !== null) {
      const v = mp.vertices[sel];
      if (v) {
        for (const side of ["in", "out"] as const) {
          const ox = side === "in" ? v.inX : v.outX, oy = side === "in" ? v.inY : v.outY;
          if ((ox !== 0 || oy !== 0) && dist(p, px(s, v.x + ox, v.y + oy)) <= handleHitRadius) return { kind: "tangent", index: sel, side };
        }
      }
    }
    for (let i = mp.vertices.length - 1; i >= 0; i--) {
      const v = mp.vertices[i];
      if (v && dist(p, px(s, v.x, v.y)) <= vertexHitRadius) return { kind: "vertex", index: i };
    }
    const fh = featherHandle(s, maskFeatherAt(m, offset()), mp);
    if (fh && dist(p, rectToOverlay(s, fh)) <= handleHitRadius) return { kind: "feather" };
    const local = overlayToLocal(s, p);
    const near = nearestOnPath(mp, local);
    if (near) {
      // Distance in overlay pixels: scale local units by the rect size (nearest-point is measured in local space).
      const onPath = bezierPoint(segmentAt(mp, near.segment), near.t);
      if (dist(p, px(s, onPath.x, onPath.y)) <= segmentHitRadius) return { kind: "segment", segment: near.segment, t: near.t };
    }
    return mp.closed && pathContains(mp, local) ? { kind: "inside" } : null;
  };

  // MARK: Edit sessions

  /** One gesture that rewrites the selected mask's path from the pointer delta in local space. */
  const pathSession = (start: Point, compute: (startLocal: Point, nowLocal: Point) => MaskPath, applied?: MaskPath): DragSession | null => {
    const c = clip(), m = mask();
    if (!c || !m) return null;
    const startLocal = toLocal(start);
    let moved = applied !== undefined;
    if (applied) applyMask(editor, c.id, m.id, { path: applied });
    return {
      move(p) {
        moved = true;
        applyMask(editor, c.id, m.id, { path: compute(startLocal, toLocal(p)) });
      },
      commit(p) {
        if (moved) commitMask(editor, c.id, m.id, { path: compute(startLocal, toLocal(p)) }, "Edit Mask Path");
      },
      cancel() {
        if (moved) cancelMask(editor, c.id);
      },
    };
  };

  const featherSession = (): DragSession | null => {
    const c = clip(), m = mask(), s = space(), mp = path();
    if (!c || !m || !s || !mp) return null;
    const base = featherHandle(s, 0, mp);
    if (!base) return null;
    const dir = s.flipH ? -1 : 1;
    let moved = false;
    const featherAt = (p: Point): number => {
      // Pointer in unrotated rect pixels.
      const local = overlayToLocal(s, p);
      const q = localToRect(s, local.x, local.y);
      return Math.max(0, (dir * (q.x - base.x)) / pxPerTimelinePx());
    };
    return {
      move(p) {
        moved = true;
        applyMask(editor, c.id, m.id, { feather: featherAt(p) });
      },
      commit(p) {
        if (moved) commitMask(editor, c.id, m.id, { feather: featherAt(p) }, "Change Mask Feather");
      },
      cancel() {
        if (moved) cancelMask(editor, c.id);
      },
    };
  };

  // MARK: Drawing tools

  const finishPen = (closed: boolean): void => {
    const c = clip();
    const draft = penPoints();
    if (!c || draft.vertices.length < 3 || !closed) return;
    setPenPoints(makeMaskPath([], false));
    editor.ui.maskTool = null;
    addMask(editor, c.id, "path", { path: setClosed(draft, true) });
  };

  const penSession = (start: Point): DragSession => {
    const startLocal = toLocal(start);
    const before = penPoints();
    const index = before.vertices.length;
    setPenPoints({ closed: false, vertices: [...before.vertices, makeMaskVertex(startLocal.x, startLocal.y)] });
    const apply = (p: Point): void => {
      const now = toLocal(p);
      const s = space();
      // Treat tiny drags as clicks so corner points stay corners.
      if (s && dist(p, px(s, startLocal.x, startLocal.y)) < 3) return;
      const out = { x: now.x - startLocal.x, y: now.y - startLocal.y };
      setPenPoints((cur) => ({
        closed: false,
        vertices: cur.vertices.map((v, i) => (i === index ? { ...v, outX: out.x, outY: out.y, inX: -out.x, inY: -out.y } : v)),
      }));
    };
    return { move: apply, commit: apply, cancel: () => setPenPoints(before) };
  };

  const shapeSession = (shape: Exclude<MaskShape, "path">, start: Point): DragSession => {
    const a = toLocal(start);
    const rectFor = (p: Point) => rectBetween(a, toLocal(p));
    return {
      move(p) {
        setDraftRect({ a, b: toLocal(p) });
      },
      commit(p) {
        setDraftRect(null);
        const r = rectFor(p);
        const c = clip();
        if (!c || r.x1 - r.x0 < minDrawnFraction || r.y1 - r.y0 < minDrawnFraction) return;
        editor.ui.maskTool = null;
        addMask(editor, c.id, shape, {
          path: shape === "rectangle"
            ? makeRectanglePath(r.x0, r.y0, r.x1, r.y1)
            : makeEllipsePath((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2),
        });
      },
      cancel: () => setDraftRect(null),
    };
  };

  // MARK: Pointer handling

  const onPointerDown = (e: PointerEvent): void => {
    const s = space(), c = clip();
    if (e.button !== 0 || drag.active || !s || !c) return;
    if (editor.ui.isPlaying) editor.ui.isPlaying = false;
    const p = drag.toLocal(e);
    const tool = editor.ui.maskTool;
    let session: DragSession | null = null;

    if (tool === "pen") {
      const draft = penPoints();
      const first = draft.vertices[0];
      if (draft.vertices.length >= 3 && first && dist(p, px(s, first.x, first.y)) <= vertexHitRadius) {
        e.preventDefault();
        finishPen(true);
        return;
      }
      session = penSession(p);
    } else if (tool === "rectangle" || tool === "ellipse") {
      session = shapeSession(tool, p);
    } else {
      const mp = path();
      const m = mask();
      const hit = hitAt(p);
      if (!hit || !mp || !m) {
        editor.ui.selectedMaskId = null;
        return;
      }
      switch (hit.kind) {
        case "vertex": {
          setSelectedVertex(hit.index);
          const idx = hit.index;
          // Alt on a vertex pulls a smooth tangent out of it; a plain drag moves the vertex.
          session = e.altKey
            ? pathSession(p, (_a, now) => setTangent(mp, idx, "out", now, false))
            : pathSession(p, (a, now) => moveVertex(mp, idx, now.x - a.x, now.y - a.y));
          break;
        }
        case "tangent": {
          const { index, side } = hit;
          const broken = e.altKey;
          session = pathSession(p, (_a, now) => setTangent(mp, index, side, now, broken));
          break;
        }
        case "feather":
          session = featherSession();
          break;
        case "segment": {
          const inserted = insertVertex(mp, hit.segment, hit.t);
          const idx = hit.segment + 1;
          setSelectedVertex(idx);
          session = pathSession(p, (a, now) => moveVertex(inserted, idx, now.x - a.x, now.y - a.y), inserted);
          break;
        }
        case "inside":
          setSelectedVertex(null);
          session = pathSession(p, (a, now) => movePath(mp, now.x - a.x, now.y - a.y));
          break;
      }
    }
    if (!session) return;
    e.preventDefault();
    drag.start(e, session);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag.move(e)) return;
    if (editor.ui.maskTool) {
      setCursor("crosshair");
      return;
    }
    const hit = hitAt(drag.toLocal(e));
    setCursor(!hit ? "default" : hit.kind === "inside" ? "move" : hit.kind === "segment" ? "copy" : "pointer");
  };

  // Delete / Enter / Escape act on the mask being edited before the timeline's own shortcuts see them.
  const onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const c = clip(), m = mask(), mp = path();
    if (editor.ui.maskTool === "pen" && penPoints().vertices.length > 0 && !drag.active) {
      if (e.key === "Enter") finishPen(true);
      else if (e.key === "Escape") setPenPoints(makeMaskPath([], false));
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && editor.ui.maskTool !== null) {
      editor.ui.maskTool = null;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((e.key !== "Delete" && e.key !== "Backspace") || !c || !m || !mp) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = selectedVertex();
    if (sel !== null && mp.vertices.length > (mp.closed ? 3 : 1)) {
      setSelectedVertex(null);
      commitMask(editor, c.id, m.id, { path: removeVertex(mp, sel) }, "Delete Vertex");
    } else {
      removeMask(editor, c.id, m.id);
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // MARK: Rendering

  const draftShapePath = (s: MaskSpace): string => {
    const d = draftRect();
    const tool = editor.ui.maskTool;
    if (!d || (tool !== "rectangle" && tool !== "ellipse")) return "";
    const r = rectBetween(d.a, d.b);
    return outline(s, tool === "rectangle"
      ? makeRectanglePath(r.x0, r.y0, r.x1, r.y1)
      : makeEllipsePath((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2));
  };
  const rotation = (s: MaskSpace): string => `rotate(${s.rotation} ${s.cx} ${s.cy})`;

  return (
    <div
      class="ov-surface"
      ref={surface}
      style={{ cursor: cursor() }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => drag.end(e)}
      onPointerCancel={() => drag.cancel()}
    >
      <svg class="ov-svg" width={props.size.width} height={props.size.height}>
        <Show when={space()}>
          {(s) => (
            <>
              <g transform={rotation(s())}>
                <rect class="ov-outline" x={s().rect.x} y={s().rect.y} width={s().rect.width} height={s().rect.height} />
                <Show when={path()}>{(p) => <path class="ov-mask-path" d={outline(s(), p())} />}</Show>
                <Show when={draftShapePath(s())}>{(d) => <path class="ov-mask-path draft" d={d()} />}</Show>
                <Show when={editor.ui.maskTool === "pen" && penPoints().vertices.length > 0}>
                  <path class="ov-mask-path draft" d={outline(s(), penPoints())} />
                </Show>
                <Show when={mask() && path()}>
                  {(_) => (
                    <Show when={featherHandle(s(), maskFeatherAt(mask() as Mask, offset()), path() as MaskPath)}>
                      {(h) => (
                        <>
                          <line class="ov-mask-stem" x1={h().x - maskFeatherAt(mask() as Mask, offset()) * pxPerTimelinePx() - featherBaseOffset}
                            y1={h().y} x2={h().x} y2={h().y} />
                          <rect class="ov-mask-feather" x={h().x - 4} y={h().y - 4} width={8} height={8}
                            transform={`rotate(45 ${h().x} ${h().y})`} />
                        </>
                      )}
                    </Show>
                  )}
                </Show>
              </g>
              <Show when={path()}>
                {(p) => (
                  <>
                    <Show when={selectedVertex() !== null ? p().vertices[selectedVertex() as number] : undefined}>
                      {(v) => (
                        <For each={["in", "out"] as const}>
                          {(side) => {
                            const ox = (): number => (side === "in" ? v().inX : v().outX);
                            const oy = (): number => (side === "in" ? v().inY : v().outY);
                            return (
                              <Show when={ox() !== 0 || oy() !== 0}>
                                <line class="ov-mask-stem" x1={px(s(), v().x, v().y).x} y1={px(s(), v().x, v().y).y}
                                  x2={px(s(), v().x + ox(), v().y + oy()).x} y2={px(s(), v().x + ox(), v().y + oy()).y} />
                                <circle class="ov-mask-tangent" cx={px(s(), v().x + ox(), v().y + oy()).x} cy={px(s(), v().x + ox(), v().y + oy()).y} r={4} />
                              </Show>
                            );
                          }}
                        </For>
                      )}
                    </Show>
                    <For each={p().vertices}>
                      {(v, i) => (
                        <rect class="ov-mask-vertex" classList={{ selected: selectedVertex() === i() }}
                          x={px(s(), v.x, v.y).x - 4} y={px(s(), v.x, v.y).y - 4} width={8} height={8} />
                      )}
                    </For>
                  </>
                )}
              </Show>
              <For each={editor.ui.maskTool === "pen" ? penPoints().vertices : []}>
                {(v, i) => (
                  <circle class="ov-mask-vertex" classList={{ selected: i() === 0 }} cx={px(s(), v.x, v.y).x} cy={px(s(), v.x, v.y).y} r={i() === 0 ? 5 : 3.5} />
                )}
              </For>
            </>
          )}
        </Show>
      </svg>
    </div>
  );
}
