import { describe, expect, it } from "vitest";
import { SkillCatalog, type SkillCatalogEntry } from "./skillCatalog";
import { memorySkillFs } from "./skillFs";
import { decodeLedger, sha12, shouldAutomaticallyInstall, SkillStore } from "./skillStore";

describe("Community skill auto-install", () => {
  const cases: [string | undefined, string | undefined, string, boolean, boolean][] = [
    [undefined, undefined, "new", false, true],
    [undefined, undefined, "new", true, false],
    ["local", undefined, "catalog", false, false],
    ["old", "old", "new", false, true],
    ["current", "current", "current", false, false],
    ["modified", "old", "new", false, false],
    [undefined, "old", "new", false, false],
  ];
  it.each(cases)("installsOnlyNewOrUntouchedSkills %#", (localSHA, installedSHA, catalogSHA, isSuppressed, expected) => {
    expect(shouldAutomaticallyInstall({ localSHA, installedSHA, catalogSHA, isSuppressed })).toBe(expected);
  });

  it("decodesCurrentAndLegacyLedgers", () => {
    const current = '{"version":1,"installed":{"captions":"abc123"},"suppressed":["grading"]}';
    const legacy = JSON.stringify({ captions: "abc123" });
    expect(decodeLedger(current)).toEqual({ installed: { captions: "abc123" }, suppressed: new Set(["grading"]) });
    expect(decodeLedger(legacy)).toEqual({ installed: { captions: "abc123" }, suppressed: new Set() });
    expect(decodeLedger("not json")).toBeUndefined();
  });
});

describe("Skill catalog sync", () => {
  it("installs a new catalog skill once and keeps a removed one suppressed", async () => {
    const text = "---\nname: Captions\ndescription: Make captions.\n---\n\nDo it.";
    const entry: SkillCatalogEntry = { id: "captions", name: "Captions", description: "Make captions.", sha: await sha12(text), path: "skills/captions/SKILL.md" };
    const fetchText = async (url: string): Promise<string> => (url.endsWith("catalog.json") ? JSON.stringify([entry]) : text);
    const store = new SkillStore("/skills", memorySkillFs());
    const catalog = new SkillCatalog(fetchText);
    await store.syncSkills(catalog);
    expect(store.skills.map((s) => s.id)).toEqual(["captions"]);
    expect(store.origin("captions")).toBe("community");
    expect(store.installed).toEqual({ captions: entry.sha });

    expect(await store.delete(store.skills[0])).toBe(true);
    await store.syncSkills(catalog);
    expect(store.skills).toEqual([]);
  });

  it("rejects a body whose hash does not match the catalog", async () => {
    const entry: SkillCatalogEntry = { id: "x", name: "X", description: "d", sha: "000000000000", path: "x.md" };
    const store = new SkillStore("/skills", memorySkillFs());
    await store.reloadSkills();
    const catalog = new SkillCatalog(async () => "---\nname: X\ndescription: d\n---\n\nbody");
    expect(await store.install(catalog, entry)).toBe(false);
    expect(store.skills).toEqual([]);
  });
});
