import { createSignal, type Signal } from "solid-js";
import type { Editor } from "../../editor/editor";
import type { TimelineToolMode } from "./inputController";

// Swift ToolMode has a third case, `.trim` (slip). `EditorUIState.toolMode` only carries pointer/razor, so the
// trim tool is kept here as an override on top of it.

const trimOverrides = new WeakMap<Editor, Signal<boolean>>();

function trimOverride(editor: Editor): Signal<boolean> {
  let s = trimOverrides.get(editor);
  if (!s) {
    s = createSignal(false);
    trimOverrides.set(editor, s);
  }
  return s;
}

export function timelineToolMode(editor: Editor): TimelineToolMode {
  return trimOverride(editor)[0]() && editor.ui.toolMode === "pointer" ? "trim" : editor.ui.toolMode;
}

export function setTimelineToolMode(editor: Editor, mode: TimelineToolMode): void {
  trimOverride(editor)[1](mode === "trim");
  editor.ui.toolMode = mode === "razor" ? "razor" : "pointer";
}
