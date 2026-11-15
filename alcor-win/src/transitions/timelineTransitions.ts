import { transitionAlignments, transitionAlignmentLabels, transitionKindLabels, transitionKinds, type Clip, type Rect, type Track, type Transition } from "../model";
import type { Gesture } from "../editor/document";
import type { Editor } from "../editor/editor";
import {
  addTransition, findTransition, removeTransition, timelineCuts, updateTransition, type Cut, type TransitionSpec,
} from "../editor/mutations/transitions";
import type { TimelineInputController, TimelinePointer } from "../timeline/view/inputController";
import type { TimelineRenderInput } from "../timeline/view/timelineRenderer";
import { css } from "../timeline/view/canvasPalette";
import { frameAt, trackAt, trackHeightAt, trackYAt, xForFrame, type TimelineGeometry } from "../timeline/timelineGeometry";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { transitionSpan } from "./transitionMath";

/** Alcor extension. The bar drawn over a cut, its hit testing, edge dragging, menus and library drops. */

const minBarWidth = 10;
const edgeHitSlop = 5;
const cutHitSlop = 8;
const libraryDropSlop = 28;
export const transitionDragScheme = "alcor-transition://";

export function transitionDragString(kind: string): string {
  return transitionDragScheme + kind;
}

export function transitionKindsFromPayload(payload: string): string[] {
  return payload.split("\n").filter((l) => l.startsWith(transitionDragScheme)).map((l) => l.slice(transitionDragScheme.length));
}

function clipIn(track: Track, id: string): Clip | undefined {
  for (const c of track.clips) if (c.id === id) return c;
  return undefined;
}

/** The bar's rectangle in document space; undefined when its clips are missing. */
export function transitionRect(geo: TimelineGeometry, track: Track, trackIndex: number, t: Transition): Rect | undefined {
  const to = clipIn(track, t.toClipId);
  if (!to) return undefined;
  const span = transitionSpan(to.startFrame, t.durationFrames, t.alignment);
  const x0 = xForFrame(geo, span.start);
  const x1 = xForFrame(geo, span.end);
  const width = Math.max(minBarWidth, x1 - x0);
  const rowTop = trackYAt(geo, trackIndex);
  const rowHeight = trackHeightAt(geo, trackIndex);
  const height = Math.min(Math.max(10, rowHeight * 0.45), 24);
  return { x: x0 - (width - (x1 - x0)) / 2, y: rowTop + (rowHeight - height) / 2, width, height };
}

/** Draws the transition bars of every visible track (called after the clips). */
export function drawTransitions(ctx: CanvasRenderingContext2D, r: TimelineRenderInput): void {
  const { editor, geometry: geo, palette } = r;
  const tracks = editor.timeline.tracks;
  const selected = editor.ui.selectedTransitionId;
  const viewTop = r.scrollY, viewBottom = r.scrollY + r.height;
  const viewLeft = r.scrollX, viewRight = r.scrollX + r.width;
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti] as Track;
    if (!track.transitions) continue;
    const top = trackYAt(geo, ti);
    if (top > viewBottom || top + trackHeightAt(geo, ti) < viewTop) continue;
    for (const t of track.transitions) {
      const rect = transitionRect(geo, track, ti, t);
      if (!rect || rect.x > viewRight || rect.x + rect.width < viewLeft) continue;
      const isSelected = t.id === selected;
      ctx.fillStyle = css(isSelected ? palette.yellow : palette.textPrimary, isSelected ? 0.5 : 0.3);
      ctx.strokeStyle = css(isSelected ? palette.yellow : palette.textPrimary, isSelected ? 1 : 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1, 3);
      ctx.fill();
      ctx.stroke();
      // Diagonal: the outgoing clip fading into the incoming one.
      ctx.beginPath();
      ctx.moveTo(rect.x + 2, rect.y + rect.height - 2);
      ctx.lineTo(rect.x + rect.width - 2, rect.y + 2);
      ctx.stroke();
      if (rect.width >= 70 && rect.height >= 14) {
        ctx.font = `600 9px ${palette.fontUI}`;
        ctx.fillStyle = css(palette.textPrimary);
        ctx.textBaseline = "middle";
        ctx.fillText(transitionKindLabels[t.kind], rect.x + 6, rect.y + rect.height / 2, rect.width - 12);
      }
    }
  }
}

export interface TransitionHit {
  transitionId: string;
  trackIndex: number;
  part: "left" | "right" | "body";
  rect: Rect;
}

/** Topmost transition bar under a document-space point. */
export function transitionHitAt(editor: Editor, geo: TimelineGeometry, point: { x: number; y: number }): TransitionHit | undefined {
  const trackIndex = trackAt(geo, point.y);
  const track = editor.timeline.tracks[trackIndex];
  if (!track?.transitions) return undefined;
  for (const t of track.transitions) {
    const rect = transitionRect(geo, track, trackIndex, t);
    if (!rect) continue;
    if (point.x < rect.x - edgeHitSlop || point.x > rect.x + rect.width + edgeHitSlop) continue;
    if (point.y < rect.y - 2 || point.y > rect.y + rect.height + 2) continue;
    const slop = rect.width > 3 * edgeHitSlop ? edgeHitSlop : 0;
    const part = slop > 0 && point.x <= rect.x + slop ? "left" : slop > 0 && point.x >= rect.x + rect.width - slop ? "right" : "body";
    return { transitionId: t.id, trackIndex, part, rect };
  }
  return undefined;
}

/** The transition-less or transitioned cut within `slop` px of a document-space point, on one track or any. */
function cutNear(editor: Editor, geo: TimelineGeometry, point: { x: number; y: number }, slop: number, onlyTrack?: number): Cut | undefined {
  let best: Cut | undefined;
  let bestDistance = slop + 1;
  for (const cut of timelineCuts(editor)) {
    if (onlyTrack !== undefined && cut.trackIndex !== onlyTrack) continue;
    const d = Math.abs(xForFrame(geo, cut.frame) - point.x);
    if (d < bestDistance) {
      best = cut;
      bestDistance = d;
    }
  }
  return best;
}

function select(editor: Editor, id: string): void {
  editor.ui.selectedClipIds = new Set();
  editor.ui.selectedGap = null;
  editor.ui.selectedTransitionId = id;
}

/** Duration after dragging an edge by `delta` frames; undefined when that edge is pinned to the cut. */
export function draggedDuration(alignment: Transition["alignment"], edge: "left" | "right", startDuration: number, delta: number): number | undefined {
  if (edge === "right") {
    if (alignment === "end") return undefined;
    return startDuration + (alignment === "center" ? 2 * delta : delta);
  }
  if (alignment === "start") return undefined;
  return startDuration - (alignment === "center" ? 2 * delta : delta);
}

function kindMenu(onPick: (kind: (typeof transitionKinds)[number]) => void, current?: string): ContextMenuItem[] {
  return transitionKinds.map((kind) => ({
    kind: "item" as const, label: transitionKindLabels[kind], onSelect: () => onPick(kind), checked: current === kind,
  }));
}

/** Pointer, hover and menu handling for transition bars; the canvas asks it first and falls through when it declines. */
export class TransitionInteraction {
  private drag: { id: string; edge: "left" | "right"; startFrame: number; startDuration: number; gesture: Gesture } | undefined;

  constructor(private readonly controller: TimelineInputController) {}

  private get editor(): Editor {
    return this.controller.editor;
  }

  private docPoint(p: TimelinePointer): { x: number; y: number } {
    const host = this.controller.host;
    return { x: p.x + host.scrollX(), y: p.y + host.scrollY() };
  }

  get dragging(): boolean {
    return this.drag !== undefined;
  }

  /** True when the press landed on a transition bar (selected, and dragged if on an edge). */
  pointerDown(p: TimelinePointer): boolean {
    const editor = this.editor;
    const geo = this.controller.host.geometry();
    const point = this.docPoint(p);
    const hit = p.y >= 0 ? transitionHitAt(editor, geo, point) : undefined;
    if (!hit) {
      if (editor.ui.selectedTransitionId !== null) editor.ui.selectedTransitionId = null;
      return false;
    }
    select(editor, hit.transitionId);
    const found = findTransition(editor, hit.transitionId);
    if (found && hit.part !== "body") {
      this.drag = {
        id: hit.transitionId,
        edge: hit.part,
        startFrame: frameAt(geo, point.x),
        startDuration: found.transition.durationFrames,
        gesture: editor.beginGesture("Change Transition Duration"),
      };
    }
    this.controller.host.invalidate();
    return true;
  }

  pointerDrag(p: TimelinePointer): void {
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    const found = findTransition(editor, d.id);
    if (!found) return;
    const frame = frameAt(this.controller.host.geometry(), this.docPoint(p).x);
    const duration = draggedDuration(found.transition.alignment, d.edge, d.startDuration, frame - d.startFrame);
    if (duration === undefined || duration === found.transition.durationFrames) return;
    updateTransition(editor, d.id, { durationFrames: duration });
    this.controller.host.invalidate();
  }

  pointerUp(): void {
    const d = this.drag;
    this.drag = undefined;
    d?.gesture.commit();
  }

  cancel(): void {
    const d = this.drag;
    this.drag = undefined;
    d?.gesture.cancel();
  }

  /** Sets the resize cursor over a bar edge; true when the pointer is over a transition. */
  hover(p: TimelinePointer): boolean {
    if (this.drag) return true;
    if (p.y < 0) return false;
    const hit = transitionHitAt(this.editor, this.controller.host.geometry(), this.docPoint(p));
    if (!hit) return false;
    this.controller.host.setCursor(hit.part === "body" ? "pointer" : "ew-resize");
    return true;
  }

  /** Right-click on a bar (change / remove) or on a cut (add). */
  contextMenu(p: TimelinePointer): ContextMenuItem[] | undefined {
    const editor = this.editor;
    const geo = this.controller.host.geometry();
    const point = this.docPoint(p);
    const hit = transitionHitAt(editor, geo, point);
    if (hit) {
      select(editor, hit.transitionId);
      this.controller.host.invalidate();
      const t = findTransition(editor, hit.transitionId)?.transition;
      if (!t) return undefined;
      return [
        { kind: "item", label: "Type", submenu: kindMenu((kind) => updateTransition(editor, t.id, { kind }), t.kind) },
        {
          kind: "item", label: "Alignment",
          submenu: transitionAlignments.map((alignment) => ({
            kind: "item" as const, label: transitionAlignmentLabels[alignment], checked: t.alignment === alignment,
            onSelect: () => updateTransition(editor, t.id, { alignment }),
          })),
        },
        { kind: "divider" },
        { kind: "item", label: "Remove Transition", destructive: true, onSelect: () => removeTransition(editor, t.id) },
      ];
    }
    const trackIndex = trackAt(geo, point.y);
    const cut = cutNear(editor, geo, point, cutHitSlop, trackIndex);
    if (!cut || cut.transition) return undefined;
    const add = (spec: TransitionSpec) => {
      const result = addTransition(editor, cut.from.id, cut.to.id, spec);
      if (!result.ok) editor.refuseWithToast(result.reason);
      this.controller.host.invalidate();
    };
    return [
      { kind: "item", label: "Add Transition", onSelect: () => add({}) },
      { kind: "item", label: "Add Transition As", submenu: kindMenu((kind) => add({ kind })) },
    ];
  }

  /** A transition dragged from the Library onto the timeline: applies it to the cut under the pointer. Returns whether the payload was one. */
  dropLibraryPayload(payload: string, p: TimelinePointer): boolean {
    const kinds = transitionKindsFromPayload(payload);
    if (kinds.length === 0) return false;
    const kind = transitionKinds.find((k) => k === kinds[0]);
    if (!kind) return true;
    const editor = this.editor;
    const geo = this.controller.host.geometry();
    const point = this.docPoint(p);
    const row = trackAt(geo, point.y);
    const cut = cutNear(editor, geo, point, libraryDropSlop, row) ?? cutNear(editor, geo, point, libraryDropSlop);
    if (!cut) {
      editor.refuseWithToast("Drop the transition on a cut between two clips.");
      return true;
    }
    if (cut.transition) {
      updateTransition(editor, cut.transition.id, { kind });
      select(editor, cut.transition.id);
    } else {
      const result = addTransition(editor, cut.from.id, cut.to.id, { kind });
      if (!result.ok) editor.refuseWithToast(result.reason);
    }
    this.controller.host.invalidate();
    return true;
  }
}
