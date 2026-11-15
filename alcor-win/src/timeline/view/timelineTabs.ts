import { createSignal, type Signal } from "solid-js";
import type { Editor } from "../../editor/editor";
import { activateTimeline } from "../../editor/mutations/timelines";

// Tab-strip parts of EditorViewModel+Timelines.swift that src/editor/mutations/timelines.ts does not cover:
// closing/opening tabs, adjacent-tab navigation and the tab bar expansion override. None of these are undoable.

const tabBarOverrides = new WeakMap<Editor, Signal<boolean | undefined>>();

function tabBarOverride(editor: Editor): Signal<boolean | undefined> {
  let signal = tabBarOverrides.get(editor);
  if (!signal) {
    signal = createSignal<boolean | undefined>(undefined);
    tabBarOverrides.set(editor, signal);
  }
  return signal;
}

/** `isTimelineTabBarExpanded`: the user's choice, else shown once there is more than one timeline. */
export function isTimelineTabBarExpanded(editor: Editor): boolean {
  return tabBarOverride(editor)[0]() ?? editor.doc.timelines.length > 1;
}

export function toggleTimelineTabBarExpanded(editor: Editor): void {
  tabBarOverride(editor)[1](!isTimelineTabBarExpanded(editor));
}

export function revealTimelineTabBarIfMultiple(editor: Editor): void {
  if (editor.doc.timelines.length <= 1) return;
  tabBarOverride(editor)[1](true);
}

export function resetTimelineTabBarOverride(editor: Editor): void {
  tabBarOverride(editor)[1](undefined);
}

export function adjacentId(ids: readonly string[], current: string, delta: number): string | undefined {
  const index = ids.indexOf(current);
  if (ids.length <= 1 || index < 0) return undefined;
  const count = ids.length;
  return ids[(((index + delta) % count) + count) % count];
}

export function selectAdjacentOpenTimeline(editor: Editor, delta: number): boolean {
  const id = adjacentId(editor.doc.openTimelineIds, editor.doc.activeTimelineId, delta);
  if (id === undefined) return false;
  activateTimeline(editor, id);
  revealTimelineTabBarIfMultiple(editor);
  return true;
}

/** Closing a tab never deletes the timeline; the last open tab cannot close. */
export function closeTimelineTab(editor: Editor, id: string): void {
  const open = editor.doc.openTimelineIds;
  const index = open.indexOf(id);
  if (open.length <= 1 || index < 0) return;
  if (editor.doc.activeTimelineId === id) activateTimeline(editor, open[index === 0 ? 1 : index - 1] as string);
  editor.withoutRegistration(() => {
    editor.doc.openTimelineIds = editor.doc.openTimelineIds.filter((o) => o !== id);
  });
}

export function closeOtherTimelineTabs(editor: Editor, id: string): void {
  if (!editor.doc.openTimelineIds.includes(id)) return;
  activateTimeline(editor, id);
  if (editor.doc.openTimelineIds.length === 1) return;
  editor.withoutRegistration(() => {
    editor.doc.openTimelineIds = [id];
  });
}

export function closeAllTimelineTabs(editor: Editor): void {
  closeOtherTimelineTabs(editor, editor.doc.activeTimelineId);
}

export function openAllTimelineTabs(editor: Editor): void {
  const opened = new Set(editor.doc.openTimelineIds);
  const missing = editor.doc.timelines.map((t) => t.id).filter((id) => !opened.has(id));
  if (missing.length === 0) return;
  editor.withoutRegistration(() => {
    editor.doc.openTimelineIds = [...editor.doc.openTimelineIds, ...missing];
  });
}
