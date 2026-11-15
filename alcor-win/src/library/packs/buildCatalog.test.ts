// @ts-expect-error type error without @types/node package
import process from "node:process";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../catalog";
import { decodePresetDocument } from "../presetFormat";
import { sha256Hex } from "../sha256";
import { buildCatalog } from "./buildCatalog";
import { packDefinitions } from "./packs";

interface MiniFs {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
}

describe("library catalog", () => {
  it("produces a valid index whose pack files verify and decode without warnings", async () => {
    const { files, index } = await buildCatalog();
    const catalog = parseCatalog(JSON.parse(JSON.stringify(index)), "https://example.test/index.json");
    expect(catalog.warnings).toEqual([]);
    expect(catalog.packs).toHaveLength(packDefinitions.length);
    for (const pack of catalog.packs) {
      for (const file of pack.files) {
        if (file.url.startsWith("https://")) continue;
        const text = files.get(file.url);
        expect(text, `${pack.id}/${file.path}`).toBeDefined();
        expect(await sha256Hex(new TextEncoder().encode(text))).toBe(file.sha256);
        const doc = decodePresetDocument(JSON.parse(text as string));
        expect(doc.warnings).toEqual([]);
        expect(doc.presets.length).toBeGreaterThan(0);
      }
    }
  });

  it("pack preset ids are globally unique and LUT resources point at files of their own pack", async () => {
    const ids = packDefinitions.flatMap((d) => d.presets.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of packDefinitions) {
      for (const p of def.presets) {
        if (p.kind !== "look" && p.kind !== "effect") continue;
        for (const e of p.effects) {
          if (e.resource === undefined) continue;
          expect(e.resource.startsWith(`${def.id}/`)).toBe(true);
          expect(def.remoteFiles.some((f) => f.path === e.resource?.slice(def.id.length + 1))).toBe(true);
        }
      }
    }
  });

  // `LIBRARY_CATALOG_OUT=library-catalog pnpm vitest run src/library/packs` writes the publishable files.
  it.skipIf(!process.env["LIBRARY_CATALOG_OUT"])("writes the catalog to LIBRARY_CATALOG_OUT", async () => {
    const out = process.env["LIBRARY_CATALOG_OUT"] as string;
    // @ts-expect-error type error without @types/node package
    const fs = (await import("node:fs/promises")) as unknown as MiniFs;
    const { files } = await buildCatalog();
    for (const [path, text] of files) {
      const full = `${out}/${path}`;
      await fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(full, text);
    }
  });
});
