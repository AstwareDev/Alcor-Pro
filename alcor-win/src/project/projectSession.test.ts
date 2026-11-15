import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeExternalSource, makeMediaAsset, makeMediaManifest, makeMediaManifestEntry, makeProjectSource, mediaAssetToManifestEntry,
  type MediaManifestEntry,
} from "../model";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { MemoryFileSystem } from "./memoryFileSystem";
import { readProjectPackage } from "./projectPackage";
import { ProjectRegistry } from "./projectRegistry";
import {
  closeProject, isProjectOpen, newProject, openProject, projectSession, saveProject, saveProjectAs, snapshotForSave,
  uniqueProjectName, type ProjectDeps,
} from "./projectSession";

const dir = "D:/Docs/Palmier Pro";

async function setup(): Promise<{ fs: MemoryFileSystem; registry: ProjectRegistry; deps: ProjectDeps }> {
  const fs = new MemoryFileSystem();
  const registry = new ProjectRegistry({ fs, directory: dir });
  await registry.load();
  return { fs, registry, deps: { fs, registry, projectsDirectory: dir, autosaveDebounceMs: 1000 } };
}

const rename = (editor: Awaited<ReturnType<typeof newProject>>, name: string) =>
  editor.perform("Rename", () => { editor.timeline.name = name; });

describe("newProject", () => {
  it("createsPackageWithTimelineManifestAndMediaDirectory", async () => {
    const { fs, registry, deps } = await setup();
    const editor = await newProject(undefined, deps);
    const path = `${dir}/Untitled Project.palmier`;

    expect(editor.projectPath).toBe(path);
    expect(fs.has(`${path}/project.json`)).toBe(true);
    expect(fs.has(`${path}/media.json`)).toBe(true);
    expect(await fs.isDirectory(`${path}/media`)).toBe(true);
    expect(registry.entries().map((e) => e.path)).toEqual([path]);
    expect(projectSession(editor).dirty()).toBe(false);
  });

  it("usesTheNextFreeUntitledName", async () => {
    const { deps } = await setup();
    const a = await newProject(undefined, deps);
    const b = await newProject(undefined, deps);
    const c = await newProject("  ", deps);
    expect([a, b, c].map((e) => e.projectPath)).toEqual([
      `${dir}/Untitled Project.palmier`,
      `${dir}/Untitled Project 2.palmier`,
      `${dir}/Untitled Project 3.palmier`,
    ]);
  });

  it("uniqueProjectNameSkipsExistingNamesOnly", async () => {
    const { fs } = await setup();
    fs.seedDir(`${dir}/Untitled Project 2.palmier`);
    expect(await uniqueProjectName(dir, fs)).toBe("Untitled Project");
    fs.seedDir(`${dir}/Untitled Project.palmier`);
    expect(await uniqueProjectName(dir, fs)).toBe("Untitled Project 3");
  });

  it("explicitNameIsUsedTrimmed", async () => {
    const { deps } = await setup();
    const editor = await newProject("  My Film ", deps);
    expect(editor.projectPath).toBe(`${dir}/My Film.palmier`);
  });

  it("explicitTakenNameIsRejected", async () => {
    const { deps } = await setup();
    await newProject("Film", deps);
    await expect(newProject("Film", deps)).rejects.toMatchObject({ kind: "nameTaken" });
  });

  it.each(["a/b", "a\\b", "..", ".", "a:b", "what?"])("invalidName %s is rejected", async (name) => {
    const { deps } = await setup();
    await expect(newProject(name, deps)).rejects.toMatchObject({ kind: "invalidName" });
  });

  it("failedFirstSaveRemovesThePackageAndRegistersNothing", async () => {
    const { fs, registry, deps } = await setup();
    fs.before = (op, path) => {
      if (op === "writeText" && path.endsWith("project.json")) throw new Error("disk full");
    };
    await expect(newProject("Film", deps)).rejects.toThrow("disk full");
    expect(fs.has(`${dir}/Film.palmier`)).toBe(false);
    expect(registry.entries()).toEqual([]);
    expect(isProjectOpen(`${dir}/Film.palmier`)).toBe(false);
  });
});

describe("openProject", () => {
  it("roundTripsEditsThroughSaveAndReopen", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    rename(editor, "Main cut");
    editor.liveViewStates[editor.doc.activeTimelineId] = { playheadFrame: 0, zoomScale: 1, scrollOffsetX: 0 };
    editor.ui.currentFrame = 0;
    editor.ui.zoomScale = 7.5;
    editor.ui.timelineScrollOffsetX = 120;
    await saveProject(editor);
    const path = editor.projectPath ?? "";
    await closeProject(editor);

    const reopened = await openProject(path, deps);
    expect(reopened).not.toBe(editor);
    expect(reopened.timeline.name).toBe("Main cut");
    expect(reopened.ui.zoomScale).toBe(7.5);
    expect(reopened.ui.timelineScrollOffsetX).toBe(120);
    expect(projectSession(reopened).dirty()).toBe(false);
    await closeProject(reopened);
  });

  it("legacyBareTimelineProjectOpens", async () => {
    const { fs, deps } = await setup();
    const timeline = fixtureTimeline({ fps: 24, tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 10 })] })] });
    fs.seedText("D:/Old.palmier/project.json", JSON.stringify(timeline));
    const editor = await openProject("D:/Old.palmier", deps);
    expect(editor.timeline.fps).toBe(24);
    expect(editor.doc.openTimelineIds).toEqual([timeline.id]);
    await closeProject(editor);
  });

  it("rebuildsMediaAssetsFromManifestAndFlagsMissingFiles", async () => {
    const { fs, deps } = await setup();
    const entries: MediaManifestEntry[] = [
      makeMediaManifestEntry({ id: "in", name: "In", type: "video", source: makeProjectSource("media/in.mp4"), duration: 2 }),
      makeMediaManifestEntry({ id: "gone", name: "Gone", type: "video", source: makeProjectSource("media/gone.mp4"), duration: 2 }),
      makeMediaManifestEntry({ id: "ext", name: "Ext", type: "image", source: makeExternalSource("E:/pics/a.png"), duration: 5 }),
    ];
    fs.seedText("D:/P.palmier/project.json", JSON.stringify({ timelines: [fixtureTimeline()] }));
    fs.seedText("D:/P.palmier/media.json", JSON.stringify(makeMediaManifest({ entries })));
    fs.seedBytes("D:/P.palmier/media/in.mp4", new Uint8Array([1]));
    fs.seedBytes("E:/pics/a.png", new Uint8Array([1]));

    const editor = await openProject("D:/P.palmier", deps);

    expect(editor.mediaAssets.map((a) => [a.id, a.url])).toEqual([
      ["in", "D:/P.palmier/media/in.mp4"],
      ["gone", "D:/P.palmier/media/gone.mp4"],
      ["ext", "E:/pics/a.png"],
    ]);
    expect([...editor.ui.missingMediaRefs]).toEqual(["gone"]);
    await closeProject(editor);
  });

  it("interruptedImportIsMarkedFailedAndPersistedInTheManifest", async () => {
    const { fs, deps } = await setup();
    const entry = makeMediaManifestEntry({
      id: "imp", name: "Imp", type: "video", source: makeProjectSource("media/imp.mp4"), duration: 1,
      importInput: { sourcePath: "E:/src.mp4" }, generationStatus: "preparing",
    });
    fs.seedText("D:/P.palmier/project.json", JSON.stringify({ timelines: [fixtureTimeline()] }));
    fs.seedText("D:/P.palmier/media.json", JSON.stringify(makeMediaManifest({ entries: [entry] })));

    const editor = await openProject("D:/P.palmier", deps);

    expect(editor.mediaAsset("imp")?.generationStatus).toEqual({ kind: "failed", message: "Import interrupted" });
    expect(editor.doc.mediaManifest.entries[0]?.generationStatus).toBe("failed: Import interrupted");
    expect(editor.ui.missingMediaRefs.has("imp")).toBe(false);
    await closeProject(editor);
  });

  it("corruptManifestOpensAndTheOriginalSurvivesSavesUntilLibraryIsRebuilt", async () => {
    const { fs, deps } = await setup();
    fs.seedText("D:/P.palmier/project.json", JSON.stringify({ timelines: [fixtureTimeline()] }));
    fs.seedText("D:/P.palmier/media.json", "{ corrupt ");

    const editor = await openProject("D:/P.palmier", deps);
    await saveProject(editor);
    expect(fs.text("D:/P.palmier/media.json")).toBe("{ corrupt ");

    editor.perform("Add media", () => {
      editor.doc.mediaManifest.entries.push(
        makeMediaManifestEntry({ id: "a", name: "A", type: "video", source: makeProjectSource("media/a.mp4"), duration: 1 }),
      );
    });
    await saveProject(editor);
    expect((await readProjectPackage("D:/P.palmier", fs)).manifest?.entries.length).toBe(1);

    editor.perform("Clear media", () => { editor.doc.mediaManifest.entries.length = 0; });
    await saveProject(editor);
    const reopened = await readProjectPackage("D:/P.palmier", fs);
    expect(reopened.manifest?.entries).toEqual([]);
    expect(reopened.manifestUnreadable).toBe(false);
    await closeProject(editor);
  });

  it("reopeningAnOpenProjectReturnsTheSameEditor", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    expect(await openProject(`${dir}\\Film.palmier`, deps)).toBe(editor);
    expect(isProjectOpen(`${dir}/film.palmier`)).toBe(true);
    await closeProject(editor);
    expect(isProjectOpen(`${dir}/Film.palmier`)).toBe(false);
  });

  it("registersTheProjectAndBumpsLastOpened", async () => {
    const { fs, registry, deps } = await setup();
    fs.seedText("D:/P.palmier/project.json", JSON.stringify({ timelines: [fixtureTimeline()] }));
    const editor = await openProject("D:/P.palmier", deps);
    expect(registry.entries().map((e) => e.path)).toEqual(["D:/P.palmier"]);
    await closeProject(editor);
  });

  it("missingProjectFileRejects", async () => {
    const { deps } = await setup();
    await expect(openProject("D:/Nope.palmier", deps)).rejects.toMatchObject({ kind: "missingTimeline" });
  });
});

describe("snapshotForSave", () => {
  it("stashesLiveViewStateAndPrunesDeletedTimelines", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    editor.liveViewStates["ghost"] = { playheadFrame: 1, zoomScale: 1, scrollOffsetX: 1 };
    editor.ui.zoomScale = 3;
    const file = JSON.parse(snapshotForSave(editor).timeline) as {
      viewStates: Record<string, { zoomScale: number }>;
      speakers?: unknown;
      multicamGroups?: unknown;
    };
    expect(Object.keys(file.viewStates)).toEqual([editor.doc.activeTimelineId]);
    expect(file.viewStates[editor.doc.activeTimelineId]?.zoomScale).toBe(3);
    expect(file.speakers).toBeUndefined();
    expect(file.multicamGroups).toBeUndefined();
    expect(editor.liveViewStates["ghost"]).toBeDefined();
  });

  it("omitsManifestWhenItFailedToLoadAndIsEmpty", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    expect(snapshotForSave(editor, { manifestLoadFailed: true }).manifest).toBeNull();
    expect(snapshotForSave(editor).manifest).not.toBeNull();
  });

  it("writesTheSameKeysTheSwiftAppReads", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    const file = JSON.parse(snapshotForSave(editor).timeline) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["activeTimelineId", "openTimelineIds", "timelines", "viewStates"]);
    const manifest = JSON.parse(snapshotForSave(editor).manifest ?? "{}") as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["entries", "folders", "version"]);
  });
});

describe("saving", () => {
  it("finalFlushPersistsEvenWhenNothingIsMarkedDirty", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    expect(session.dirty()).toBe(false);
    fs.writes.length = 0;
    await session.flush();
    expect(fs.writes).toContain(`${dir}/Film.palmier/project.json`);
  });

  it("dirtyTracksTheDocumentRevision", async () => {
    const { deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    expect(session.dirty()).toBe(false);
    rename(editor, "X");
    expect(session.dirty()).toBe(true);
    await session.save();
    expect(session.dirty()).toBe(false);
    editor.undo();
    expect(session.dirty()).toBe(true);
    session.dispose();
  });

  it("aSaveRequestedWhileOneRunsCoalescesIntoExactlyOneFollowUp", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    const timelineWrites = () => fs.writes.filter((p) => p.endsWith("Film.palmier/project.json")).length;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let hold = true;
    fs.before = async (op, path) => {
      if (hold && op === "writeText" && path.endsWith("project.json")) {
        hold = false;
        await gate;
      }
    };
    const base = timelineWrites();
    rename(editor, "one");
    const first = session.save();
    const others = [session.save(), session.save(), session.save()];
    rename(editor, "two");
    release();
    await Promise.all([first, ...others]);

    expect(timelineWrites() - base).toBe(2);
    expect((JSON.parse(fs.text(`${dir}/Film.palmier/project.json`)) as { timelines: { name: string }[] }).timelines[0]?.name).toBe("two");
    expect(session.dirty()).toBe(false);
    session.dispose();
  });

  it("failedSaveRejectsStaysDirtyAndRecovers", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    rename(editor, "X");
    fs.before = (op) => { if (op === "writeText") throw new Error("disk full"); };
    await expect(session.save()).rejects.toThrow("disk full");
    expect(session.dirty()).toBe(true);
    expect(session.lastError()).toBeInstanceOf(Error);
    fs.before = undefined;
    await session.save();
    expect(session.dirty()).toBe(false);
    expect(session.lastError()).toBeNull();
    session.dispose();
  });

  it("flushWaitsForTheInFlightSaveAndCoversEditsMadeDuringIt", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let hold = true;
    fs.before = async (op, path) => {
      if (hold && op === "writeText" && path.endsWith("project.json")) {
        hold = false;
        await gate;
      }
    };
    rename(editor, "one");
    const running = session.save();
    let flushed = false;
    const flush = session.flush().then(() => { flushed = true; });
    rename(editor, "late");
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await running;
    await flush;
    expect((JSON.parse(fs.text(`${dir}/Film.palmier/project.json`)) as { timelines: { name: string }[] }).timelines[0]?.name).toBe("late");
    expect(session.dirty()).toBe(false);
    session.dispose();
  });

  it("flushFailureRejects", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    fs.before = (op) => { if (op === "writeText") throw new Error("disk full"); };
    await expect(projectSession(editor).flush()).rejects.toThrow("disk full");
    projectSession(editor).dispose();
  });
});

describe("autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("savesAfterTheQuietPeriodAndDebouncesFurtherEdits", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    fs.writes.length = 0;

    rename(editor, "a");
    await vi.advanceTimersByTimeAsync(800);
    rename(editor, "b");
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);

    expect(fs.writes.filter((p) => p.endsWith("project.json"))).toHaveLength(1);
    expect(session.dirty()).toBe(false);
    session.dispose();
  });

  it("doesNotFireWhenClean", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    fs.writes.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fs.writes).toEqual([]);
    projectSession(editor).dispose();
  });

  it("doesNotFireWhenTheEditWasUndoneBeforeSaving", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    rename(editor, "a");
    const session = projectSession(editor);
    await session.save();
    fs.writes.length = 0;
    rename(editor, "b");
    await session.save();
    fs.writes.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fs.writes).toEqual([]);
    session.dispose();
  });

  it("checkpointRequestSavesOnTheNextTickWithoutWaitingForTheQuietPeriod", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    fs.writes.length = 0;
    session.setThumbnail(new Uint8Array([7, 7]));
    session.requestCheckpoint();
    await vi.advanceTimersByTimeAsync(1);
    expect([...fs.bytes(`${dir}/Film.palmier/thumbnail.jpg`)]).toEqual([7, 7]);
    expect(session.dirty()).toBe(false);
    session.dispose();
  });

  it("autosaveFailureDoesNotThrowAndRetriesOnTheNextEdit", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.before = (op) => { if (op === "writeText") throw new Error("disk full"); };
    rename(editor, "a");
    await vi.advanceTimersByTimeAsync(1500);
    expect(log).toHaveBeenCalled();
    expect(session.dirty()).toBe(true);
    fs.before = undefined;
    const writes = fs.writes.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fs.writes.length).toBe(writes);
    rename(editor, "b");
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.dirty()).toBe(false);
    log.mockRestore();
    session.dispose();
  });

  it("noAutosaveAfterDispose", async () => {
    const { fs, deps } = await setup();
    const editor = await newProject("Film", deps);
    const session = projectSession(editor);
    rename(editor, "a");
    session.dispose();
    fs.writes.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fs.writes).toEqual([]);
  });
});

describe("saveProjectAs", () => {
  it("copiesMediaRepointsAssetsAndUpdatesTheRegistry", async () => {
    const { fs, registry, deps } = await setup();
    const editor = await newProject("Film", deps);
    const source = editor.projectPath ?? "";
    fs.seedBytes(`${source}/media/a.mp4`, new Uint8Array([1, 2]));
    fs.seedText(`${source}/notes.txt`, "unknown file");
    const asset = makeMediaAsset({ id: "a", url: `${source}/media/a.mp4`, type: "video", name: "A", duration: 1 });
    editor.perform("Import", () => {
      editor.doc.mediaAssets.push(asset);
      editor.doc.mediaManifest.entries.push(mediaAssetToManifestEntry(asset, source));
    });
    await saveProject(editor);

    const dest = `${dir}/Film Copy.palmier`;
    await saveProjectAs(editor, dest);

    expect([...fs.bytes(`${dest}/media/a.mp4`)]).toEqual([1, 2]);
    expect(fs.text(`${dest}/notes.txt`)).toBe("unknown file");
    expect(fs.has(`${source}/media/a.mp4`)).toBe(true);
    expect(editor.projectPath).toBe(dest);
    expect(editor.mediaAsset("a")?.url).toBe(`${dest}/media/a.mp4`);
    expect(registry.entries().map((e) => e.path)).toEqual([dest]);
    expect(isProjectOpen(dest)).toBe(true);
    expect(isProjectOpen(source)).toBe(false);
    expect(projectSession(editor).dirty()).toBe(false);

    const reopened = await readProjectPackage(dest, fs);
    expect(reopened.manifest?.entries[0]?.source).toEqual({ project: { relativePath: "media/a.mp4" } });
    await closeProject(editor);
  });

  it("failedSaveAsLeavesTheProjectWhereItWas", async () => {
    const { fs, registry, deps } = await setup();
    const editor = await newProject("Film", deps);
    const source = editor.projectPath ?? "";
    fs.before = (op, path) => { if (op === "writeText" && path.includes("Elsewhere")) throw new Error("denied"); };
    await expect(saveProjectAs(editor, `${dir}/Elsewhere.palmier`)).rejects.toThrow("denied");
    expect(editor.projectPath).toBe(source);
    expect(registry.entries().map((e) => e.path)).toEqual([source]);
    await closeProject(editor).catch(() => {});
  });
});
