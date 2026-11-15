import { describe, expect, it } from "vitest";
import {
  decodeMediaManifest, decodeMediaManifestEntry, makeExternalSource, makeGenerationInput, makeMediaManifest,
  makeMediaManifestEntry, makeProjectSource,
} from "./mediaManifest";
import { makeMediaFolder } from "./mediaFolder";
import {
  makeMediaAsset, mediaAssetCanEnhanceDraft, mediaAssetFromManifestEntry, mediaAssetToManifestEntry,
  mediaAssetWasGenerationRefunded,
} from "./mediaAsset";
import {
  makeMediaResolver, mediaResolverDisplayName, mediaResolverEntry, mediaResolverExpectedPathMapFor,
  mediaResolverMissingAssetIds, mediaResolverResolvePath,
} from "./mediaResolver";

const rt = <T>(v: unknown, decode: (j: unknown) => T): T => decode(JSON.parse(JSON.stringify(v)));

describe("Project JSON roundtrip — MediaManifest", () => {
  it("mediaManifestSurvivesRoundTripWithBothSourceKinds", () => {
    const manifest = makeMediaManifest({
      entries: [
        makeMediaManifestEntry({
          id: "ext-1", name: "External", type: "video", source: makeExternalSource("/abs/path/video.mp4"), duration: 5.0,
          sourceWidth: 1920, sourceHeight: 1080, sourceFPS: 30, hasAudio: true,
        }),
        makeMediaManifestEntry({
          id: "proj-1", name: "Project-relative", type: "image", source: makeProjectSource("media/img.png"), duration: 0,
          folderId: "folder-1",
        }),
      ],
      folders: [makeMediaFolder({ id: "folder-1", name: "Refs" })],
    });
    expect(rt(manifest, decodeMediaManifest)).toEqual(manifest);
  });

  it("source encodes as Swift's synthesized enum shape", () => {
    expect(JSON.stringify(makeProjectSource("a/b"))).toBe('{"project":{"relativePath":"a/b"}}');
    expect(JSON.stringify(makeExternalSource("C:\\x"))).toBe('{"external":{"absolutePath":"C:\\\\x"}}');
  });

  it("mediaManifestMissingVersionDecodesAsVersionOne", () => {
    expect(decodeMediaManifest({ entries: [], folders: [] }).version).toBe(1);
  });

  it("mediaManifestMissingEntriesAndFoldersDecodesAsEmpty", () => {
    const m = decodeMediaManifest({});
    expect(m.entries).toEqual([]);
    expect(m.folders).toEqual([]);
  });

  it("an entry with an ambiguous source is rejected", () => {
    expect(() =>
      decodeMediaManifestEntry({
        id: "a", name: "n", type: "video", duration: 1,
        source: { external: { absolutePath: "x" }, project: { relativePath: "y" } },
      }),
    ).toThrow();
  });
});

describe("ManifestMetadata", () => {
  it("draftGenerationSurvivesManifestRoundTrip", () => {
    const input = makeGenerationInput({
      prompt: "Draft", model: "flux-3", duration: 8, aspectRatio: "16:9", resolution: "720p", draft: true,
      backendJobId: "draft-job", resultURLs: ["video", "cache"],
    });
    const generated = makeMediaAsset({ url: "/tmp/draft.mp4", type: "video", name: "Draft", generationInput: input });
    const restored = rt(mediaAssetToManifestEntry(generated, undefined), decodeMediaManifestEntry);
    expect(restored.generationInput?.draft).toBe(true);
    expect(mediaAssetCanEnhanceDraft(mediaAssetFromManifestEntry(restored, generated.url))).toBe(true);
  });

  it("refundedCreditsSurviveManifestRoundTrip", () => {
    const input = makeGenerationInput({
      prompt: "Fail", model: "flux-3", duration: 5, aspectRatio: "16:9", resolution: "720p", costCredits: 12, refundedCredits: 12,
    });
    const generated = makeMediaAsset({ url: "/tmp/failed.mp4", type: "video", name: "Failed", generationInput: input });
    generated.generationStatus = { kind: "failed", message: "Provider error" };
    const asset = mediaAssetFromManifestEntry(rt(mediaAssetToManifestEntry(generated, undefined), decodeMediaManifestEntry), generated.url);
    expect(asset.generationInput?.costCredits).toBe(12);
    expect(asset.generationInput?.refundedCredits).toBe(12);
    expect(mediaAssetWasGenerationRefunded(asset)).toBe(true);
    if (asset.generationInput) asset.generationInput.refundedCredits = 0;
    expect(mediaAssetWasGenerationRefunded(asset)).toBe(false);
  });

  it("project-relative paths are derived from the project directory", () => {
    const asset = makeMediaAsset({ url: "D:\\proj\\media\\a.mp4", type: "video", name: "a" });
    const entry = mediaAssetToManifestEntry(asset, "D:\\proj");
    expect(entry.source).toEqual(makeProjectSource("media/a.mp4"));
  });
});

describe("MediaResolver", () => {
  const entry = (id: string, source = makeExternalSource("/tmp/" + id), name = "X") =>
    makeMediaManifestEntry({ id, name, type: "video", source, duration: 1 });
  const resolver = (entries: ReturnType<typeof entry>[], projectPath?: string, existing: string[] = []) =>
    makeMediaResolver({
      manifest: () => makeMediaManifest({ entries }),
      projectPath: () => projectPath,
      fileExists: (p) => existing.includes(p),
    });

  it("entryReturnsMatchingEntry", () => {
    expect(mediaResolverEntry(resolver([entry("a")]), "a")?.id).toBe("a");
  });

  it("entryReturnsNilWhenMissing", () => {
    expect(mediaResolverEntry(resolver([]), "ghost")).toBeUndefined();
  });

  it("displayNameReturnsEntryName", () => {
    expect(mediaResolverDisplayName(resolver([entry("a", undefined, "Hello")]), "a")).toBe("Hello");
  });

  it("displayNameFallsBackToOfflineWhenMissing", () => {
    expect(mediaResolverDisplayName(resolver([]), "ghost")).toBe("Offline");
  });

  it("resolveExternalReturnsURLWhenFileExists", () => {
    const r = resolver([entry("a", makeExternalSource("/tmp/f.mp4"))], undefined, ["/tmp/f.mp4"]);
    expect(mediaResolverResolvePath(r, "a")).toBe("/tmp/f.mp4");
  });

  it("resolveExternalReturnsNilWhenFileMissing", () => {
    expect(mediaResolverResolvePath(resolver([entry("a")]), "a")).toBeUndefined();
  });

  it("resolveProjectAppendsRelativePathToProjectURL", () => {
    const r = resolver([entry("a", makeProjectSource("media/asset.mp4"))], "/proj", ["/proj/media/asset.mp4"]);
    expect(mediaResolverResolvePath(r, "a")).toBe("/proj/media/asset.mp4");
  });

  it("resolveProjectReturnsNilWhenProjectURLIsNil", () => {
    expect(mediaResolverResolvePath(resolver([entry("a", makeProjectSource("media/asset.mp4"))]), "a")).toBeUndefined();
  });

  it("expectedURLMapKeepsFirstDuplicateId", () => {
    const map = mediaResolverExpectedPathMapFor(
      [entry("a", makeExternalSource("/tmp/first")), entry("a", makeExternalSource("/tmp/second"))],
      undefined,
    );
    expect(map.get("a")).toBe("/tmp/first");
  });

  it("missingAssetIdsFlagsExternalMissingAndKeepsPresent", () => {
    const entries = [entry("present", makeExternalSource("/tmp/p")), entry("gone", makeExternalSource("/tmp/g"))];
    expect(mediaResolverMissingAssetIds(entries, undefined, (p) => p === "/tmp/p")).toEqual(new Set(["gone"]));
  });

  it("missingAssetIdsResolvesProjectRelativePaths", () => {
    const entries = [entry("a", makeProjectSource("media/asset.mp4"))];
    expect(mediaResolverMissingAssetIds(entries, "/proj", (p) => p === "/proj/media/asset.mp4").size).toBe(0);
    expect(mediaResolverMissingAssetIds(entries, undefined, () => true)).toEqual(new Set(["a"]));
  });

  it("reflectsReplacedEntryAtSameCount (live reads)", () => {
    let entries = [entry("a"), entry("b")];
    const r = makeMediaResolver({ manifest: () => makeMediaManifest({ entries }), projectPath: () => undefined, fileExists: () => false });
    expect(mediaResolverEntry(r, "b")?.id).toBe("b");
    entries = [entry("a"), entry("c")];
    expect(mediaResolverEntry(r, "c")?.id).toBe("c");
    expect(mediaResolverEntry(r, "b")).toBeUndefined();
  });

  it("reflectsRenamedEntryAtSameCount (live reads)", () => {
    let entries = [entry("a", undefined, "First")];
    const r = makeMediaResolver({ manifest: () => makeMediaManifest({ entries }), projectPath: () => undefined, fileExists: () => false });
    expect(mediaResolverEntry(r, "a")?.name).toBe("First");
    entries = [entry("a", undefined, "Renamed")];
    expect(mediaResolverEntry(r, "a")?.name).toBe("Renamed");
  });
});
