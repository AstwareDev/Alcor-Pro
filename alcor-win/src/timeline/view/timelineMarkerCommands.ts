import {
  makeTimelineMarker,
  timelineMarkerEndFrame,
  timelineMarkerIsRange,
  timelineMarkerMaximumCommentLength,
  timelineMarkerMaximumNameLength,
  type TimelineMarker,
  type TimelineMarkerValidationError,
} from "../../model";
import type { Editor } from "../../editor/editor";
import { deepEqual } from "../../editor/mutations/core";
import { validSelectedTimelineRange } from "../../editor/mutations/timelineRange";

// Port of EditorViewModel+TimelineMarkers.swift. Lives here until src/editor/mutations gains a markers module.

export class TimelineMarkerChangeError extends Error {
  constructor(readonly reason: TimelineMarkerValidationError) {
    super(reason);
  }
}

export interface TimelineMarkerChangeReceipt {
  created: TimelineMarker[];
  updated: TimelineMarker[];
  deletedIds: string[];
}

export function timelineMarker(editor: Editor, id: string): TimelineMarker | undefined {
  return editor.timeline.markers.find((m) => m.id === id);
}

function compareMarkers(a: TimelineMarker, b: TimelineMarker): number {
  if (a.startFrame !== b.startFrame) return a.startFrame - b.startFrame;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function displayedTimelineMarkers(editor: Editor, preview: TimelineMarker | null = null): TimelineMarker[] {
  return editor.timeline.markers.map((m) => (preview && m.id === preview.id ? preview : m)).sort(compareMarkers);
}

export function timelineMarkerSnapFrames(editor: Editor, excludingMarkerIds: ReadonlySet<string> = new Set()): number[] {
  const frames = new Set<number>();
  for (const m of displayedTimelineMarkers(editor)) {
    if (excludingMarkerIds.has(m.id)) continue;
    frames.add(m.startFrame);
    if (timelineMarkerIsRange(m)) frames.add(timelineMarkerEndFrame(m));
  }
  return [...frames].sort((a, b) => a - b);
}

/** Called with the new marker id so the view can open the marker editor (`onPresentTimelineMarkerEditor`). */
export type PresentMarkerEditor = (id: string) => void;

export function addTimelineMarkerAtSelection(editor: Editor, present?: PresentMarkerEditor): TimelineMarker | undefined {
  const range = validSelectedTimelineRange(editor);
  const marker = makeTimelineMarker({
    name: nextMarkerName(editor),
    startFrame: range?.startFrame ?? editor.ui.currentFrame,
    durationFrames: range ? range.endFrame - range.startFrame : 0,
  });
  let created: TimelineMarker | undefined;
  try {
    created = changeTimelineMarkers(editor, { creates: [marker], actionName: "Add Marker" }).created[0];
  } catch {
    editor.refuseWithToast("Couldn't add marker.");
    return undefined;
  }
  editor.ui.selectedTimelineMarkerIds = new Set(created ? [created.id] : []);
  editor.ui.selectedClipIds = new Set();
  editor.ui.selectedGap = null;
  editor.ui.selectedTimelineRange = null;
  if (created) present?.(created.id);
  return created;
}

function nextMarkerName(editor: Editor): string {
  const names = new Set(editor.timeline.markers.map((m) => m.name));
  let number = 1;
  while (names.has(`Marker ${number}`)) number += 1;
  return `Marker ${number}`;
}

/** Validates everything first; throws `TimelineMarkerChangeError` without mutating. One undo entry. */
export function changeTimelineMarkers(
  editor: Editor,
  p: { creates?: TimelineMarker[]; updates?: TimelineMarker[]; deleteIds?: string[]; actionName: string },
): TimelineMarkerChangeReceipt {
  const creates = p.creates ?? [];
  const updates = p.updates ?? [];
  const deleteIds = p.deleteIds ?? [];
  const deleteSet = new Set(deleteIds);
  const affectedIds = new Set([...deleteSet, ...updates.map((m) => m.id)]);
  if (deleteSet.size !== deleteIds.length) throw new TimelineMarkerChangeError("invalidRange");
  const before = editor.timeline.markers;
  const next = before.map((m) => structuredClone(m));
  const existingIds = new Set(next.map((m) => m.id));
  for (const id of deleteSet) if (!existingIds.has(id)) throw new TimelineMarkerChangeError("invalidRange");

  const updated: TimelineMarker[] = [];
  for (const marker of updates.map(validatedTimelineMarker)) {
    if (deleteSet.has(marker.id)) throw new TimelineMarkerChangeError("invalidRange");
    const index = next.findIndex((m) => m.id === marker.id);
    if (index < 0) throw new TimelineMarkerChangeError("invalidRange");
    if (!deepEqual(marker, next[index])) {
      next[index] = marker;
      updated.push(marker);
    }
  }
  const created = creates.map(validatedTimelineMarker);
  const result = next.filter((m) => !deleteSet.has(m.id)).concat(created).sort(compareMarkers);

  const preview = editor.ui.timelineMarkerPreview;
  if (preview && affectedIds.has(preview.id)) editor.ui.timelineMarkerPreview = null;
  if (deepEqual(result, before)) return { created: [], updated: [], deletedIds: [] };
  editor.perform(p.actionName, () => {
    editor.timeline.markers = result;
  });
  if (deleteSet.size > 0) {
    editor.ui.selectedTimelineMarkerIds = new Set([...editor.ui.selectedTimelineMarkerIds].filter((id) => !deleteSet.has(id)));
  }
  return { created, updated, deletedIds: deleteIds };
}

export function deleteSelectedTimelineMarker(editor: Editor): void {
  const ids = editor.ui.selectedTimelineMarkerIds;
  if (ids.size === 0) return;
  try {
    changeTimelineMarkers(editor, { deleteIds: [...ids], actionName: ids.size === 1 ? "Delete Marker" : "Delete Markers" });
  } catch {
    editor.refuseWithToast("Couldn't delete marker.");
  }
}

function hasControlCharacters(s: string): boolean {
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(s);
}

function validatedTimelineMarker(marker: TimelineMarker): TimelineMarker {
  const name = marker.name.trim();
  if (name === "" || Array.from(name).length > timelineMarkerMaximumNameLength || hasControlCharacters(name)) {
    throw new TimelineMarkerChangeError("invalidName");
  }
  if (Array.from(marker.comment).length > timelineMarkerMaximumCommentLength) throw new TimelineMarkerChangeError("invalidComment");
  const end = marker.startFrame + marker.durationFrames;
  const c = marker.color;
  const components = [c.r, c.g, c.b, c.a];
  if (
    !(marker.startFrame >= 0) ||
    !(marker.durationFrames >= 0) ||
    !Number.isSafeInteger(end) ||
    !components.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  ) {
    throw new TimelineMarkerChangeError("invalidRange");
  }
  return { ...structuredClone(marker), name };
}
