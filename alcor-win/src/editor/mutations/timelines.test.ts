import { describe, expect, it } from "vitest";
import { makeTimeline, makeTimelineViewState } from "../../model";
import { fixtureClip, fixtureVideoTrack } from "../../model/fixtures";
import { Editor, makeEditorDocument } from "../editor";
import {
  activateTimeline, createTimeline, deleteTimeline, duplicateTimeline, nextTimelineName, renameTimeline,
} from "./timelines";

function makeEditor(): Editor {
  const doc = makeEditorDocument();
  const clip = fixtureClip({ start: 0, duration: 60 });
  clip.linkGroupId = "link-1";
  doc.timelines = [makeTimeline({ name: "Timeline 1", fps: 24, width: 1280, height: 720, settingsConfigured: true, tracks: [fixtureVideoTrack({ clips: [clip] })] })];
  doc.activeTimelineId = doc.timelines[0].id;
  doc.openTimelineIds = [doc.timelines[0].id];
  return new Editor(doc);
}

describe("timelines — create", () => {
  it("inheritsSettingsActivatesAndUndoes", () => {
    const e = makeEditor();
    const first = e.doc.activeTimelineId;
    const id = createTimeline(e);
    const created = e.timelines.find((t) => t.id === id);
    expect(created).toMatchObject({ name: "Timeline 2", fps: 24, width: 1280, height: 720, settingsConfigured: true });
    expect(e.doc.activeTimelineId).toBe(id);
    expect(e.doc.openTimelineIds).toEqual([first, id]);
    expect(e.undo()).toBe("New Timeline");
    expect(e.timelines.map((t) => t.id)).toEqual([first]);
    expect(e.doc.activeTimelineId).toBe(first);
  });
  it("canCreateWithoutActivating", () => {
    const e = makeEditor();
    const first = e.doc.activeTimelineId;
    createTimeline(e, "Named", false);
    expect(e.doc.activeTimelineId).toBe(first);
    expect(e.timelines[1].name).toBe("Named");
  });
  it("nextNameSkipsUsedNames", () => {
    const e = makeEditor();
    createTimeline(e, "Timeline 2", false);
    expect(nextTimelineName(e)).toBe("Timeline 3");
  });
});

describe("timelines — duplicate", () => {
  it("copiesWithFreshIdsAndCopyName", () => {
    const e = makeEditor();
    const src = e.timelines[0];
    const id = duplicateTimeline(e, src.id, false);
    const copy = e.timelines.find((t) => t.id === id);
    expect(copy?.name).toBe("Timeline 1 copy");
    expect(copy?.tracks[0].id).not.toBe(src.tracks[0].id);
    expect(copy?.tracks[0].clips[0].id).not.toBe(src.tracks[0].clips[0].id);
    expect(copy?.tracks[0].clips[0].linkGroupId).not.toBe("link-1");
    expect(copy?.tracks[0].clips[0].durationFrames).toBe(60);
    expect(e.timelines[0].tracks[0].clips[0].linkGroupId).toBe("link-1");
    expect(e.undo()).toBe("Duplicate Timeline");
    expect(e.timelines).toHaveLength(1);
  });
  it("secondCopyGetsANumber", () => {
    const e = makeEditor();
    duplicateTimeline(e, e.timelines[0].id, false);
    duplicateTimeline(e, e.timelines[0].id, false);
    expect(e.timelines.map((t) => t.name)).toEqual(["Timeline 1", "Timeline 1 copy", "Timeline 1 copy 2"]);
  });
  it("unknownIdReturnsUndefined", () => {
    const e = makeEditor();
    expect(duplicateTimeline(e, "nope")).toBeUndefined();
    expect(e.undo()).toBeNull();
  });
});

describe("timelines — rename", () => {
  it("trimsAndIsUndoable", () => {
    const e = makeEditor();
    renameTimeline(e, e.timelines[0].id, "  Final  ");
    expect(e.timelines[0].name).toBe("Final");
    expect(e.undo()).toBe("Rename Timeline");
    expect(e.timelines[0].name).toBe("Timeline 1");
  });
  it("blankUnchangedOrUnknownDoNothing", () => {
    const e = makeEditor();
    renameTimeline(e, e.timelines[0].id, "   ");
    renameTimeline(e, e.timelines[0].id, "Timeline 1");
    renameTimeline(e, "nope", "X");
    expect(e.undo()).toBeNull();
  });
});

describe("timelines — delete", () => {
  it("lastTimelineIsRefusedWithToast", () => {
    const e = makeEditor();
    deleteTimeline(e, e.timelines[0].id);
    expect(e.timelines).toHaveLength(1);
    expect(e.ui.toast?.kind).toBe("error");
    expect(e.undo()).toBeNull();
  });
  it("deletingTheActiveTimelineFallsBackAndUndoRestoresIt", () => {
    const e = makeEditor();
    const first = e.doc.activeTimelineId;
    const second = createTimeline(e);
    expect(e.doc.activeTimelineId).toBe(second);
    deleteTimeline(e, second);
    expect(e.timelines.map((t) => t.id)).toEqual([first]);
    expect(e.doc.activeTimelineId).toBe(first);
    expect(e.doc.openTimelineIds).toEqual([first]);
    expect(e.undo()).toBe("Delete Timeline");
    expect(e.timelines.map((t) => t.id)).toContain(second);
    expect(e.doc.activeTimelineId).toBe(second);
  });
  it("clearsTheDeletedTimelineFromTheSelection", () => {
    const e = makeEditor();
    const second = createTimeline(e, "B", false);
    e.ui.selectedTimelineIds = new Set([second]);
    deleteTimeline(e, second);
    expect(e.ui.selectedTimelineIds.size).toBe(0);
  });
});

describe("timelines — activate", () => {
  it("stashesAndRestoresViewStateAndClearsTimelineScopedSelection", () => {
    const e = makeEditor();
    const first = e.doc.activeTimelineId;
    const second = createTimeline(e, "B", false);
    e.ui.currentFrame = 33;
    e.ui.zoomScale = 2;
    e.ui.selectedClipIds = new Set(["c"]);
    activateTimeline(e, second);
    expect(e.liveViewStates[first]).toEqual(makeTimelineViewState({ playheadFrame: 33, zoomScale: 2, scrollOffsetX: 0 }));
    expect(e.ui.selectedClipIds.size).toBe(0);
    expect(e.ui.currentFrame).toBe(0);
    activateTimeline(e, first);
    expect(e.ui.currentFrame).toBe(33);
    expect(e.ui.zoomScale).toBe(2);
    expect(e.undo()).toBe("New Timeline");
  });
  it("unknownOrAlreadyActiveIsNoOp", () => {
    const e = makeEditor();
    const first = e.doc.activeTimelineId;
    activateTimeline(e, "nope");
    activateTimeline(e, first);
    expect(e.doc.activeTimelineId).toBe(first);
  });
});
