import { describe, expect, it } from "vitest";
import { parseCatalog, type CatalogPack } from "./catalog";
import {
  InstallCancelled, IntegrityError, installPack, listInstalledPacks, resolveInstalledResource, uninstallPack, type InstallerDeps,
} from "./packInstaller";
import { sha256Hex } from "./sha256";

const enc = new TextEncoder();

/** In-memory file system keyed by normalised path; directories are implied by file prefixes plus an explicit set. */
function makeFakeFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const under = (p: string): string[] => [...files.keys()].filter((k) => k.startsWith(`${p}/`));
  return {
    files, dirs,
    fs: {
      mkdir: (p: string) => { dirs.add(p); return Promise.resolve(); },
      exists: (p: string) => Promise.resolve(files.has(p) || dirs.has(p) || under(p).length > 0),
      readText: (p: string) => { const v = files.get(p); return v === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(v); },
      writeText: (p: string, c: string) => { files.set(p, c); return Promise.resolve(); },
      rename: (from: string, to: string) => {
        for (const k of [...files.keys()]) if (k.startsWith(`${from}/`)) { files.set(to + k.slice(from.length), files.get(k) as string); files.delete(k); }
        for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
        dirs.add(to);
        return Promise.resolve();
      },
      remove: (p: string) => {
        for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
        for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
        return Promise.resolve();
      },
      list: (p: string) => {
        const names = new Map<string, boolean>();
        for (const k of [...files.keys(), ...dirs]) if (k.startsWith(`${p}/`)) {
          const rest = k.slice(p.length + 1);
          const slash = rest.indexOf("/");
          if (slash > 0) names.set(rest.slice(0, slash), true);
          else if (dirs.has(k)) names.set(rest, true);
          else names.set(rest, false);
        }
        return Promise.resolve([...names].map(([name, isDir]) => ({ name, isDir })));
      },
    },
  };
}

async function makePack(contents: Record<string, string>, version = "1.0.0"): Promise<CatalogPack> {
  const files = await Promise.all(Object.entries(contents).map(async ([path, text]) => ({
    path, url: `https://cdn.test/${path}`, sha256: await sha256Hex(enc.encode(text)), size: enc.encode(text).byteLength,
  })));
  const c = parseCatalog({
    format: "alcor-library-catalog", version: 1,
    packs: [{ id: "demo", name: "Demo", kind: "luts", version, licence: { name: "CC BY 4.0", requiresAttribution: true }, author: "me", sourceUrl: "https://x.test", files }],
  }, "https://cdn.test/index.json");
  return c.packs[0] as CatalogPack;
}

function makeDeps(remote: Record<string, string>, fake = makeFakeFs()) {
  const calls: string[] = [];
  const deps: InstallerDeps = {
    root: "/app/library",
    fs: fake.fs,
    download: (url, dest, onProgress, signal) => {
      calls.push(url);
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      const body = remote[url.replace("https://cdn.test/", "")];
      if (body === undefined) return Promise.reject(new Error("HTTP 404"));
      fake.files.set(dest, body);
      onProgress(enc.encode(body).byteLength);
      return Promise.resolve();
    },
    readBytes: (p) => Promise.resolve(enc.encode(fake.files.get(p) ?? "")),
    sha256Hex,
  };
  return { deps, fake, calls };
}

describe("installPack", () => {
  it("downloads, verifies and installs into <root>/<id>/ with a manifest", async () => {
    const remote = { "luts/a.cube": "AAAA", "presets.json": "{}" };
    const pack = await makePack(remote);
    const { deps, fake } = makeDeps(remote);
    const progress: number[] = [];
    const installed = await installPack(deps, pack, "https://cdn.test/index.json", { onProgress: (p) => progress.push(p.receivedBytes), now: () => new Date("2026-01-01T00:00:00Z") });
    expect(installed.dir).toBe("/app/library/demo");
    expect(fake.files.get("/app/library/demo/luts/a.cube")).toBe("AAAA");
    expect(fake.files.has("/app/library/.staging-demo/luts/a.cube")).toBe(false);
    expect(progress.at(-1)).toBe(6);
    const list = await listInstalledPacks(deps);
    expect(list.map((p) => [p.id, p.version])).toEqual([["demo", "1.0.0"]]);
    expect(resolveInstalledResource(list, "demo/luts/a.cube")).toBe("/app/library/demo/luts/a.cube");
    expect(resolveInstalledResource(list, "demo/luts/missing.cube")).toBeUndefined();
    expect(resolveInstalledResource(list, "demo/../x")).toBeUndefined();
    expect(resolveInstalledResource(list, "other/luts/a.cube")).toBeUndefined();
  });

  it("rejects a sha256 mismatch and leaves no install behind", async () => {
    const pack = await makePack({ "a.cube": "GOOD" });
    const { deps, fake } = makeDeps({ "a.cube": "EVIL" });
    await expect(installPack(deps, pack, "https://cdn.test/index.json")).rejects.toBeInstanceOf(IntegrityError);
    expect([...fake.files.keys()]).toEqual([]);
    expect(await listInstalledPacks(deps)).toEqual([]);
  });

  it("rejects a size mismatch", async () => {
    const pack = await makePack({ "a.cube": "GOOD" });
    pack.files[0] = { ...(pack.files[0] as CatalogPack["files"][number]), size: 99 };
    const { deps } = makeDeps({ "a.cube": "GOOD" });
    await expect(installPack(deps, pack, "https://cdn.test/index.json")).rejects.toThrow(/expected 99 bytes/);
  });

  it("cancels cleanly, keeping a previous install", async () => {
    const v1 = await makePack({ "a.cube": "ONE" }, "1.0.0");
    const { deps, fake } = makeDeps({ "a.cube": "ONE" });
    await installPack(deps, v1, "https://cdn.test/index.json");
    const v2 = await makePack({ "a.cube": "TWO" }, "2.0.0");
    const ctl = new AbortController();
    const slow: InstallerDeps = { ...deps, download: (_u, _d, _p, signal) => { ctl.abort(); return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(); } };
    await expect(installPack(slow, v2, "https://cdn.test/index.json", { signal: ctl.signal })).rejects.toBeInstanceOf(InstallCancelled);
    expect(fake.files.get("/app/library/demo/a.cube")).toBe("ONE");
    expect([...fake.files.keys()].some((k) => k.includes(".staging"))).toBe(false);
  });

  it("updates an installed pack in place when the version changes", async () => {
    const { deps, fake } = makeDeps({ "a.cube": "ONE" });
    await installPack(deps, await makePack({ "a.cube": "ONE" }, "1.0.0"), "https://cdn.test/index.json");
    const remote2 = { "b.cube": "TWO" };
    const upd = makeDeps(remote2, fake);
    await installPack(upd.deps, await makePack(remote2, "1.1.0"), "https://cdn.test/index.json");
    expect(fake.files.has("/app/library/demo/a.cube")).toBe(false);
    expect(fake.files.get("/app/library/demo/b.cube")).toBe("TWO");
    expect((await listInstalledPacks(deps))[0]?.version).toBe("1.1.0");
    expect([...fake.files.keys()].some((k) => k.includes(".old"))).toBe(false);
  });

  it("refuses unsafe file paths before touching the file system", async () => {
    const pack = await makePack({ "a.cube": "X" });
    pack.files[0] = { ...(pack.files[0] as CatalogPack["files"][number]), path: "../escape.cube" };
    const { deps, calls } = makeDeps({});
    await expect(installPack(deps, pack, "https://cdn.test/index.json")).rejects.toThrow(/Unsafe/);
    expect(calls).toEqual([]);
  });
});

describe("uninstallPack", () => {
  it("removes the pack directory", async () => {
    const remote = { "a.cube": "ONE" };
    const { deps, fake } = makeDeps(remote);
    await installPack(deps, await makePack(remote), "https://cdn.test/index.json");
    await uninstallPack(deps, "demo");
    expect([...fake.files.keys()]).toEqual([]);
    expect(await listInstalledPacks(deps)).toEqual([]);
    await expect(uninstallPack(deps, "demo")).resolves.toBeUndefined();
  });
});
