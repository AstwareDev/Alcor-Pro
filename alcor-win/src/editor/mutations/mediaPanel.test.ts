import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMediaAsset, makeTimeline, type MediaAsset } from "../../model";
import { fixtureClip, fixtureVideoTrack } from "../../model/fixtures";
import { makeFakeIo, type FakeIo } from "../../media/fakeIo";
import { setMediaIo } from "../../media/io";
import {
  createFolder, folder, importMediaAsset, mediaPanelFolderKey, mediaPanelTimelineKey, moveAssetsToFolder,
} from "../../media/library";
import { assetDragString, folderDragString, timelineDragString } from "../../mediapanel/dragPayload";
import { Editor, makeEditorDocument } from "../editor";
import {
  applyMediaPanelSelection, clearMediaPanelSelection, createMediaPanelFolder, deleteMediaPanelItems,
  handleClipboardPaste, handlePanelFinderDrop, mediaPanelScrollTarget, mediaPanelSelectionAnchor,
  mediaPanelSelectionMode, moveMediaSelection, pruneMediaPanelSelectionAnchor, resolveTextDrop,
  selectAllMediaPanelItems, selectMediaPanelItem, setMediaPanelLayout,
} from "./mediaPanel";

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

function makeEditor(): Editor {
  const doc = makeEditorDocument();
  doc.timelines = [makeTimeline({ tracks: [fixtureVideoTrack()] })];
  doc.activeTimelineId = doc.timelines[0].id;
  doc.openTimelineIds = [doc.timelines[0].id];
  return new Editor(doc);
}

let counter = 0;
function asset(name: string, folderId?: string): MediaAsset {
  counter += 1;
  const a = makeMediaAsset({ url: `/tmp/${counter}-${name}.mp4`, type: "video", name });
  if (folderId !== undefined) a.folderId = folderId;
  return a;
}

describe("MediaTab — resolveTextDrop", () => {
  it("routesSingleAssetIntoDestinationFolder", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const a = asset("x");
    importMediaAsset(e, a);
    resolveTextDrop(e, assetDragString(a.id), dest);
    expect(e.mediaAsset(a.id)?.folderId).toBe(dest);
    expect(e.doc.mediaManifest.entries.find((x) => x.id === a.id)?.folderId).toBe(dest);
  });
  it("routesSingleFolderUnderDestinationParent", () => {
    const e = makeEditor();
    const parent = createFolder(e, "Parent");
    const child = createFolder(e, "Child");
    resolveTextDrop(e, folderDragString(child), parent);
    expect(folder(e, child)?.parentFolderId).toBe(parent);
  });
  it("multiLinePayloadRoutesAssetsFoldersAndTimelinesTogether", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const movable = createFolder(e, "Movable");
    const a1 = asset("a1");
    const a2 = asset("a2");
    importMediaAsset(e, a1);
    importMediaAsset(e, a2);
    const tl = e.timelines[0].id;
    resolveTextDrop(e, [assetDragString(a1.id), folderDragString(movable), assetDragString(a2.id), timelineDragString(tl)].join("\n"), dest);
    expect(e.mediaAsset(a1.id)?.folderId).toBe(dest);
    expect(e.mediaAsset(a2.id)?.folderId).toBe(dest);
    expect(folder(e, movable)?.parentFolderId).toBe(dest);
    expect(e.timelines[0].folderId).toBe(dest);
  });
  it("nilDestinationReparentsToRoot", () => {
    const e = makeEditor();
    const box = createFolder(e, "Box");
    const a = asset("x", box);
    importMediaAsset(e, a);
    resolveTextDrop(e, assetDragString(a.id), undefined);
    expect(e.mediaAsset(a.id)?.folderId).toBeUndefined();
  });
  it("unknownAssetIdIsIgnored", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    resolveTextDrop(e, assetDragString("ghost-asset"), dest);
    expect(e.mediaAssets).toEqual([]);
  });
  it("unrecognizedLinesAreIgnored", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const a = asset("x");
    importMediaAsset(e, a);
    resolveTextDrop(e, ["file:///tmp/garbage.mp4", "", "random nonsense", assetDragString(a.id)].join("\n"), dest);
    expect(e.mediaAsset(a.id)?.folderId).toBe(dest);
  });
  it("cycleIntoOwnDescendantIsRejected", () => {
    const e = makeEditor();
    const parent = createFolder(e, "Parent");
    const child = createFolder(e, "Child", parent);
    resolveTextDrop(e, folderDragString(parent), child);
    expect(folder(e, parent)?.parentFolderId).toBeUndefined();
  });
  it("emptyPayloadIsNoOp", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const a = asset("x");
    importMediaAsset(e, a);
    resolveTextDrop(e, "", dest);
    expect(e.mediaAsset(a.id)?.folderId).toBeUndefined();
  });
});

describe("EditorViewModel — moveMediaSelection", () => {
  function seedGrid(e: Editor, count: number, columns: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const a = asset(`a${i}`);
      importMediaAsset(e, a);
      ids.push(a.id);
    }
    setMediaPanelLayout(e, ids, columns);
    return ids;
  }

  it("emptyOrderedListIsNoOp", () => {
    const e = makeEditor();
    setMediaPanelLayout(e, [], 1);
    moveMediaSelection(e, "right");
    expect(e.ui.selectedMediaAssetIds.size).toBe(0);
    expect(mediaPanelScrollTarget(e)).toBeNull();
  });
  it("noSelectionRightSelectsFirstItem", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 4, 4);
    moveMediaSelection(e, "right");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[0]]);
    expect(mediaPanelScrollTarget(e)).toBe(ids[0]);
  });
  it("noSelectionLeftAndUpSelectLastItem", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 4, 4);
    moveMediaSelection(e, "left");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[3]]);
    clearMediaPanelSelection(e);
    moveMediaSelection(e, "up");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[3]]);
  });
  it("rightAdvancesToNextItem", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 4, 4);
    e.ui.selectedMediaAssetIds = new Set([ids[1]]);
    moveMediaSelection(e, "right");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[2]]);
  });
  it("edgesClampAndDoNothing", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 4, 4);
    e.ui.selectedMediaAssetIds = new Set([ids[3]]);
    moveMediaSelection(e, "right");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[3]]);
    expect(mediaPanelScrollTarget(e)).toBeNull();
    e.ui.selectedMediaAssetIds = new Set([ids[0]]);
    moveMediaSelection(e, "left");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[0]]);
    expect(mediaPanelScrollTarget(e)).toBeNull();
  });
  it("downJumpsByColumnCount", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 6, 3);
    e.ui.selectedMediaAssetIds = new Set([ids[1]]);
    moveMediaSelection(e, "down");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[4]]);
  });
  it("downAtPartialBottomRowClampsToLast", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 5, 3);
    e.ui.selectedMediaAssetIds = new Set([ids[2]]);
    moveMediaSelection(e, "down");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[4]]);
  });
  it("navigatingBetweenFoldersAndAssetsSwapsSelectionKind", () => {
    const e = makeEditor();
    const folderId = createFolder(e, "F");
    const a = asset("x");
    importMediaAsset(e, a);
    setMediaPanelLayout(e, [mediaPanelFolderKey(folderId), a.id], 2);
    e.ui.selectedMediaAssetIds = new Set([a.id]);
    moveMediaSelection(e, "left");
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect(e.ui.selectedMediaAssetIds.size).toBe(0);
    moveMediaSelection(e, "right");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([a.id]);
    expect(e.ui.selectedFolderIds.size).toBe(0);
  });
  it("ghostSelectionDoesNotAnchorNavigation", () => {
    const e = makeEditor();
    const ids = seedGrid(e, 4, 4);
    e.ui.selectedMediaAssetIds = new Set(["ghost-id"]);
    moveMediaSelection(e, "right");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([ids[0]]);
  });
});

describe("Media panel interactions", () => {
  it("modifierFlagsUseWindowsSelectionConventions", () => {
    expect(mediaPanelSelectionMode({ ctrl: false, shift: false })).toBe("replacing");
    expect(mediaPanelSelectionMode({ ctrl: true, shift: false })).toBe("toggling");
    expect(mediaPanelSelectionMode({ ctrl: false, shift: true })).toBe("range");
    expect(mediaPanelSelectionMode({ ctrl: true, shift: true })).toBe("extendingRange");
  });
  it("ctrlAndShiftSelectionWorkAcrossKinds", () => {
    const e = makeEditor();
    const folderId = createFolder(e, "Bin");
    const first = asset("first");
    const second = asset("second");
    importMediaAsset(e, first);
    importMediaAsset(e, second);
    const folderKey = mediaPanelFolderKey(folderId);
    const timelineKey = mediaPanelTimelineKey(e.doc.activeTimelineId);
    setMediaPanelLayout(e, [folderKey, timelineKey, first.id, second.id], 4);
    selectMediaPanelItem(e, folderKey, "replacing");
    selectMediaPanelItem(e, second.id, "toggling");
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect([...e.ui.selectedMediaAssetIds]).toEqual([second.id]);
    expect(mediaPanelSelectionAnchor(e)).toBe(second.id);
    selectMediaPanelItem(e, folderKey, "replacing");
    selectMediaPanelItem(e, first.id, "range");
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect([...e.ui.selectedTimelineIds]).toEqual([e.doc.activeTimelineId]);
    expect([...e.ui.selectedMediaAssetIds]).toEqual([first.id]);
    expect(mediaPanelSelectionAnchor(e)).toBe(folderKey);
  });
  it("extendingRangeAddsToTheSelection", () => {
    const e = makeEditor();
    const ids = [0, 1, 2, 3].map((i) => asset(`c${i}`));
    ids.forEach((a) => importMediaAsset(e, a));
    setMediaPanelLayout(e, ids.map((a) => a.id), 4);
    selectMediaPanelItem(e, ids[0].id, "replacing");
    selectMediaPanelItem(e, ids[3].id, "toggling");
    selectMediaPanelItem(e, ids[2].id, "extendingRange");
    expect(e.ui.selectedMediaAssetIds).toEqual(new Set([ids[0].id, ids[2].id, ids[3].id]));
  });
  it("rangeWithoutAnchorSelectsJustTheTarget", () => {
    const e = makeEditor();
    const a = asset("a");
    importMediaAsset(e, a);
    setMediaPanelLayout(e, [a.id], 1);
    selectMediaPanelItem(e, a.id, "range");
    expect([...e.ui.selectedMediaAssetIds]).toEqual([a.id]);
    expect(mediaPanelSelectionAnchor(e)).toBe(a.id);
  });
  it("marqueeSelectionEstablishesAVisibleRangeAnchor", () => {
    const e = makeEditor();
    const clips = [0, 1, 2].map((i) => asset(`clip-${i}`));
    clips.forEach((c) => importMediaAsset(e, c));
    setMediaPanelLayout(e, clips.map((c) => c.id), 3);
    applyMediaPanelSelection(e, new Set([clips[0].id, clips[1].id]), null);
    pruneMediaPanelSelectionAnchor(e);
    selectMediaPanelItem(e, clips[2].id, "range");
    expect(e.ui.selectedMediaAssetIds).toEqual(new Set(clips.map((c) => c.id)));
    expect(mediaPanelSelectionAnchor(e)).toBe(clips[0].id);
  });
  it("selectAllSelectsEveryOrderedItem", () => {
    const e = makeEditor();
    const folderId = createFolder(e, "F");
    const a = asset("a");
    importMediaAsset(e, a);
    setMediaPanelLayout(e, [mediaPanelFolderKey(folderId), a.id], 2);
    selectAllMediaPanelItems(e);
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect([...e.ui.selectedMediaAssetIds]).toEqual([a.id]);
  });
  it("creationSelectsAndRevealsFolderAndRestoresSelectionOnUndo", () => {
    const e = makeEditor();
    const parentId = createFolder(e, "Parent");
    const clip = asset("clip");
    importMediaAsset(e, clip);
    selectMediaPanelItem(e, clip.id);
    const folderId = createMediaPanelFolder(e, parentId);
    expect(folder(e, folderId)?.parentFolderId).toBe(parentId);
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect(e.ui.selectedMediaAssetIds.size).toBe(0);
    expect(mediaPanelScrollTarget(e)).toBe(mediaPanelFolderKey(folderId));
    expect(e.undo()).toBe("New Folder");
    expect(folder(e, folderId)).toBeUndefined();
    expect([...e.ui.selectedMediaAssetIds]).toEqual([clip.id]);
  });
  it("mixedDeleteIsOneUndoableAction", () => {
    const e = makeEditor();
    const folderId = createFolder(e, "Bin");
    const selected = [asset("selected-0"), asset("selected-1")];
    const keep = asset("keep");
    [...selected, keep].forEach((a) => importMediaAsset(e, a));
    const folderKey = mediaPanelFolderKey(folderId);
    setMediaPanelLayout(e, [folderKey, ...selected.map((a) => a.id), keep.id], 4);
    selectMediaPanelItem(e, folderKey, "replacing");
    for (const a of selected) selectMediaPanelItem(e, a.id, "toggling");
    deleteMediaPanelItems(e, folderKey);
    expect(folder(e, folderId)).toBeUndefined();
    expect(e.mediaAssets.map((a) => a.id)).toEqual([keep.id]);
    expect(e.undo()).toBe("Delete Media Items");
    expect(folder(e, folderId)).toBeDefined();
    expect(new Set(e.mediaAssets.map((a) => a.id))).toEqual(new Set([...selected.map((a) => a.id), keep.id]));
    expect([...e.ui.selectedFolderIds]).toEqual([folderId]);
    expect(e.ui.selectedMediaAssetIds).toEqual(new Set(selected.map((a) => a.id)));
  });
  it("deleteOutsideSelectionRetargetsToTheContextItem", () => {
    const e = makeEditor();
    const a = asset("a");
    const b = asset("b");
    importMediaAsset(e, a);
    importMediaAsset(e, b);
    e.ui.selectedMediaAssetIds = new Set([a.id]);
    deleteMediaPanelItems(e, b.id);
    expect(e.mediaAssets.map((x) => x.id)).toEqual([a.id]);
    expect(e.undo()).toBe("Delete Media");
  });
  it("deletingEveryTimelineIsRefusedWithAToast", () => {
    const e = makeEditor();
    const tl = e.doc.activeTimelineId;
    e.ui.selectedTimelineIds = new Set([tl]);
    deleteMediaPanelItems(e);
    expect(e.timelines).toHaveLength(1);
    expect(e.ui.toast?.message).toContain("Can't delete every timeline");
    expect(e.undo()).toBeNull();
  });
  it("deleteWithEmptySelectionDoesNothing", () => {
    const e = makeEditor();
    deleteMediaPanelItems(e);
    expect(e.undo()).toBeNull();
  });
  it("deletingASingleTimelineKeepsTheOtherAndIsUndoable", () => {
    const e = makeEditor();
    const second = makeTimeline({ name: "B", tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 10 })] })] });
    e.store.reset({ ...e.doc, timelines: [...e.doc.timelines, second] });
    deleteMediaPanelItems(e, mediaPanelTimelineKey(second.id));
    expect(e.timelines.map((t) => t.id)).not.toContain(second.id);
    expect(e.undo()).toBe("Delete Timeline");
    expect(e.timelines.map((t) => t.id)).toContain(second.id);
  });
});

describe("MediaTab — handlePanelFinderDrop", () => {
  it("addsAssetAtRootWhenDestinationIsNil", async () => {
    const e = makeEditor();
    io.addFile("/drop/clip.mp4");
    await handlePanelFinderDrop(e, ["/drop/clip.mp4"], undefined, { finalize: false });
    expect(e.mediaAssets).toHaveLength(1);
    expect(e.mediaAssets[0].folderId).toBeUndefined();
  });
  it("addsMultipleAssetsIntoDestination", async () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const paths = ["/drop/a.mp4", "/drop/b.mp4", "/drop/c.mp4"];
    paths.forEach((p) => io.addFile(p));
    await handlePanelFinderDrop(e, paths, dest, { finalize: false });
    expect(e.mediaAssets).toHaveLength(3);
    expect(e.mediaAssets.every((a) => a.folderId === dest)).toBe(true);
  });
  it("skipsUnsupportedFileExtensions", async () => {
    const e = makeEditor();
    io.addFile("/drop/readme.txt");
    await handlePanelFinderDrop(e, ["/drop/readme.txt"], undefined, { finalize: false });
    expect(e.mediaAssets).toEqual([]);
  });
  it("emptyDropIsNoOp", async () => {
    const e = makeEditor();
    expect(await handlePanelFinderDrop(e, [], undefined)).toBeUndefined();
    expect(e.undo()).toBeNull();
  });
});

describe("MediaTab — handleClipboardPaste", () => {
  it("filePathsRouteThroughFinderDropAndWinOverImages", async () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    io.addFile("/clip/clip.mp4");
    await handleClipboardPaste(e, { paths: ["/clip/clip.mp4"], images: [{ extension: "png", data: new Uint8Array([1]) }] }, dest, { finalize: false });
    expect(e.mediaAssets).toHaveLength(1);
    expect(e.mediaAssets[0].type).toBe("video");
    expect(e.mediaAssets[0].folderId).toBe(dest);
  });
  it("emptyClipboardIsNoOp", async () => {
    const e = makeEditor();
    await handleClipboardPaste(e, { paths: [], images: [] }, undefined);
    expect(e.mediaAssets).toEqual([]);
  });
  it("unsupportedPathIsNoOp", async () => {
    const e = makeEditor();
    io.addFile("/clip/readme.txt");
    await handleClipboardPaste(e, { paths: ["/clip/readme.txt"], images: [] }, undefined, { finalize: false });
    expect(e.mediaAssets).toEqual([]);
  });
});

describe("selection survives asset moves", () => {
  it("movingAssetsKeepsThemSelectable", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const a = asset("a");
    importMediaAsset(e, a);
    moveAssetsToFolder(e, new Set([a.id]), dest);
    selectMediaPanelItem(e, a.id);
    expect([...e.ui.selectedMediaAssetIds]).toEqual([a.id]);
  });
});
