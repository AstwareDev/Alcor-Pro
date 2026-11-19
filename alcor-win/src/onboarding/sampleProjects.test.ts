import { describe, expect, it } from "vitest";
import { Project } from "../model";
import { MemoryFileSystem } from "../project/memoryFileSystem";
import {
  cachedSamplePath, materializeSample, openableSamplePath, parseResolvedSample, placeholderDownloadSample, safeSampleName,
  SampleCancelled, sampleProjectList, type SampleDeps, type SampleSummary,
} from "./sampleProjects";

const sample: SampleSummary = { slug: "demo", title: "Demo", resolveUrl: "https://example.test/resolve" };

const resolved = {
  title: "Demo / Cut",
  project: { fps: 30 },
  manifest: { entries: [] },
  posterUrl: "https://example.test/poster.jpg",
  downloads: [
    { id: "a", relativePath: "media/a.mp4", url: "https://example.test/a.mp4" },
    { id: "b", relativePath: "media/sub/b.png", url: "https://example.test/b.png" },
  ],
  chat: [{ name: "one.json", url: "https://example.test/one.json" }],
};

async function readBytes(fs: MemoryFileSystem, path: string): Promise<Uint8Array> {
  return new TextEncoder().encode(await fs.readText(path));
}

function setup(overrides: Partial<SampleDeps> = {}, doc: unknown = resolved) {
  const fs = new MemoryFileSystem();
  const downloads: string[] = [];
  const deps: SampleDeps = {
    fs,
    cacheRoot: async () => "/app/Samples",
    fetchText: async () => JSON.stringify(doc),
    download: async (url, dest) => {
      downloads.push(url);
      fs.seedText(dest, `bytes of ${url}`);
    },
    ...overrides,
  };
  return { fs, deps, downloads };
}

describe("sampleProjectList", () => {
  it("offersTheGeneratedSampleFirstAndKeepsThePlaceholderOut", () => {
    expect(sampleProjectList[0]?.build).toBeTypeOf("function");
    expect(sampleProjectList).not.toContain(placeholderDownloadSample);
    expect(sampleProjectList.every((s) => s.build !== undefined || s.resolveUrl?.startsWith("https://example.invalid") !== true)).toBe(true);
  });
});

describe("parseResolvedSample", () => {
  it("foldsChatFilesIntoTheDownloadList", () => {
    const parsed = parseResolvedSample(JSON.stringify(resolved));
    expect(parsed.downloads.map((d) => d.relativePath)).toEqual(["media/a.mp4", "media/sub/b.png", "chat/one.json"]);
    expect(parsed.posterUrl).toBe("https://example.test/poster.jpg");
  });

  it("rejectsMalformedAndEscapingDocuments", () => {
    for (const bad of [
      "not json", "[]", JSON.stringify({ title: "x" }),
      JSON.stringify({ ...resolved, downloads: [{ relativePath: "../evil", url: "u" }] }),
      JSON.stringify({ ...resolved, downloads: [{ relativePath: "C:/evil", url: "u" }] }),
      JSON.stringify({ ...resolved, chat: [{ name: "../x", url: "u" }] }),
    ]) {
      expect(() => parseResolvedSample(bad), bad).toThrow("The sample response was malformed.");
    }
  });
});

describe("materializeSample", () => {
  it("buildsAPackageAndReportsProgress", async () => {
    const { fs, deps, downloads } = setup();
    const progress: number[] = [];
    const path = await materializeSample(deps, sample, (p) => progress.push(p));
    expect(path).toBe(`/app/Samples/demo/Demo   Cut.${Project.fileExtension}`);
    expect(JSON.parse(await fs.readText(`${path}/${Project.timelineFilename}`))).toEqual({ fps: 30 });
    expect(JSON.parse(await fs.readText(`${path}/${Project.manifestFilename}`))).toEqual({ entries: [] });
    expect(await fs.exists(`${path}/media/sub/b.png`)).toBe(true);
    expect(await fs.exists(`${path}/chat/one.json`)).toBe(true);
    expect(await fs.exists(`${path}/${Project.thumbnailFilename}`)).toBe(true);
    expect(downloads).toHaveLength(4);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("removesThePartialPackageWhenADownloadFails", async () => {
    const { fs, deps } = setup({
      download: async (url, dest) => {
        if (url.endsWith("b.png")) throw new Error("offline");
        fs.seedText(dest, "x");
      },
    });
    await expect(materializeSample(deps, sample)).rejects.toThrow("offline");
    expect(await fs.exists("/app/Samples/demo")).toBe(false);
  });

  it("aMissingPosterDoesNotFailTheSample", async () => {
    const { deps, fs } = setup({
      download: async (url, dest) => {
        if (url.endsWith("poster.jpg")) throw new Error("404");
        fs.seedText(dest, "x");
      },
    });
    await expect(materializeSample(deps, sample)).resolves.toContain("Demo   Cut");
  });
});

describe("generated samples", () => {
  const built = {
    title: "Gen",
    project: { timelines: [] },
    manifest: { version: 2, entries: [], folders: [] },
    files: [{ relativePath: "media/tone.wav", bytes: new Uint8Array([1, 2, 3]) }],
  };
  const generated: SampleSummary = { slug: "gen", title: "Gen", build: () => built };

  it("writesTheBuiltFilesWithoutFetchingOrDownloading", async () => {
    const { fs, deps, downloads } = setup({ fetchText: async () => { throw new Error("no network"); } });
    const progress: number[] = [];
    const path = await materializeSample(deps, generated, (p) => progress.push(p));
    expect(path).toBe(`/app/Samples/gen/Gen.${Project.fileExtension}`);
    expect([...(await readBytes(fs, `${path}/media/tone.wav`))]).toEqual([1, 2, 3]);
    expect(JSON.parse(await fs.readText(`${path}/${Project.timelineFilename}`))).toEqual({ timelines: [] });
    expect(downloads).toHaveLength(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("failsWhenASampleHasNeitherABuilderNorAUrl", async () => {
    const { deps } = setup();
    await expect(materializeSample(deps, { slug: "x", title: "x" })).rejects.toThrow("no source");
  });
});

describe("cancel", () => {
  it("abortingMidDownloadRejectsWithCancelledAndRemovesThePackage", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const { fs, deps } = setup({
      download: (url, _dest, signal) => {
        seen.push(signal);
        if (url.endsWith("poster.jpg")) return Promise.resolve();
        if (url.endsWith("a.mp4")) queueMicrotask(() => controller.abort());
        return new Promise<void>(() => undefined); // never finishes on its own
      },
    });
    await expect(materializeSample(deps, sample, undefined, controller.signal)).rejects.toBeInstanceOf(SampleCancelled);
    expect(seen.every((s) => s === controller.signal)).toBe(true);
    expect(await fs.exists("/app/Samples/demo")).toBe(false);
  });

  it("anAlreadyAbortedSignalDownloadsNothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fs, deps, downloads } = setup();
    await expect(materializeSample(deps, sample, undefined, controller.signal)).rejects.toBeInstanceOf(SampleCancelled);
    expect(downloads).toHaveLength(0);
    expect(await fs.exists("/app/Samples/demo")).toBe(false);
  });

  it("aCancelledPosterIsNotSwallowedLikeAMissingOne", async () => {
    const controller = new AbortController();
    const { deps } = setup({
      download: (url) => {
        if (url.endsWith("poster.jpg")) controller.abort();
        return new Promise<void>(() => undefined);
      },
    });
    await expect(materializeSample(deps, sample, undefined, controller.signal)).rejects.toBeInstanceOf(SampleCancelled);
  });
});

describe("cache", () => {
  it("opensTheCachedPackageWithoutDownloadingAgain", async () => {
    const { deps, downloads } = setup();
    expect(await cachedSamplePath(deps, "demo")).toBeUndefined();
    const first = await openableSamplePath(deps, sample);
    const count = downloads.length;
    expect(await cachedSamplePath(deps, "demo")).toBe(first);
    expect(await openableSamplePath(deps, sample)).toBe(first);
    expect(downloads).toHaveLength(count);
  });

  it("safeNameReplacesSeparatorsAndNeverReturnsEmpty", () => {
    expect(safeSampleName("a/b:c\\d")).toBe("a b c d");
    expect(safeSampleName("  ")).toBe("Sample");
  });
});
