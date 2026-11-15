import { describe, expect, it } from "vitest";
import {
  compareVersions, defaultCatalogUrl, isSafePackPath, packState, parseCatalog, resolvePackFileUrl, type CatalogPack,
} from "./catalog";

const sha = "a".repeat(64);
const pack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "slay-luts", name: "Slay LUTs", kind: "luts", version: "1.2.0", description: "d", licence: { name: "CC BY 4.0", requiresAttribution: true },
  attribution: "slay", author: "slay", sourceUrl: "https://example.com", files: [{ path: "luts/a.cube", url: "a.cube", sha256: sha, size: 10 }], ...over,
});
const index = (packs: unknown[], extra: Record<string, unknown> = {}): unknown => ({ format: "alcor-library-catalog", version: 1, packs, ...extra });

describe("parseCatalog", () => {
  it("parses packs and totals the size", () => {
    const c = parseCatalog(index([pack()]), defaultCatalogUrl);
    expect(c.warnings).toEqual([]);
    expect(c.packs[0]).toMatchObject({ id: "slay-luts", size: 10, kind: "luts", licence: { requiresAttribution: true } });
  });

  it("skips invalid packs with a warning", () => {
    const c = parseCatalog(index([
      pack(), pack({ id: "Bad Id" }), pack({ id: "p2", kind: "weird" }), pack({ id: "p3", version: "v1" }),
      pack({ id: "p4", files: [{ path: "../evil", url: "x", sha256: sha, size: 1 }] }),
      pack({ id: "p5", files: [{ path: "a", url: "x", sha256: "zz", size: 1 }] }),
      pack({ id: "p6", files: [] }), pack(),
    ]), "https://x/index.json");
    expect(c.packs.map((p) => p.id)).toEqual(["slay-luts"]);
    expect(c.warnings).toHaveLength(7);
  });

  it("rejects a wrong or newer envelope", () => {
    expect(() => parseCatalog({ format: "x", version: 1, packs: [] }, "u")).toThrow();
    expect(() => parseCatalog(index([], { version: 2 }), "u")).toThrow(/newer/);
    expect(() => parseCatalog({ format: "alcor-library-catalog", version: 1 }, "u")).toThrow();
  });
});

describe("paths and urls", () => {
  it("accepts only safe relative paths", () => {
    for (const ok of ["a.cube", "luts/a.cube", "presets.json"]) expect(isSafePackPath(ok)).toBe(true);
    for (const bad of ["", "../a", "a/../b", "/abs", "C:/x", "a\\b", "a//b", "./a", "a/b:c"]) expect(isSafePackPath(bad), bad).toBe(false);
  });

  it("resolves relative urls against the catalog and refuses non-https", () => {
    const f = (url: string) => ({ path: "a", url, sha256: sha, size: 1 });
    expect(resolvePackFileUrl(f("packs/a.json"), "https://h.io/lib/index.json")).toBe("https://h.io/lib/packs/a.json");
    expect(resolvePackFileUrl(f("https://other.io/x"), "https://h.io/index.json")).toBe("https://other.io/x");
    expect(() => resolvePackFileUrl(f("http://evil.io/x"), "https://h.io/index.json")).toThrow();
    expect(resolvePackFileUrl(f("x"), "http://localhost:8000/index.json")).toBe("http://localhost:8000/x");
  });
});

describe("versions", () => {
  it("compares numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("2", "10")).toBeLessThan(0);
  });

  it("reports install state and updates", () => {
    const p = parseCatalog(index([pack()]), "u").packs[0] as CatalogPack;
    expect(packState(undefined, p)).toBe("notInstalled");
    expect(packState("1.2.0", p)).toBe("installed");
    expect(packState("1.3.0", p)).toBe("installed");
    expect(packState("1.1.9", p)).toBe("updateAvailable");
  });
});
