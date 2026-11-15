import { describe, expect, it } from "vitest";
import { Project } from "../model/constants";
import { fixtureTimeline } from "../model/fixtures";
import {
  decodeMediaManifest, makeExternalSource, makeMediaManifest, makeMediaManifestEntry, makeProjectSource,
  type MediaManifest,
} from "../model/mediaManifest";
import { makeMediaResolver, mediaResolverResolvePath } from "../model/mediaResolver";
import { makeProjectFile } from "../model/projectFile";
import {
  palmierProjectExporterPlan, palmierProjectExportReportWarnings, type PalmierProjectExportPlan,
} from "./palmierProjectExporter";

const root = "/tmp/pp-export-1";
const source = `${root}/Source.palmier`;
const dest = `${root}/Packaged.palmier`;
const externalPath = `${root}/external-clip.mov`;

const existing = new Map<string, number>([
  [`${source}/media/gen-abc123.mp4`, 14],
  [`${source}/${Project.thumbnailFilename}`, 4],
  [externalPath, 14],
]);

function projectFile() {
  return makeProjectFile({ timelines: [fixtureTimeline()] });
}

function manifest(path: string): MediaManifest {
  return makeMediaManifest({
    entries: [
      makeMediaManifestEntry({ id: "proj-1", name: "Internal", type: "video", source: makeProjectSource("media/gen-abc123.mp4"), duration: 1 }),
      makeMediaManifestEntry({ id: "ext-1", name: "External", type: "video", source: makeExternalSource(path), duration: 1 }),
      makeMediaManifestEntry({ id: "miss-1", name: "Gone", type: "video", source: makeExternalSource("/nonexistent/gone.mov"), duration: 1 }),
    ],
  });
}

function plan(m: MediaManifest): PalmierProjectExportPlan {
  return palmierProjectExporterPlan({
    projectFile: projectFile(),
    manifest: m,
    sourceProjectPath: source,
    fileExists: (p) => existing.has(p),
    fileSize: (p) => existing.get(p) ?? 0,
  });
}

function outManifest(p: PalmierProjectExportPlan): MediaManifest {
  const file = p.textFiles.find((f) => f.path === Project.manifestFilename);
  if (file === undefined) throw new Error("manifest not planned");
  return decodeMediaManifest(JSON.parse(file.contents));
}

describe("Palmier project export (collect media)", () => {
  it("collectsExternalAndInternalRewritesSourcesReportsMissing", () => {
    const p = plan(manifest(externalPath));
    const { report } = p;

    expect(report.collected).toEqual(["ext-1"]);
    expect(report.copiedInternal).toBe(1);
    expect(report.missing).toEqual([{ id: "miss-1", name: "Gone" }]);
    expect(report.totalBytes).toBeGreaterThan(0);
    expect(palmierProjectExportReportWarnings(report)).toEqual(["1 media file was missing and could not be included."]);

    // Bundle structure planned.
    const written = p.textFiles.map((f) => f.path);
    expect(written).toContain(Project.timelineFilename);
    expect(written).toContain(Project.manifestFilename);
    expect(p.optionalCopies).toContainEqual({ from: `${source}/${Project.thumbnailFilename}`, to: Project.thumbnailFilename });

    // Manifest sources rewritten: resolvable entries internalized, missing one untouched.
    const byId = new Map(outManifest(p).entries.map((e) => [e.id, e.source]));
    expect(byId.get("proj-1")).toHaveProperty("project");
    expect(byId.get("ext-1")).toHaveProperty("project");
    expect(byId.get("miss-1")).toHaveProperty("external");

    // The collected external file is copied to its new relative path.
    const extSource = byId.get("ext-1");
    if (extSource === undefined || !("project" in extSource)) throw new Error("ext-1 should become project");
    expect(p.copies).toContainEqual({ from: externalPath, to: extSource.project.relativePath });
  });

  it("exportedBundleRoundTripsWithZeroUnresolvedMedia", () => {
    const p = plan(manifest(externalPath));
    const out = outManifest(p);
    const packaged = new Set(p.copies.map((c) => `${dest}/${c.to}`));
    const resolver = makeMediaResolver({
      manifest: () => out,
      projectPath: () => dest,
      fileExists: (path) => packaged.has(path),
    });

    expect(mediaResolverResolvePath(resolver, "proj-1")).toBeDefined();
    expect(mediaResolverResolvePath(resolver, "ext-1")).toBeDefined();
    expect(mediaResolverResolvePath(resolver, "miss-1")).toBeUndefined(); // genuinely gone
  });

  it("deduplicatesTwoEntriesPointingAtTheSameExternalFile", () => {
    const m = makeMediaManifest({
      entries: [
        makeMediaManifestEntry({ id: "a", name: "A", type: "video", source: makeExternalSource(externalPath), duration: 1 }),
        makeMediaManifestEntry({ id: "b", name: "B", type: "video", source: makeExternalSource(externalPath), duration: 1 }),
      ],
    });
    const p = plan(m);

    expect([...p.report.collected].sort()).toEqual(["a", "b"]);
    // Only one physical file copied into media/.
    expect(p.copies).toHaveLength(1);
  });
});
