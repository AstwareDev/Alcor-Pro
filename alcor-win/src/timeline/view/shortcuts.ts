import type { Editor } from "../../editor/editor";
import { deleteSelectedClips, splitAtPlayhead, trimEndToPlayhead, trimStartToPlayhead } from "../../editor/mutations/clipMutations";
import { canPasteClips, copySelectedClipsToClipboard, pasteClipsAtPlayhead } from "../../editor/mutations/clipboard";
import { easyEaseSelectedKeyframes } from "../../editor/mutations/keyframes";
import { skipBackward, skipForward, stepBackward, stepForward } from "../../editor/mutations/core";
import { rippleDeleteSelectedClips, rippleDeleteSelectedGap } from "../../editor/mutations/ripple";
import { selectForwardFromCurrentSelection } from "../../editor/mutations/selection";
import { addTransitionNearPlayhead, removeTransition } from "../../editor/mutations/transitions";
import { clearTimelineRange, markTimelineRangeEnd, markTimelineRangeStart } from "../../editor/mutations/timelineRange";
import { addTimelineMarkerAtSelection, deleteSelectedTimelineMarker } from "./timelineMarkerCommands";
import { selectAdjacentOpenTimeline } from "./timelineTabs";
import { setTimelineToolMode } from "./toolMode";

// Timeline / editing shortcuts of MainMenu.swift and EditorWindowController.handleKeyDown, macOS ⌘ → Ctrl,
// ⌥ → Alt. Keys match on `KeyboardEvent.code` (physical key), like the Swift keyCode switch.

export type ShortcutCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "selectForwardOnTrack"
  | "selectForwardOnAllTracks"
  | "splitAtPlayhead"
  | "trimStartToPlayhead"
  | "trimEndToPlayhead"
  | "delete"
  | "rippleDelete"
  | "togglePlayback"
  | "stepBackward"
  | "stepForward"
  | "skipBackward"
  | "skipForward"
  | "addMarker"
  | "toolPointer"
  | "toolRazor"
  | "toolTrim"
  | "markIn"
  | "markOut"
  | "nextTimelineTab"
  | "previousTimelineTab"
  | "zoomIn"
  | "zoomOut"
  | "zoomToFit"
  | "easyEase"
  | "addTransition"
  | "escape";

/** `true` = modifier required, `false` = must be up, omitted = either. */
export interface KeyCombo {
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutBinding {
  combo: KeyCombo;
  command: ShortcutCommand;
  /** Only while the timeline panel has focus (Swift `focusedPanel == .timeline`). */
  timelineFocusOnly?: boolean;
}

const noMods = { ctrl: false, alt: false };

export const shortcutTable: readonly ShortcutBinding[] = [
  // Edit menu
  { combo: { code: "KeyZ", ctrl: true, shift: false, alt: false }, command: "undo" },
  { combo: { code: "KeyZ", ctrl: true, shift: true, alt: false }, command: "redo" },
  { combo: { code: "KeyY", ctrl: true, shift: false, alt: false }, command: "redo" },
  { combo: { code: "KeyX", ctrl: true, shift: false, alt: false }, command: "cut", timelineFocusOnly: true },
  { combo: { code: "KeyC", ctrl: true, shift: false, alt: false }, command: "copy", timelineFocusOnly: true },
  { combo: { code: "KeyV", ctrl: true, shift: false, alt: false }, command: "paste", timelineFocusOnly: true },
  { combo: { code: "KeyA", ctrl: true, shift: false, alt: false }, command: "selectAll", timelineFocusOnly: true },
  { combo: { code: "KeyA", ...noMods, shift: false }, command: "selectForwardOnTrack", timelineFocusOnly: true },
  { combo: { code: "KeyA", ...noMods, shift: true }, command: "selectForwardOnAllTracks", timelineFocusOnly: true },
  { combo: { code: "KeyK", ctrl: true, shift: false, alt: false }, command: "splitAtPlayhead" },
  { combo: { code: "KeyQ", ...noMods, shift: false }, command: "trimStartToPlayhead" },
  { combo: { code: "KeyW", ...noMods, shift: false }, command: "trimEndToPlayhead" },
  { combo: { code: "BracketLeft" }, command: "trimStartToPlayhead" },
  { combo: { code: "BracketRight" }, command: "trimEndToPlayhead" },
  { combo: { code: "Backspace", shift: false }, command: "delete" },
  { combo: { code: "Delete", shift: false }, command: "delete" },
  { combo: { code: "Backspace", shift: true }, command: "rippleDelete" },
  { combo: { code: "Delete", shift: true }, command: "rippleDelete" },
  // EditorWindowController key monitor
  { combo: { code: "Space" }, command: "togglePlayback" },
  { combo: { code: "ArrowLeft", shift: false }, command: "stepBackward" },
  { combo: { code: "ArrowLeft", shift: true }, command: "skipBackward" },
  { combo: { code: "ArrowRight", shift: false }, command: "stepForward" },
  { combo: { code: "ArrowRight", shift: true }, command: "skipForward" },
  { combo: { code: "KeyM", ...noMods }, command: "addMarker" },
  { combo: { code: "KeyV", ctrl: false }, command: "toolPointer" },
  { combo: { code: "KeyC", ctrl: false }, command: "toolRazor" },
  { combo: { code: "KeyT", ctrl: true, shift: false, alt: false }, command: "addTransition" },
  { combo: { code: "KeyT", ctrl: false }, command: "toolTrim" },
  { combo: { code: "KeyI", ...noMods }, command: "markIn" },
  { combo: { code: "KeyO", ...noMods }, command: "markOut" },
  { combo: { code: "Tab", ...noMods, shift: false }, command: "nextTimelineTab", timelineFocusOnly: true },
  { combo: { code: "Tab", ...noMods, shift: true }, command: "previousTimelineTab", timelineFocusOnly: true },
  { combo: { code: "Escape" }, command: "escape" },
  // Windows additions (no Swift shortcut): toolbar zoom buttons and fit.
  { combo: { code: "Equal", ctrl: true, alt: false }, command: "zoomIn" },
  { combo: { code: "NumpadAdd", ctrl: true, alt: false }, command: "zoomIn" },
  { combo: { code: "Minus", ctrl: true, alt: false }, command: "zoomOut" },
  { combo: { code: "NumpadSubtract", ctrl: true, alt: false }, command: "zoomOut" },
  { combo: { code: "KeyZ", ...noMods, shift: true }, command: "zoomToFit" },
  // After Effects: F9 = easy ease on the selected keyframes.
  { combo: { code: "F9", ...noMods, shift: false }, command: "easyEase" },
];

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

function modifierMatches(required: boolean | undefined, pressed: boolean): boolean {
  return required === undefined || required === pressed;
}

/** First binding whose combo matches the key event; the Windows key never matches. */
export function matchShortcut(
  event: KeyLike,
  context: { timelineFocused: boolean },
  table: readonly ShortcutBinding[] = shortcutTable,
): ShortcutBinding | undefined {
  if (event.metaKey) return undefined;
  return table.find(
    (b) =>
      b.combo.code === event.code &&
      modifierMatches(b.combo.ctrl, event.ctrlKey) &&
      modifierMatches(b.combo.shift, event.shiftKey) &&
      modifierMatches(b.combo.alt, event.altKey) &&
      (!b.timelineFocusOnly || context.timelineFocused),
  );
}

/** Shortcuts never fire while typing (Swift `isTextInputFocused`). */
export function isTextInputTarget(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (target.type ?? "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(type);
}

export interface ShortcutContext {
  editor: Editor;
  /** Cancels an in-flight timeline drag; true when one was cancelled. */
  cancelDrag(): boolean;
  zoomBy(factor: number): void;
  zoomToFit(): void;
  presentMarkerEditor(id: string): void;
}

/** Runs the command; returns false when it does not apply so the key falls through. */
export function runShortcut(command: ShortcutCommand, c: ShortcutContext): boolean {
  const editor = c.editor;
  const ui = editor.ui;
  switch (command) {
    case "undo":
      editor.undo();
      return true;
    case "redo":
      editor.redo();
      return true;
    case "cut":
      if (ui.selectedClipIds.size === 0) return false;
      copySelectedClipsToClipboard(editor);
      deleteSelectedClips(editor);
      return true;
    case "copy":
      if (ui.selectedClipIds.size === 0) return false;
      copySelectedClipsToClipboard(editor);
      return true;
    case "paste":
      if (!canPasteClips(editor)) return false;
      pasteClipsAtPlayhead(editor);
      return true;
    case "selectAll":
      ui.selectedGap = null;
      ui.selectedClipIds = new Set(editor.timeline.tracks.flatMap((t) => t.clips.map((x) => x.id)));
      return true;
    case "selectForwardOnTrack":
      selectForwardFromCurrentSelection(editor, "track");
      return true;
    case "selectForwardOnAllTracks":
      selectForwardFromCurrentSelection(editor, "allTracks");
      return true;
    case "splitAtPlayhead":
      splitAtPlayhead(editor);
      return true;
    case "trimStartToPlayhead":
      trimStartToPlayhead(editor);
      return true;
    case "trimEndToPlayhead":
      trimEndToPlayhead(editor);
      return true;
    case "delete":
      if (ui.selectedTransitionId !== null && ui.selectedClipIds.size === 0) removeTransition(editor, ui.selectedTransitionId);
      else if (ui.selectedTimelineMarkerIds.size > 0) deleteSelectedTimelineMarker(editor);
      else deleteSelectedClips(editor);
      return true;
    case "rippleDelete":
      if (ui.selectedTimelineMarkerIds.size > 0) deleteSelectedTimelineMarker(editor);
      else if (ui.selectedGap !== null) rippleDeleteSelectedGap(editor);
      else rippleDeleteSelectedClips(editor);
      return true;
    case "easyEase":
      return easyEaseSelectedKeyframes(editor);
    case "addTransition": {
      const result = addTransitionNearPlayhead(editor);
      if (!result.ok) editor.showToast(result.reason);
      return true;
    }
    case "togglePlayback":
      ui.isPlaying = !ui.isPlaying;
      return true;
    case "stepBackward":
      stepBackward(editor);
      return true;
    case "stepForward":
      stepForward(editor);
      return true;
    case "skipBackward":
      skipBackward(editor);
      return true;
    case "skipForward":
      skipForward(editor);
      return true;
    case "addMarker":
      addTimelineMarkerAtSelection(editor, c.presentMarkerEditor);
      return true;
    case "toolPointer":
      setTimelineToolMode(editor, "pointer");
      return true;
    case "toolRazor":
      setTimelineToolMode(editor, "razor");
      return true;
    case "toolTrim":
      setTimelineToolMode(editor, "trim");
      return true;
    case "markIn":
      markTimelineRangeStart(editor);
      return true;
    case "markOut":
      markTimelineRangeEnd(editor);
      return true;
    case "nextTimelineTab":
      return selectAdjacentOpenTimeline(editor, 1);
    case "previousTimelineTab":
      return selectAdjacentOpenTimeline(editor, -1);
    case "zoomIn":
      c.zoomBy(1.25);
      return true;
    case "zoomOut":
      c.zoomBy(1 / 1.25);
      return true;
    case "zoomToFit":
      c.zoomToFit();
      return true;
    case "escape":
      // An in-flight drag is cancelled with its state restored; otherwise Escape clears like Swift.
      if (c.cancelDrag()) return true;
      ui.selectedClipIds = new Set();
      clearTimelineRange(editor);
      ui.selectedTimelineMarkerIds = new Set();
      setTimelineToolMode(editor, "pointer");
      return true;
  }
}
