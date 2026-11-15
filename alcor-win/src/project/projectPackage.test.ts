import { describe, expect, it } from "vitest";
import { fixtureTimeline } from "../model/fixtures";
import { makeMediaManifest } from "../model";
import { MemoryFileSystem } from "./memoryFileSystem";
import { manifestSnapshot, readProjectPackage, writeProjectPackage, type ProjectPackageSnapshot } from "./projectPackage";
import { makeBundle, sampleManifest } from "./projectTestKit";

const bundle = "D:/Projects/vp-load.palmier";
const emptySnapshot = (): ProjectPackageSnapshot => ({
  timeline: JSON.stringify(fixtureTimeline()),
  manifest: null,
  thumbnail: null,
  chatSessionFiles: [],
});

describe("VideoProject package load resilience", () => {
  it("corruptManifestStillOpensWithIntactTimeline", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle, 2);
    fs.seedText(`${bundle}/media.json`, "{ this is not valid manifest json ");

    const contents = await readProjectPackage(bundle, fs);

    expect(contents.manifest).toBeNull();
    expect(contents.manifestUnreadable).toBe(true);
    expect(contents.projectFile.timelines[0]?.tracks.length).toBe(2);
  });

  it("missingManifestOpensAndIsNotFlaggedUnreadable", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    const contents = await readProjectPackage(bundle, fs);
    expect(contents.manifest).toBeNull();
    expect(contents.manifestUnreadable).toBe(false);
  });

  it("validManifestDecodesNormally", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedText(`${bundle}/media.json`, JSON.stringify(sampleManifest()));
    const contents = await readProjectPackage(bundle, fs);
    expect(contents.manifest?.entries.length).toBe(1);
    expect(contents.manifestUnreadable).toBe(false);
  });

  it("missingTimelineStillThrows", async () => {
    const fs = new MemoryFileSystem();
    fs.seedDir(bundle);
    await expect(readProjectPackage(bundle, fs)).rejects.toThrow(/project\.json/);
  });

  it("legacyBareTimelineProjectFileOpens", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    const contents = await readProjectPackage(bundle, fs);
    expect(contents.projectFile.timelines.length).toBe(1);
    expect(contents.projectFile.activeTimelineId).toBe(contents.projectFile.timelines[0]?.id);
  });

  it("undecodableTimelineThrows", async () => {
    const fs = new MemoryFileSystem();
    fs.seedText(`${bundle}/project.json`, "{ nope");
    await expect(readProjectPackage(bundle, fs)).rejects.toThrow();
  });
});

describe("VideoProject manifest snapshot", () => {
  it("emptyManifestNotSerializedAfterLoadFailure", () => {
    expect(manifestSnapshot(makeMediaManifest(), true)).toBeNull();
  });
  it("rebuiltManifestIsSerializedAfterLoadFailure", () => {
    expect(manifestSnapshot(sampleManifest(), true)).not.toBeNull();
  });
  it("manifestSerializedNormallyWhenLoadSucceeded", () => {
    expect(manifestSnapshot(makeMediaManifest(), false)).not.toBeNull();
  });
});

describe("VideoProject package write", () => {
  it("packageWriteCreatesMediaDirectory", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    await writeProjectPackage(emptySnapshot(), bundle, bundle, fs);
    expect(await fs.isDirectory(`${bundle}/media`)).toBe(true);
  });

  it("saveAsPreservesUnreadableManifestFile", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedText(`${bundle}/media.json`, "ORIGINAL-CORRUPT-MANIFEST-BYTES");
    const dest = "D:/Projects/vp-dest.palmier";

    await writeProjectPackage(emptySnapshot(), dest, bundle, fs);

    expect(fs.text(`${dest}/media.json`)).toBe("ORIGINAL-CORRUPT-MANIFEST-BYTES");
  });

  it("inPlaceSaveLeavesUnreadableManifestUntouched", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedText(`${bundle}/media.json`, "ORIGINAL-CORRUPT-MANIFEST-BYTES");
    fs.writes.length = 0;

    await writeProjectPackage(emptySnapshot(), bundle, bundle, fs);

    expect(fs.text(`${bundle}/media.json`)).toBe("ORIGINAL-CORRUPT-MANIFEST-BYTES");
    expect(fs.writes).not.toContain(`${bundle}/media.json`);
  });

  it("saveAsCopiesMediaThumbnailAndUnknownFiles", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedBytes(`${bundle}/media/clips/a.mp4`, new Uint8Array([1, 2, 3]));
    fs.seedBytes(`${bundle}/thumbnail.jpg`, new Uint8Array([9, 9]));
    fs.seedText(`${bundle}/notes.txt`, "keep me");
    fs.seedText(`${bundle}/extras/x.json`, "{}");
    const dest = "D:/Projects/Copy.palmier";

    await writeProjectPackage(emptySnapshot(), dest, bundle, fs);

    expect([...fs.bytes(`${dest}/media/clips/a.mp4`)]).toEqual([1, 2, 3]);
    expect([...fs.bytes(`${dest}/thumbnail.jpg`)]).toEqual([9, 9]);
    expect(fs.text(`${dest}/notes.txt`)).toBe("keep me");
    expect(fs.text(`${dest}/extras/x.json`)).toBe("{}");
    expect(fs.paths().some((p) => p.includes(".copying-"))).toBe(false);
    expect(fs.has(`${bundle}/media/clips/a.mp4`)).toBe(true);
  });

  it("saveAsReplacesStaleMediaAtDestination", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedBytes(`${bundle}/media/new.mp4`, new Uint8Array([1]));
    const dest = "D:/Projects/Existing.palmier";
    fs.seedBytes(`${dest}/media/stale.mp4`, new Uint8Array([2]));

    await writeProjectPackage(emptySnapshot(), dest, bundle, fs);

    expect(fs.has(`${dest}/media/stale.mp4`)).toBe(false);
    expect(fs.has(`${dest}/media/new.mp4`)).toBe(true);
  });

  it("chatDirectoryIsRewrittenWhenSnapshotCarriesSessions", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedText(`${bundle}/chat/old.json`, "{}");
    await writeProjectPackage({ ...emptySnapshot(), chatSessionFiles: [{ name: "new.json", data: "{\"a\":1}" }] }, bundle, bundle, fs);
    expect(fs.has(`${bundle}/chat/old.json`)).toBe(false);
    expect(fs.text(`${bundle}/chat/new.json`)).toBe("{\"a\":1}");
  });

  it("chatDirectoryIsPreservedWhenSnapshotHasNoChatModel", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.seedText(`${bundle}/chat/old.json`, "{}");
    const dest = "D:/Projects/Copy.palmier";
    const { chatSessionFiles: _unused, ...snapshot } = emptySnapshot();
    void _unused;
    await writeProjectPackage(snapshot, bundle, bundle, fs);
    await writeProjectPackage(snapshot, dest, bundle, fs);
    expect(fs.has(`${bundle}/chat/old.json`)).toBe(true);
    expect(fs.has(`${dest}/chat/old.json`)).toBe(true);
  });

  it("writeFailureSurfaces", async () => {
    const fs = new MemoryFileSystem();
    makeBundle(fs, bundle);
    fs.before = (op, path) => {
      if (op === "writeText" && path.endsWith("project.json")) throw new Error("disk full");
    };
    await expect(writeProjectPackage(emptySnapshot(), bundle, bundle, fs)).rejects.toThrow("disk full");
  });

  it("aFileInPlaceOfThePackageIsReplacedByADirectory", async () => {
    const fs = new MemoryFileSystem();
    fs.seedText(bundle, "not a directory");
    await writeProjectPackage(emptySnapshot(), bundle, undefined, fs);
    expect(await fs.isDirectory(bundle)).toBe(true);
    expect(fs.has(`${bundle}/project.json`)).toBe(true);
  });
});
