import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeMediaAsset, makeMediaFolder, type MediaAsset } from "../model";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { makeFakeIo, type FakeIo } from "./fakeIo";
import { setMediaIo } from "./io";
import {
  addMediaAssetOfType, applyProbeToAsset, assetsIn, clipDisplayLabel, createFolder, deleteFolders, deleteMediaAssets,
  dropPlaceholderAssets, findMissingAssetIds, flushPendingManifestMetadataUpdates, folder, folderPath, folders,
  importFinderItems, importMediaAsset, isMediaOffline, isMediaUnprocessable, mediaPanelFolderIdFromKey,
  mediaPanelFolderKey, mediaPanelTimelineIdFromKey, mediaPanelTimelineKey, moveAssetsToFolder, moveFoldersToFolder,
  moveTimelinesToFolder, queueManifestMetadataUpdate, refreshMissingMediaCache, relinkAsset, relinkOfflineAssets,
  renameFolder, renameMediaAsset, setUnprocessableMediaRef, subfolders, updateManifestMetadata,
} from "./library";
import type { MediaProbe } from "./probe";

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

function makeEditor(tracks = [fixtureVideoTrack()]): Editor {
  const doc = makeEditorDocument();
  doc.timelines = [fixtureTimeline({ tracks })];
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

describe("EditorViewModel — folder reads", () => {
  it("subfoldersReturnsImmediateChildrenSortedByName", () => {
    const e = makeEditor();
    const root = createFolder(e, "Root");
    createFolder(e, "Beta", root);
    createFolder(e, "alpha", root);
    createFolder(e, "Gamma", root);
    const alphaId = subfolders(e, root).find((f) => f.name === "alpha")?.id;
    createFolder(e, "Nested", alphaId);
    expect(subfolders(e, root).map((f) => f.name)).toEqual(["alpha", "Beta", "Gamma"]);
  });

  it("folderPathWalksFromRootToTarget", () => {
    const e = makeEditor();
    const a = createFolder(e, "A");
    const b = createFolder(e, "B", a);
    const c = createFolder(e, "C", b);
    expect(folderPath(e, c).map((f) => f.name)).toEqual(["A", "B", "C"]);
    expect(folderPath(e, undefined)).toEqual([]);
  });

  it("assetsInFiltersByFolderId", () => {
    const e = makeEditor();
    const folderId = createFolder(e, "Clips");
    importMediaAsset(e, asset("in", folderId));
    importMediaAsset(e, asset("out"));
    expect(assetsIn(e, folderId).map((a) => a.name)).toEqual(["in"]);
    expect(assetsIn(e, undefined).map((a) => a.name)).toEqual(["out"]);
  });

  it("importFinderItemsMirrorsFolderTree", async () => {
    const e = makeEditor();
    io.addFile("/import/Root/root.mp4");
    io.addFile("/import/Root/Nested/child.wav");
    io.addFile("/import/Root/Nested/ignored.txt");
    const summary = await importFinderItems(e, ["/import/Root"], undefined, { finalize: false });
    expect(summary.assetCount).toBe(2);
    expect(summary.folderCount).toBe(2);
    const rootFolder = folders(e).find((f) => f.name === "Root");
    const nestedFolder = folders(e).find((f) => f.name === "Nested");
    expect(nestedFolder?.parentFolderId).toBe(rootFolder?.id);
    expect(assetsIn(e, rootFolder?.id).map((a) => a.name)).toEqual(["root"]);
    expect(assetsIn(e, nestedFolder?.id).map((a) => a.name)).toEqual(["child"]);
    expect(e.doc.mediaManifest.entries.map((x) => x.name).sort()).toEqual(["child", "root"]);
  });

  it("importFinderItemsDoesNotCreateRootFolderWhenDirectoryCannotBeRead", async () => {
    const e = makeEditor();
    io.addDir("/import/denied");
    io.denyList("/import/denied");
    const summary = await importFinderItems(e, ["/import/denied"], undefined, { finalize: false });
    expect(summary.assetCount).toBe(0);
    expect(summary.folderCount).toBe(0);
    expect(folders(e)).toEqual([]);
  });

  it("importFinderItems is one undo step and undo removes assets and folders", async () => {
    const e = makeEditor();
    io.addFile("/import/Dir/a.mp4");
    io.addFile("/import/Dir/b.png");
    await importFinderItems(e, ["/import/Dir"], undefined, { finalize: false });
    expect(e.store.undoActionName).toBe("Import Media");
    e.undo();
    expect(e.mediaAssets).toEqual([]);
    expect(folders(e)).toEqual([]);
    expect(e.doc.mediaManifest.entries).toEqual([]);
  });

  it("importFinderItems imports into the given folder, hides dotfiles and toasts unsupported root files", async () => {
    const e = makeEditor();
    const target = createFolder(e, "Target");
    io.addFile("/import/clip.mov");
    io.addFile("/import/notes.txt");
    io.addFile("/import/Dir/.hidden.mp4");
    io.addFile("/import/Dir/shown.mp3");
    const summary = await importFinderItems(e, ["/import/clip.mov", "/import/notes.txt", "/import/Dir"], target, { finalize: false });
    expect(summary.assetCount).toBe(2);
    expect(assetsIn(e, target).map((a) => a.name)).toEqual(["clip"]);
    expect(e.ui.toast?.message).toBe(`Can't import "notes.txt" — unsupported file type.`);
  });

  it("imports nothing and records nothing for an unsupported-only drop", async () => {
    const e = makeEditor();
    io.addFile("/import/a.txt");
    const summary = await importFinderItems(e, ["/import/a.txt"], undefined, { finalize: false });
    expect(summary.assetCount).toBe(0);
    expect(e.store.canUndo).toBe(false);
  });

  it("refuses a .json that is not a Lottie animation", async () => {
    const e = makeEditor();
    io.addFile("/import/data.json", '{"hello":1}');
    io.addFile("/import/anim.json", '{"v":"5","w":1,"h":1,"op":1,"layers":[]}');
    const summary = await importFinderItems(e, ["/import/data.json", "/import/anim.json"], undefined, { finalize: false });
    expect(summary.assets.map((a) => a.name)).toEqual(["anim"]);
    expect(e.ui.toast?.message).toBe(`Can't import "data.json" — not a Lottie animation.`);
  });
});

describe("AudioImport", () => {
  it("importsAifcFromFolder", async () => {
    const e = makeEditor();
    io.addFile("/import/aifc/voice.aifc");
    const summary = await importFinderItems(e, ["/import/aifc"], undefined, { finalize: false });
    expect(summary.assetCount).toBe(1);
    const imported = e.mediaAssets.find((a) => a.name === "voice");
    expect(imported?.type).toBe("audio");
  });
});

describe("EditorViewModel — deleteFolders", () => {
  it("deleteCascadesIntoDescendants", () => {
    const e = makeEditor();
    const parent = createFolder(e, "Parent");
    const child = createFolder(e, "Child", parent);
    const grand = createFolder(e, "Grand", child);
    deleteFolders(e, new Set([parent]));
    expect(folder(e, parent)).toBeUndefined();
    expect(folder(e, child)).toBeUndefined();
    expect(folder(e, grand)).toBeUndefined();
  });

  it("deleteRemovesAssetsAndReferencingClips", () => {
    const e = makeEditor();
    const trash = createFolder(e, "Trash");
    const a = asset("doomed", trash);
    importMediaAsset(e, a);
    e.perform("setup", () => {
      e.timeline.tracks = [fixtureVideoTrack({ clips: [fixtureClip({ id: "c1", mediaRef: a.id, start: 0, duration: 30 })] })];
    });
    deleteFolders(e, new Set([trash]));
    expect(e.mediaAssets.some((x) => x.id === a.id)).toBe(false);
    expect(e.doc.mediaManifest.entries.some((x) => x.id === a.id)).toBe(false);
    expect(e.timeline.tracks.flatMap((t) => t.clips).some((c) => c.id === "c1")).toBe(false);
    expect(e.timeline.tracks).toEqual([]); // emptied track is pruned
    expect(e.store.undoActionName).toBe("Delete Folder");
    e.undo();
    expect(e.mediaAssets.some((x) => x.id === a.id)).toBe(true);
    expect(e.timeline.tracks.flatMap((t) => t.clips).map((c) => c.id)).toEqual(["c1"]);
    expect(folder(e, trash)).toBeDefined();
  });

  it("deleteSubtractsFromSelectedFolderIds", () => {
    const e = makeEditor();
    const a = createFolder(e, "A");
    const b = createFolder(e, "B");
    e.ui.selectedFolderIds = new Set([a, b]);
    deleteFolders(e, new Set([a]));
    expect([...e.ui.selectedFolderIds]).toEqual([b]);
  });

  it("deleteEmptySetIsNoOp", () => {
    const e = makeEditor();
    createFolder(e, "Keep");
    const before = folders(e).length;
    deleteFolders(e, new Set());
    expect(folders(e).length).toBe(before);
  });

  it("reparents timelines to the root instead of deleting them", () => {
    const e = makeEditor();
    const f = createFolder(e, "F");
    moveTimelinesToFolder(e, new Set([e.timeline.id]), f);
    expect(e.timeline.folderId).toBe(f);
    deleteFolders(e, new Set([f]));
    expect(e.timelines.length).toBe(1);
    expect(e.timeline.folderId).toBeUndefined();
  });
});

describe("EditorViewModel — moveAssetsToFolder & moveFoldersToFolder", () => {
  it("moveAssetsUpdatesAssetAndManifestEntry", () => {
    const e = makeEditor();
    const dest = createFolder(e, "Dest");
    const a = asset("x");
    importMediaAsset(e, a);
    moveAssetsToFolder(e, new Set([a.id]), dest);
    expect(e.mediaAssets.find((x) => x.id === a.id)?.folderId).toBe(dest);
    expect(e.doc.mediaManifest.entries.find((x) => x.id === a.id)?.folderId).toBe(dest);
    expect(e.store.undoActionName).toBe("Move to Folder");
    e.undo();
    expect(e.mediaAssets.find((x) => x.id === a.id)?.folderId).toBeUndefined();
    expect(e.doc.mediaManifest.entries.find((x) => x.id === a.id)?.folderId).toBeUndefined();
  });

  it("moveFoldersRejectsCycleIntoOwnDescendant", () => {
    const e = makeEditor();
    const parent = createFolder(e, "Parent");
    const child = createFolder(e, "Child", parent);
    moveFoldersToFolder(e, new Set([parent]), child);
    expect(folder(e, parent)?.parentFolderId).toBeUndefined();
    expect(folder(e, child)?.parentFolderId).toBe(parent);
  });

  it("moveFoldersRejectsSelfParent", () => {
    const e = makeEditor();
    const f = createFolder(e, "Solo");
    moveFoldersToFolder(e, new Set([f]), f);
    expect(folder(e, f)?.parentFolderId).toBeUndefined();
  });

  it("moveAssetsToNilReparentsToRoot", () => {
    const e = makeEditor();
    const f = createFolder(e, "Box");
    const a = asset("x", f);
    importMediaAsset(e, a);
    moveAssetsToFolder(e, new Set([a.id]), undefined);
    expect(e.mediaAssets.find((x) => x.id === a.id)?.folderId).toBeUndefined();
    expect(e.doc.mediaManifest.entries.find((x) => x.id === a.id)?.folderId).toBeUndefined();
  });

  it("moving folders is one undoable Move Folder; no-op moves record nothing", () => {
    const e = makeEditor();
    const a = createFolder(e, "A");
    const b = createFolder(e, "B");
    moveFoldersToFolder(e, new Set([a]), undefined);
    expect(e.store.undoActionName).toBe("New Folder");
    moveFoldersToFolder(e, new Set([a]), b);
    expect(e.store.undoActionName).toBe("Move Folder");
    e.undo();
    expect(folder(e, a)?.parentFolderId).toBeUndefined();
  });
});

describe("EditorViewModel — folder edge cases", () => {
  it("folderPathTerminatesOnCycle", () => {
    const e = makeEditor();
    e.withoutRegistration(() => {
      e.doc.mediaManifest.folders = [
        makeMediaFolder({ id: "A", name: "A", parentFolderId: "B" }),
        makeMediaFolder({ id: "B", name: "B", parentFolderId: "A" }),
      ];
    });
    const path = folderPath(e, "A");
    expect(new Set(path.map((f) => f.id))).toEqual(new Set(["A", "B"]));
    expect(path.length).toBe(2);
  });

  it("deleteHandlesOverlappingAncestorAndDescendant", () => {
    const e = makeEditor();
    const parent = createFolder(e, "Parent");
    const child = createFolder(e, "Child", parent);
    const other = createFolder(e, "Other");
    deleteFolders(e, new Set([parent, child]));
    expect(folder(e, parent)).toBeUndefined();
    expect(folder(e, child)).toBeUndefined();
    expect(folder(e, other)).toBeDefined();
  });

  it("deleteSubtractsFromSelectedMediaAssetIds", () => {
    const e = makeEditor();
    const f = createFolder(e, "Doomed");
    const inside = asset("in", f);
    const outside = asset("out");
    importMediaAsset(e, inside);
    importMediaAsset(e, outside);
    e.ui.selectedMediaAssetIds = new Set([inside.id, outside.id]);
    deleteFolders(e, new Set([f]));
    expect([...e.ui.selectedMediaAssetIds]).toEqual([outside.id]);
  });

  it("renameFolderIgnoresUnknownId", () => {
    const e = makeEditor();
    const real = createFolder(e, "Real");
    const before = folders(e).length;
    renameFolder(e, "not-a-real-id", "Whatever");
    expect(folders(e).length).toBe(before);
    expect(folder(e, real)?.name).toBe("Real");
  });

  it("renameFolder is undoable and ignores an unchanged name", () => {
    const e = makeEditor();
    const f = createFolder(e, "Old");
    renameFolder(e, f, "Old");
    expect(e.store.undoActionName).toBe("New Folder");
    renameFolder(e, f, "New");
    expect(e.store.undoActionName).toBe("Rename Folder");
    e.undo();
    expect(folder(e, f)?.name).toBe("Old");
  });

  it("createFolder is undoable as New Folder", () => {
    const e = makeEditor();
    const f = createFolder(e, "X");
    expect(e.store.undoActionName).toBe("New Folder");
    e.undo();
    expect(folder(e, f)).toBeUndefined();
    e.redo();
    expect(folder(e, f)).toBeDefined();
  });
});

describe("media assets", () => {
  it("importMediaAsset ignores duplicate ids and is not undoable", () => {
    const e = makeEditor();
    const a = asset("one");
    importMediaAsset(e, a);
    importMediaAsset(e, a);
    expect(e.mediaAssets.length).toBe(1);
    expect(e.doc.mediaManifest.entries.length).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("manifest entries use project-relative sources inside the project and external ones elsewhere", () => {
    const e = makeEditor();
    e.projectPath = "C:/Projects/My.palmier";
    importMediaAsset(e, makeMediaAsset({ url: "C:/Projects/My.palmier/media/a.png", type: "image", name: "a" }));
    importMediaAsset(e, makeMediaAsset({ url: "D:/Footage/b.mp4", type: "video", name: "b" }));
    const [inside, outside] = e.doc.mediaManifest.entries;
    expect(inside.source).toEqual({ project: { relativePath: "media/a.png" } });
    expect(outside.source).toEqual({ external: { absolutePath: "D:/Footage/b.mp4" } });
  });

  it("addMediaAssetOfType names the asset after the file stem and records the folder", () => {
    const e = makeEditor();
    const f = createFolder(e, "F");
    const a = addMediaAssetOfType(e, "C:\\media\\take.01.mov", "video", { folderId: f, finalize: false });
    expect(a.name).toBe("take.01");
    expect(e.mediaAsset(a.id)?.folderId).toBe(f);
    expect(a.hasAudio).toBe(true);
  });

  it("renameMediaAsset updates the asset and manifest, undoably", () => {
    const e = makeEditor();
    const a = asset("old");
    importMediaAsset(e, a);
    renameMediaAsset(e, a.id, "new");
    expect(e.mediaAsset(a.id)?.name).toBe("new");
    expect(e.doc.mediaManifest.entries[0].name).toBe("new");
    expect(e.store.undoActionName).toBe("Rename Asset");
    e.undo();
    expect(e.mediaAsset(a.id)?.name).toBe("old");
    expect(e.doc.mediaManifest.entries[0].name).toBe("old");
    renameMediaAsset(e, "missing", "x");
  });

  it("deleteMediaAssets removes assets, entries and referencing clips as one undo step, clearing asset selection", () => {
    const keep = asset("keep");
    const gone = asset("gone");
    const e = makeEditor([
      fixtureVideoTrack({
        clips: [
          fixtureClip({ id: "k", mediaRef: keep.id, start: 0, duration: 10 }),
          fixtureClip({ id: "g", mediaRef: gone.id, start: 10, duration: 10 }),
        ],
      }),
      fixtureVideoTrack({ clips: [fixtureClip({ id: "g2", mediaRef: gone.id, start: 0, duration: 5 })] }),
    ]);
    importMediaAsset(e, keep);
    importMediaAsset(e, gone);
    e.ui.selectedMediaAssetIds = new Set([keep.id, gone.id]);
    e.ui.selectedClipIds = new Set(["k", "g"]);
    deleteMediaAssets(e, new Set([gone.id]));
    expect(e.mediaAssets.map((a) => a.id)).toEqual([keep.id]);
    expect(e.doc.mediaManifest.entries.map((x) => x.id)).toEqual([keep.id]);
    expect(e.timeline.tracks.length).toBe(1);
    expect(e.timeline.tracks[0].clips.map((c) => c.id)).toEqual(["k"]);
    expect(e.ui.selectedMediaAssetIds.size).toBe(0);
    expect([...e.ui.selectedClipIds]).toEqual(["k"]);
    expect(e.store.undoActionName).toBe("Delete Media");
    e.undo();
    expect(e.mediaAssets.length).toBe(2);
    expect(e.timeline.tracks.length).toBe(2);
  });

  it("deleteMediaAssets with unknown ids does nothing", () => {
    const e = makeEditor();
    importMediaAsset(e, asset("a"));
    deleteMediaAssets(e, new Set(["nope"]));
    deleteMediaAssets(e, new Set());
    expect(e.mediaAssets.length).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("dropPlaceholderAssetsSkipFoldersAndUnsupportedTypes", () => {
    const placeholders = dropPlaceholderAssets(["/tmp/a.mp4", "/tmp/b.txt", "/tmp/folder/"]);
    expect(placeholders.map((a) => a.name)).toEqual(["a"]);
    expect(placeholders[0].type).toBe("video");
    expect(placeholders[0].duration).toBe(5);
    expect(placeholders[0].hasAudio).toBe(true);
  });

  it("clipDisplayLabel: text, generating, sequence, manifest name, Offline", () => {
    const e = makeEditor();
    const a = asset("Interview");
    importMediaAsset(e, a);
    const label = (p: Parameters<typeof fixtureClip>[0] & { text?: string; type?: "text" | "sequence" }) => {
      const c = fixtureClip(p);
      if (p.type) {
        c.mediaType = p.type;
        c.sourceClipType = p.type;
      }
      if (p.text !== undefined) c.textContent = p.text;
      return clipDisplayLabel(e, c);
    };
    expect(label({ start: 0, duration: 1, type: "text", text: "a\nb\r\nc" })).toBe("a b  c");
    expect(label({ start: 0, duration: 1, type: "text", text: "" })).toBe("Text");
    expect(label({ start: 0, duration: 1, mediaRef: a.id })).toBe("Interview");
    expect(label({ start: 0, duration: 1, mediaRef: "ghost" })).toBe("Offline");
    expect(label({ start: 0, duration: 1, type: "sequence", mediaRef: e.timeline.id })).toBe(e.timeline.name);
  });
});

describe("ManifestMetadataTests", () => {
  const video = (id: string): MediaAsset => makeMediaAsset({ id, url: `/tmp/${id}.mp4`, type: "video", name: id, duration: 1 });

  it("largeBatchUpdatesInPlace", () => {
    const e = makeEditor();
    const assets = Array.from({ length: 1000 }, (_, i) => video(`asset-${i}`));
    updateManifestMetadata(e, assets);
    const changed = assets.map((a, i) => ({ ...a, duration: i }));
    updateManifestMetadata(e, changed.reverse());
    expect(e.doc.mediaManifest.entries.length).toBe(1000);
    expect(e.doc.mediaManifest.entries[731].duration).toBe(731);
  });

  it("queuedFlushUsesLatestLiveAssets", () => {
    const e = makeEditor();
    const renamed = video("renamed");
    const deleted = video("deleted");
    importMediaAsset(e, renamed);
    importMediaAsset(e, deleted);
    queueManifestMetadataUpdate(e, renamed.id);
    queueManifestMetadataUpdate(e, deleted.id);
    e.withoutRegistration(() => {
      const live = e.doc.mediaAssets.find((a) => a.id === renamed.id);
      if (live) live.name = "Latest";
      e.doc.mediaAssets = e.doc.mediaAssets.filter((a) => a.id !== deleted.id);
      e.doc.mediaManifest.entries = e.doc.mediaManifest.entries.filter((x) => x.id !== deleted.id);
    });
    flushPendingManifestMetadataUpdates(e);
    expect(e.doc.mediaManifest.entries.map((x) => x.name)).toEqual(["Latest"]);
  });

  it("metadata hydration is not undoable and reaches the manifest", () => {
    const e = makeEditor();
    const a = video("a");
    importMediaAsset(e, a);
    const probe: MediaProbe = {
      ok: true, kind: "video", duration: 12.5, width: 1080, height: 1920, fps: 29.97, hasAudio: false, hasVideo: true, canDecode: true,
    };
    e.withoutRegistration(() => {
      const draft = e.doc.mediaAssets[0];
      applyProbeToAsset(draft, probe);
    });
    updateManifestMetadata(e, e.mediaAssets);
    const entry = e.doc.mediaManifest.entries[0];
    expect([entry.duration, entry.sourceWidth, entry.sourceHeight, entry.sourceFPS, entry.hasAudio]).toEqual([12.5, 1080, 1920, 29.97, false]);
    expect(e.store.canUndo).toBe(false);
  });
});

describe("applyProbeToAsset", () => {
  const base = { hasAudio: false, hasVideo: true, canDecode: true };
  it("images get the default still duration and pixel size", () => {
    const a = makeMediaAsset({ url: "/a.png", type: "image", name: "a" });
    applyProbeToAsset(a, { ...base, ok: true, kind: "image", width: 640, height: 480 });
    expect([a.duration, a.sourceWidth, a.sourceHeight]).toEqual([5, 640, 480]);
  });

  it("a video that could not be opened leaves hasAudio untouched", () => {
    const a = makeMediaAsset({ url: "/a.mp4", type: "video", name: "a" });
    applyProbeToAsset(a, { ok: false, kind: "video", hasAudio: false, hasVideo: false, canDecode: false, reason: "x" });
    expect(a.hasAudio).toBe(true);
    expect(a.duration).toBe(0);
  });

  it("audio and subtitle take the probed duration", () => {
    const au = makeMediaAsset({ url: "/a.mp3", type: "audio", name: "a" });
    applyProbeToAsset(au, { ...base, ok: true, kind: "audio", duration: 3.25 });
    expect(au.duration).toBe(3.25);
    const sub = makeMediaAsset({ url: "/a.srt", type: "subtitle", name: "a" });
    applyProbeToAsset(sub, { ...base, ok: true, kind: "subtitle", duration: 9 });
    expect(sub.duration).toBe(9);
  });
});

describe("missing / offline detection and relink", () => {
  it("findMissingAssetIds checks expected paths, project-relative ones against the project", async () => {
    io.addFile("D:/Footage/there.mp4");
    io.addFile("C:/P.palmier/media/inside.png");
    const e = makeEditor();
    e.projectPath = "C:/P.palmier";
    importMediaAsset(e, makeMediaAsset({ id: "ext-ok", url: "D:/Footage/there.mp4", type: "video", name: "1" }));
    importMediaAsset(e, makeMediaAsset({ id: "ext-gone", url: "D:/Footage/gone.mp4", type: "video", name: "2" }));
    importMediaAsset(e, makeMediaAsset({ id: "in-ok", url: "C:/P.palmier/media/inside.png", type: "image", name: "3" }));
    importMediaAsset(e, makeMediaAsset({ id: "in-gone", url: "C:/P.palmier/media/gone.png", type: "image", name: "4" }));
    const missing = await findMissingAssetIds(e.doc.mediaManifest.entries, "C:/P.palmier");
    expect([...(missing ?? [])].sort()).toEqual(["ext-gone", "in-gone"]);
  });

  it("refreshMissingMediaCache publishes missing refs and isMediaOffline reflects them", async () => {
    io.addFile("/m/ok.mp4");
    const e = makeEditor();
    importMediaAsset(e, makeMediaAsset({ id: "ok", url: "/m/ok.mp4", type: "video", name: "ok" }));
    importMediaAsset(e, makeMediaAsset({ id: "gone", url: "/m/gone.mp4", type: "video", name: "gone" }));
    await refreshMissingMediaCache(e);
    expect([...e.ui.missingMediaRefs]).toEqual(["gone"]);
    expect(isMediaOffline(e, "gone")).toBe(true);
    expect(isMediaOffline(e, "ok")).toBe(false);
  });

  it("generating assets are never reported missing", async () => {
    const e = makeEditor();
    const a = makeMediaAsset({ id: "gen", url: "/m/pending.mp4", type: "video", name: "gen" });
    a.generationStatus = { kind: "generating" };
    importMediaAsset(e, a);
    await refreshMissingMediaCache(e);
    expect(e.ui.missingMediaRefs.size).toBe(0);
  });

  it("unprocessable is offline but only 'unprocessable' while the file is present", () => {
    const e = makeEditor();
    setUnprocessableMediaRef(e, "x", true);
    expect(isMediaOffline(e, "x")).toBe(true);
    expect(isMediaUnprocessable(e, "x")).toBe(true);
    e.ui.missingMediaRefs = new Set(["x"]);
    expect(isMediaUnprocessable(e, "x")).toBe(false);
    setUnprocessableMediaRef(e, "x", false);
    e.ui.missingMediaRefs = new Set();
    expect(isMediaOffline(e, "x")).toBe(false);
  });

  it("relinkAsset refuses a different media type with a toast and changes nothing", () => {
    const e = makeEditor();
    const a = asset("v");
    importMediaAsset(e, a);
    relinkAsset(e, a.id, "/new/song.mp3");
    expect(e.mediaAsset(a.id)?.url).toBe(a.url);
    expect(e.ui.toast?.message).toBe(`Can't relink "song.mp3". Required media type: Video. Selected media type: Audio.`);
  });

  it("relinkAsset repoints the asset and its manifest source without an undo entry", () => {
    const e = makeEditor();
    const a = makeMediaAsset({ id: "r", url: "/old/clip.mp4", type: "video", name: "clip" });
    importMediaAsset(e, a);
    relinkAsset(e, "r", "/new/place/clip.mp4");
    expect(e.mediaAsset("r")?.url).toBe("/new/place/clip.mp4");
    expect(e.doc.mediaManifest.entries[0].source).toEqual({ external: { absolutePath: "/new/place/clip.mp4" } });
    expect(e.store.canUndo).toBe(false);
  });

  it("relinkOfflineAssets matches by lowercased filename, recursively, first match wins", async () => {
    io.addFile("/lib/a/Clip.MP4");
    io.addFile("/lib/b/deep/clip.mp4");
    io.addFile("/lib/b/other.mp3");
    const e = makeEditor();
    importMediaAsset(e, makeMediaAsset({ id: "1", url: "/old/clip.mp4", type: "video", name: "clip" }));
    importMediaAsset(e, makeMediaAsset({ id: "2", url: "/old/other.mp3", type: "audio", name: "other" }));
    importMediaAsset(e, makeMediaAsset({ id: "3", url: "/old/absent.mov", type: "video", name: "absent" }));
    e.ui.missingMediaRefs = new Set(["1", "2", "3"]);
    const summary = await relinkOfflineAssets(e, "/lib");
    expect(summary).toEqual({ relinked: 2, total: 3 });
    expect(e.mediaAsset("1")?.url).toBe("/lib/a/Clip.MP4");
    expect(e.mediaAsset("2")?.url).toBe("/lib/b/other.mp3");
    expect(e.mediaAsset("3")?.url).toBe("/old/absent.mov");
    expect(await relinkOfflineAssets(makeEditor(), "/lib")).toEqual({ relinked: 0, total: 0 });
  });
});

describe("MediaPanelItemKey", () => {
  it("round-trips and rejects foreign prefixes", () => {
    expect(mediaPanelFolderIdFromKey(mediaPanelFolderKey("abc"))).toBe("abc");
    expect(mediaPanelTimelineIdFromKey(mediaPanelTimelineKey("t1"))).toBe("t1");
    expect(mediaPanelFolderIdFromKey("timeline-x")).toBeUndefined();
    expect(mediaPanelTimelineIdFromKey("folder-x")).toBeUndefined();
  });
});
