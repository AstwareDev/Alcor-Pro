import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "./memoryFileSystem";
import { ProjectRegistry, projectEntryName } from "./projectRegistry";

const dir = "D:/Docs/Palmier Pro";

function make(fs = new MemoryFileSystem()) {
  let t = 1000;
  const registry = new ProjectRegistry({ fs, directory: dir, now: () => (t += 10) });
  return { fs, registry };
}

describe("ProjectRegistry", () => {
  it("registerAddsEntryAndPersists", async () => {
    const { fs, registry } = make();
    await registry.load();
    await registry.register("D:/Docs/Palmier Pro/A.palmier");
    expect(registry.entries().map(projectEntryName)).toEqual(["A"]);

    const reloaded = new ProjectRegistry({ fs, directory: dir });
    await reloaded.load();
    expect(reloaded.entries()).toEqual(registry.entries());
  });

  it("registerExistingPathBumpsLastOpenedOnly", async () => {
    const { registry } = make();
    await registry.load();
    await registry.register("D:/Docs/A.palmier");
    const first = registry.entries()[0];
    await registry.register("d:\\docs\\a.palmier\\");
    const [entry] = registry.entries();
    expect(registry.entries().length).toBe(1);
    expect(entry?.id).toBe(first?.id);
    expect(entry?.createdDate).toBe(first?.createdDate);
    expect(entry?.lastOpenedDate).toBeGreaterThan(first?.lastOpenedDate ?? 0);
  });

  it("sortedEntriesPutMostRecentlyOpenedFirst", async () => {
    const { registry } = make();
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.register("D:/B.palmier");
    await registry.register("D:/A.palmier");
    expect(registry.sortedEntries().map(projectEntryName)).toEqual(["A", "B"]);
  });

  it("removeDropsEntryButKeepsFiles", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.remove("D:/A.palmier");
    expect(registry.entries()).toEqual([]);
    expect(fs.has("D:/A.palmier/project.json")).toBe(true);
  });

  it("updatePathRepointsEntryAndBumpsLastOpened", async () => {
    const { registry } = make();
    await registry.load();
    await registry.register("D:/Old.palmier");
    const before = registry.entries()[0];
    await registry.updatePath("D:/Old.palmier", "D:/New.palmier");
    const [entry] = registry.entries();
    expect(entry?.path).toBe("D:/New.palmier");
    expect(entry?.id).toBe(before?.id);
    expect(entry?.lastOpenedDate).toBeGreaterThan(before?.lastOpenedDate ?? 0);
  });

  it("updatePathIgnoresUnknownOldPath", async () => {
    const { registry } = make();
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.updatePath("D:/Nope.palmier", "D:/B.palmier");
    expect(registry.entries().map((e) => e.path)).toEqual(["D:/A.palmier"]);
  });

  it("idLooksUpPathsIgnoringSeparatorsAndCase", async () => {
    const { registry } = make();
    await registry.load();
    await registry.register("D:/Docs/A.palmier");
    expect(registry.id("d:\\Docs\\.\\A.palmier")).toBe(registry.entries()[0]?.id);
    expect(registry.id("D:/Docs/B.palmier")).toBeUndefined();
  });

  it("mutationsBeforeLoadAreQueuedAndReplayedOnTopOfDiskState", async () => {
    const { fs, registry: seeded } = make();
    await seeded.load();
    await seeded.register("D:/OnDisk.palmier");

    const registry = new ProjectRegistry({ fs, directory: dir });
    const queued = registry.register("D:/Queued.palmier");
    expect(registry.entries()).toEqual([]);
    await registry.load();
    await queued;

    expect(registry.entries().map(projectEntryName).sort()).toEqual(["OnDisk", "Queued"]);
    const persisted = new ProjectRegistry({ fs, directory: dir });
    await persisted.load();
    expect(persisted.entries().length).toBe(2);
  });

  it("corruptOrMissingRegistryFileLoadsEmpty", async () => {
    const fs = new MemoryFileSystem();
    fs.seedText(`${dir}/project-registry.json`, "{ not json");
    const registry = new ProjectRegistry({ fs, directory: dir });
    await registry.load();
    expect(registry.entries()).toEqual([]);
  });

  it("malformedEntriesAreSkipped", async () => {
    const fs = new MemoryFileSystem();
    fs.seedText(
      `${dir}/project-registry.json`,
      JSON.stringify([{ id: "1", path: "D:/A.palmier", createdDate: 1, lastOpenedDate: 2 }, { id: 5 }, null]),
    );
    const registry = new ProjectRegistry({ fs, directory: dir });
    await registry.load();
    expect(registry.entries().length).toBe(1);
  });

  it("isAccessibleReflectsDisk", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.register("D:/Gone.palmier");
    const [a, gone] = registry.entries();
    expect(await registry.isAccessible(a!)).toBe(true);
    expect(await registry.isAccessible(gone!)).toBe(false);
  });

  it("deleteRemovesDirectoriesAndEntries", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.register("D:/Missing.palmier");

    const result = await registry.delete(registry.entries());

    expect(result.failedNames).toEqual([]);
    expect(result.deletedIds.size).toBe(2);
    expect(fs.has("D:/A.palmier")).toBe(false);
    expect(registry.entries()).toEqual([]);
  });

  it("deleteReportsFailuresAndKeepsThoseEntries", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    fs.seedText("D:/B.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.register("D:/B.palmier");
    fs.before = (op, path) => {
      if (op === "remove" && path.includes("B.palmier")) throw new Error("in use");
    };

    const result = await registry.delete(registry.entries());

    expect(result.failedNames).toEqual(["B"]);
    expect(registry.entries().map(projectEntryName)).toEqual(["B"]);
  });

  it("renameMovesDirectoryAndRepointsEntry", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await registry.rename(registry.entries()[0]!, "D:/Z.palmier");
    expect(fs.has("D:/Z.palmier/project.json")).toBe(true);
    expect(fs.has("D:/A.palmier")).toBe(false);
    expect(registry.entries()[0]?.path).toBe("D:/Z.palmier");
  });

  it("renameRefusesExistingTarget", async () => {
    const { fs, registry } = make();
    fs.seedText("D:/A.palmier/project.json", "{}");
    fs.seedText("D:/Z.palmier/project.json", "{}");
    await registry.load();
    await registry.register("D:/A.palmier");
    await expect(registry.rename(registry.entries()[0]!, "D:/Z.palmier")).rejects.toThrow(/already exists/);
    expect(registry.entries()[0]?.path).toBe("D:/A.palmier");
  });

  it("writeFailureRejectsTheMutation", async () => {
    const { fs, registry } = make();
    await registry.load();
    fs.before = (op) => {
      if (op === "writeText") throw new Error("read-only volume");
    };
    await expect(registry.register("D:/A.palmier")).rejects.toThrow("read-only volume");
  });
});
