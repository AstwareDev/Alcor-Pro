import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../project/projectRegistry";
import { filterProjects, relativeString, standardContains } from "./projectList";

const entry = (name: string, created: number, opened: number): ProjectEntry => ({
  id: name, path: `D:/Docs/${name}.palmier`, createdDate: created, lastOpenedDate: opened,
});

const entries = [entry("Beach", 1, 30), entry("Café", 3, 10), entry("alpine 10", 2, 20), entry("alpine 2", 4, 5)];

describe("project list", () => {
  it("sortsByLastOpenedNewestFirstByDefault", () => {
    expect(filterProjects(entries, "", "lastOpened").map((e) => e.id)).toEqual(["Beach", "alpine 10", "Café", "alpine 2"]);
  });

  it("sortsByCreatedAndByNameNaturally", () => {
    expect(filterProjects(entries, "", "created").map((e) => e.id)).toEqual(["alpine 2", "Café", "alpine 10", "Beach"]);
    expect(filterProjects(entries, "", "name").map((e) => e.id)).toEqual(["alpine 2", "alpine 10", "Beach", "Café"]);
  });

  it("filtersByTrimmedCaseAndDiacriticInsensitiveName", () => {
    expect(filterProjects(entries, "  CAFE ", "name").map((e) => e.id)).toEqual(["Café"]);
    expect(filterProjects(entries, "alp", "name")).toHaveLength(2);
    expect(filterProjects(entries, "zzz", "name")).toEqual([]);
    expect(filterProjects(entries, "   ", "name")).toHaveLength(4);
  });

  it("doesNotMatchOnDirectory", () => {
    expect(standardContains("Beach", "Docs")).toBe(false);
  });

  it("doesNotMutateInput", () => {
    const copy = [...entries];
    filterProjects(entries, "", "name");
    expect(entries).toEqual(copy);
  });
});

describe("relativeString", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it.each([
    [0, "now"],
    [30_000, "30 seconds ago"],
    [60_000, "1 minute ago"],
    [3 * 3_600_000, "3 hours ago"],
    [26 * 3_600_000, "1 day ago"],
    [9 * 86_400_000, "1 week ago"],
    [45 * 86_400_000, "1 month ago"],
    [800 * 86_400_000, "2 years ago"],
  ])("%d ms ago -> %s", (ms, expected) => {
    expect(relativeString(ago(ms), now)).toBe(expected);
  });
  it("formatsTheFuture", () => {
    expect(relativeString(new Date(now.getTime() + 2 * 3_600_000), now)).toBe("in 2 hours");
  });
});
