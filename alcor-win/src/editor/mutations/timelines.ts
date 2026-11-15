// Port of EditorViewModel+Timelines: switching and CRUD of timelines (the parts the media panel drives).
// Not ported: video-engine composition eviction, agent activity, in-flight drag revert, tab-bar override state.
import {
  clipFreshenIds, makeTimeline, makeTimelineViewState, timelineTotalFrames, type Timeline, type TimelineViewState,
} from "../../model";
import { newId } from "../../util/id";
import { snapshot } from "../../util/snapshot";
import type { Editor } from "../editor";

export const cannotDeleteLastTimelineMessage = "Can't delete every timeline — the project needs at least one.";

export function timelineFor(editor: Editor, id: string): Timeline | undefined {
  return editor.doc.timelines.find((t) => t.id === id);
}

/** Fresh track/clip/group/marker ids for a duplicated timeline so ids stay unique project-wide. */
export function timelineRegenerateIds(timeline: Timeline): void {
  const groups = new Map<string, string>();
  for (const track of timeline.tracks) {
    track.id = newId();
    for (const clip of track.clips) clipFreshenIds(clip, groups);
  }
  for (const marker of timeline.markers) marker.id = newId();
}

export function viewStateFor(editor: Editor, id: string): TimelineViewState {
  return editor.liveViewStates[id] ?? makeTimelineViewState();
}

export function stashActiveViewState(editor: Editor): void {
  editor.liveViewStates[editor.doc.activeTimelineId] = makeTimelineViewState({
    playheadFrame: editor.ui.currentFrame,
    zoomScale: editor.ui.zoomScale,
    scrollOffsetX: editor.ui.timelineScrollOffsetX,
  });
}

function restoreActiveViewState(editor: Editor): void {
  const vs = viewStateFor(editor, editor.doc.activeTimelineId);
  editor.ui.zoomScale = vs.zoomScale;
  editor.ui.currentFrame = Math.min(Math.max(0, vs.playheadFrame), Math.max(0, timelineTotalFrames(editor.timeline)));
}

function clearTimelineScopedState(editor: Editor): void {
  const ui = editor.ui;
  ui.selectedClipIds = new Set();
  ui.selectedGap = null;
  ui.selectedTimelineRange = null;
  ui.selectedTimelineMarkerIds = new Set();
  ui.timelineMarkerPreview = null;
  ui.pendingSwapClipId = null;
}

/** Makes `id` the active timeline and opens its tab. Not an undo step on its own; joins an enclosing `perform`. */
export function activateTimeline(editor: Editor, id: string): void {
  if (id === editor.doc.activeTimelineId || !timelineFor(editor, id)) return;
  stashActiveViewState(editor);
  editor.ui.isPlaying = false;
  clearTimelineScopedState(editor);
  editor.withoutRegistration(() => {
    editor.doc.activeTimelineId = id;
    if (!editor.doc.openTimelineIds.includes(id)) editor.doc.openTimelineIds.push(id);
  });
  restoreActiveViewState(editor);
}

export function uniqueName(editor: Editor, candidate: (n: number) => string, start: number): string {
  const used = new Set(editor.doc.timelines.map((t) => t.name));
  let n = start;
  while (used.has(candidate(n))) n += 1;
  return candidate(n);
}

export function nextTimelineName(editor: Editor): string {
  return uniqueName(editor, (n) => `Timeline ${n}`, editor.doc.timelines.length + 1);
}

function duplicateName(editor: Editor, name: string): string {
  return uniqueName(editor, (n) => (n === 1 ? `${name} copy` : `${name} copy ${n}`), 1);
}

/** Undoable ("New Timeline"): inherits the active timeline's frame rate and canvas. Returns the new id. */
export function createTimeline(editor: Editor, name?: string, activate = true): string {
  const active = snapshot(editor.timeline);
  const created = makeTimeline({
    name: name ?? nextTimelineName(editor),
    fps: active.fps,
    width: active.width,
    height: active.height,
    settingsConfigured: active.settingsConfigured,
  });
  editor.perform("New Timeline", () => {
    editor.doc.timelines.push(created);
    if (activate) activateTimeline(editor, created.id);
  });
  return created.id;
}

/** Undoable ("Duplicate Timeline"): deep copy with fresh ids, placed in the same folder. Undefined for unknown ids. */
export function duplicateTimeline(editor: Editor, id: string, activate = true): string | undefined {
  const source = timelineFor(editor, id);
  if (!source) return undefined;
  const copy = structuredClone(snapshot(source));
  copy.id = newId();
  copy.name = duplicateName(editor, copy.name);
  timelineRegenerateIds(copy);
  stashActiveViewState(editor);
  editor.liveViewStates[copy.id] = { ...viewStateFor(editor, id) };
  editor.perform("Duplicate Timeline", () => {
    editor.doc.timelines.push(copy);
    if (activate) activateTimeline(editor, copy.id);
  });
  return copy.id;
}

/** Undoable ("Rename Timeline"); blank or unchanged names do nothing. */
export function renameTimeline(editor: Editor, id: string, name: string): void {
  const trimmed = name.trim();
  const existing = timelineFor(editor, id);
  if (!existing || trimmed === "" || existing.name === trimmed) return;
  editor.perform("Rename Timeline", () => {
    const target = timelineFor(editor, id);
    if (target) target.name = trimmed;
  });
}

/** Undoable ("Delete Timeline"). The last remaining timeline is refused with a toast. */
export function deleteTimeline(editor: Editor, id: string): void {
  if (!timelineFor(editor, id)) return;
  if (editor.doc.timelines.length <= 1) {
    editor.refuseWithToast(cannotDeleteLastTimelineMessage);
    return;
  }
  editor.perform("Delete Timeline", () => {
    const doc = editor.doc;
    if (doc.activeTimelineId === id) {
      const fallback = doc.openTimelineIds.find((open) => open !== id) ?? doc.timelines.find((t) => t.id !== id)?.id;
      if (fallback !== undefined) activateTimeline(editor, fallback);
    }
    doc.timelines = doc.timelines.filter((t) => t.id !== id);
    doc.openTimelineIds = doc.openTimelineIds.filter((open) => open !== id);
  });
  delete editor.liveViewStates[id];
  editor.ui.selectedTimelineIds = new Set([...editor.ui.selectedTimelineIds].filter((t) => t !== id));
}
