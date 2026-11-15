import { describe, expect, it } from "vitest";
import { Layout, makeRGBA, makeTimelineMarker } from "../../model";
import { makeEditor, setup } from "../../editor/mutations/testFixtures";
import { makeTimelineGeometry } from "../timelineGeometry";
import { addTimelineMarkerAtSelection, changeTimelineMarkers, timelineMarkerSnapFrames } from "./timelineMarkerCommands";
import { markerAt, markerIdsIntersecting } from "./timelineMarkerGeometry";

describe("Timeline markers", () => {
  it("markerChangesUndoAsOneAction", () => {
    const editor = makeEditor();
    const created = changeTimelineMarkers(editor, {
      creates: [makeTimelineMarker({ name: "Audio note", startFrame: 12, durationFrames: 8, color: makeRGBA({ r: 1, g: 1, b: 0 }), comment: "Lower this" })],
      actionName: "Add Marker",
    }).created[0];
    expect(editor.timeline.markers).toEqual([created]);
    editor.undo();
    expect(editor.timeline.markers).toEqual([]);
    editor.redo();
    expect(editor.timeline.markers).toEqual([created]);
    expect(timelineMarkerSnapFrames(editor)).toEqual([12, 20]);
    expect(timelineMarkerSnapFrames(editor, new Set([created?.id ?? ""]))).toEqual([]);
  });

  it("markerStatusChangesUndo", () => {
    const editor = makeEditor();
    setup(editor, (e) => {
      e.timeline.markers = [makeTimelineMarker({ id: "marker", name: "Review", startFrame: 12 })];
    });
    const marker = { ...editor.timeline.markers[0], status: "review" as const } as (typeof editor.timeline.markers)[number];
    changeTimelineMarkers(editor, { updates: [marker], actionName: "Change Marker Status" });
    expect(editor.timeline.markers[0]?.status).toBe("review");
    editor.undo();
    expect(editor.timeline.markers[0]?.status).toBe("open");
  });

  it("committingMarkerChangeClearsItsPreview", () => {
    const editor = makeEditor();
    const marker = makeTimelineMarker({ id: "marker", name: "Review", startFrame: 12 });
    setup(editor, (e) => {
      e.timeline.markers = [marker];
    });
    const preview = { ...marker, startFrame: 20 };
    editor.ui.timelineMarkerPreview = preview;
    changeTimelineMarkers(editor, { updates: [preview], actionName: "Move Marker" });
    expect(editor.timeline.markers).toEqual([preview]);
    expect(editor.ui.timelineMarkerPreview).toBeNull();
  });

  it("invalidNameIsRefusedWithoutMutation", () => {
    const editor = makeEditor();
    expect(() => changeTimelineMarkers(editor, { creates: [makeTimelineMarker({ name: "  ", startFrame: 0 })], actionName: "Add" })).toThrow();
    expect(editor.store.canUndo).toBe(false);
  });

  it("defaultMarkerNamesUseNextNumber", () => {
    const editor = makeEditor();
    editor.ui.currentFrame = 10;
    const first = addTimelineMarkerAtSelection(editor);
    editor.ui.currentFrame = 11;
    const second = addTimelineMarkerAtSelection(editor);
    expect([first?.startFrame, first?.name]).toEqual([10, "Marker 1"]);
    expect(second?.name).toBe("Marker 2");
  });

  it("marqueeCrossingRulerSelectsMarkers", () => {
    const geometry = makeTimelineGeometry({ pixelsPerFrame: 1, trackHeights: [50] });
    const markers = [makeTimelineMarker({ id: "first", name: "First", startFrame: 10 }), makeTimelineMarker({ id: "second", name: "Second", startFrame: 20 })];
    expect(markerIdsIntersecting({ x: 0, y: 0, width: 30, height: 100 }, markers, geometry, 0)).toEqual(new Set(["first", "second"]));
  });

  it("durationBarIsNotAMarkerHitTarget", () => {
    const geometry = makeTimelineGeometry({ pixelsPerFrame: 1, trackHeights: [] });
    const marker = makeTimelineMarker({ id: "range", name: "Range", startFrame: 10, durationFrames: 30 });
    expect(markerIdsIntersecting({ x: 20, y: 0, width: 5, height: 2 }, [marker], geometry, 0).size).toBe(0);
  });

  it("markerFlagSitsAtTopOfRuler", () => {
    const geometry = makeTimelineGeometry({ pixelsPerFrame: 1, trackHeights: [] });
    const marker = makeTimelineMarker({ id: "mark", name: "Mark", startFrame: 10 });
    expect(markerAt({ x: 10, y: 2 }, [marker], geometry, 0)?.id).toBe("mark");
    expect(markerAt({ x: 10, y: Layout.rulerHeight - 2 }, [marker], geometry, 0)).toBeUndefined();
  });
});
