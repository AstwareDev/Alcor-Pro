import { describe, expect, it } from "vitest";
import { Fixtures, makeEditor } from "../../editor/mutations/testFixtures";
import { isTextInputTarget, matchShortcut, runShortcut, type KeyLike, type ShortcutContext } from "./shortcuts";
import { timelineToolMode } from "./toolMode";

function key(code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}

const focused = { timelineFocused: true };

describe("Timeline shortcuts", () => {
  it("mapsCommandToCtrl", () => {
    expect(matchShortcut(key("KeyZ", { ctrlKey: true }), focused)?.command).toBe("undo");
    expect(matchShortcut(key("KeyZ", { ctrlKey: true, shiftKey: true }), focused)?.command).toBe("redo");
    expect(matchShortcut(key("KeyK", { ctrlKey: true }), focused)?.command).toBe("splitAtPlayhead");
  });

  it("toolKeysRequireNoCtrlSoClipboardWins", () => {
    expect(matchShortcut(key("KeyC"), focused)?.command).toBe("toolRazor");
    expect(matchShortcut(key("KeyC", { ctrlKey: true }), focused)?.command).toBe("copy");
    expect(matchShortcut(key("KeyV", { ctrlKey: true }), focused)?.command).toBe("paste");
    expect(matchShortcut(key("KeyV", { shiftKey: true }), focused)?.command).toBe("toolPointer");
  });

  it("deleteShiftSelectsRippleDelete", () => {
    expect(matchShortcut(key("Backspace"), focused)?.command).toBe("delete");
    expect(matchShortcut(key("Delete", { shiftKey: true }), focused)?.command).toBe("rippleDelete");
  });

  it("arrowsStepAndShiftSkips", () => {
    expect(matchShortcut(key("ArrowLeft"), focused)?.command).toBe("stepBackward");
    expect(matchShortcut(key("ArrowRight", { shiftKey: true }), focused)?.command).toBe("skipForward");
  });

  it("rangeMarksRefuseModifiers", () => {
    expect(matchShortcut(key("KeyI"), focused)?.command).toBe("markIn");
    expect(matchShortcut(key("KeyI", { ctrlKey: true }), focused)).toBeUndefined();
    expect(matchShortcut(key("KeyO", { altKey: true }), focused)).toBeUndefined();
  });

  it("focusScopedCommandsNeedTimelineFocus", () => {
    expect(matchShortcut(key("KeyA"), { timelineFocused: false })).toBeUndefined();
    expect(matchShortcut(key("KeyA"), focused)?.command).toBe("selectForwardOnTrack");
    expect(matchShortcut(key("KeyA", { shiftKey: true }), focused)?.command).toBe("selectForwardOnAllTracks");
    expect(matchShortcut(key("KeyC", { ctrlKey: true }), { timelineFocused: false })).toBeUndefined();
  });

  it("windowsKeyNeverMatches", () => {
    expect(matchShortcut(key("KeyZ", { metaKey: true, ctrlKey: true }), focused)).toBeUndefined();
  });

  it("textInputsSuppressShortcuts", () => {
    expect(isTextInputTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextInputTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextInputTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextInputTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextInputTarget({ tagName: "CANVAS" })).toBe(false);
  });

  it("escapeCancelsDragFirstThenClears", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "a", start: 0, duration: 10 })] })]);
    editor.ui.selectedClipIds = new Set(["a"]);
    let dragging = true;
    const ctx: ShortcutContext = {
      editor,
      cancelDrag: () => {
        const was = dragging;
        dragging = false;
        return was;
      },
      zoomBy: () => undefined,
      zoomToFit: () => undefined,
      presentMarkerEditor: () => undefined,
    };
    runShortcut("toolTrim", ctx);
    expect(timelineToolMode(editor)).toBe("trim");
    runShortcut("escape", ctx);
    expect(editor.ui.selectedClipIds.size).toBe(1);
    runShortcut("escape", ctx);
    expect(editor.ui.selectedClipIds.size).toBe(0);
    expect(timelineToolMode(editor)).toBe("pointer");
  });

  it("deletePrefersSelectedMarkers", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "a", start: 0, duration: 10 })] })]);
    const ctx: ShortcutContext = { editor, cancelDrag: () => false, zoomBy: () => undefined, zoomToFit: () => undefined, presentMarkerEditor: () => undefined };
    runShortcut("addMarker", ctx);
    expect(editor.timeline.markers.length).toBe(1);
    editor.ui.selectedClipIds = new Set(["a"]);
    editor.ui.selectedTimelineMarkerIds = new Set([editor.timeline.markers[0]?.id ?? ""]);
    runShortcut("delete", ctx);
    expect(editor.timeline.markers.length).toBe(0);
    expect(editor.clipFor("a")).not.toBeNull();
  });
});
