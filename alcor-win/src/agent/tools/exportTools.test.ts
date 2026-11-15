import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory filesystem standing in for the Rust fs commands (all backend calls the export path makes).
const fake = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const key = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const entry = (p: string) => ({ name: p, path: p, isDir: dirs.has(key(p)), size: files.get(key(p))?.length ?? 0, modifiedMs: 0 });
  return { files, dirs, key, entry };
});

vi.mock("../../platform/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/backend")>()),
  fsStat: async (p: string) => (fake.files.has(fake.key(p)) || fake.dirs.has(fake.key(p)) ? fake.entry(p) : null),
  fsWriteText: async (p: string, text: string) => { fake.files.set(fake.key(p), text); },
  fsMkdir: async (p: string) => { fake.dirs.add(fake.key(p)); },
  fsRemove: async (p: string) => { fake.files.delete(fake.key(p)); fake.dirs.delete(fake.key(p)); },
  fsRename: async (from: string, to: string) => {
    const f = fake.files.get(fake.key(from));
    if (f !== undefined) fake.files.set(fake.key(to), f);
    fake.files.delete(fake.key(from));
    if (fake.dirs.delete(fake.key(from))) fake.dirs.add(fake.key(to));
  },
  fsCopy: async () => {},
  fsList: async () => [],
  appPaths: async () => ({ projects: "C:/Users/t/Documents", appData: "C:/a", cache: "C:/c", temp: "C:/t", downloads: "C:/Users/t/Downloads" }),
}));

import { ExportQueue } from "../../export/exportQueue";
import { makeMediaManifest } from "../../model/mediaManifest";
import { Fixtures, ToolHarness } from "./testHarness";
import "./exportGroup";
import { exportToolDeps } from "./exportTools";

const waitForJob = async (queue: ExportQueue, id: string): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    const status = queue.job(id)?.status;
    if (status === "completed" || status === "failed" || status === "canceled") {
      expect(status).toBe("completed");
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("Export job did not finish");
};

const oneClipTimeline = (frames = 30) =>
  Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ mediaRef: "missing", start: 0, duration: frames })] })] });

const never = (): Promise<void> => new Promise(() => {});

describe("export_project tool", () => {
  let queue: ExportQueue;
  beforeEach(() => {
    fake.files.clear();
    fake.dirs.clear();
    for (const d of ["c:/tmp", "c:/users/t/downloads"]) fake.dirs.add(d);
    queue = new ExportQueue();
    exportToolDeps.queue = queue;
  });

  it("rejectsInvalidArguments", async () => {
    const h = new ToolHarness(oneClipTimeline());
    const cases: [Record<string, unknown>, string][] = [
      [{ outputPath: "/tmp/out.mp4", codec: "VP9" }, "codec"],
      [{ outputPath: "/tmp/out.mp4", resolution: "8K" }, "resolution"],
      [{ mode: "edl", outputPath: "/tmp/out.xml" }, "mode"],
      [{ mode: "xml", codec: "H.264", outputPath: "/tmp/out.xml" }, "codec only applies"],
      [{ outputPath: "relative.mp4" }, "absolute"],
      [{ outputPath: "/tmp/out.mov", codec: "H.264" }, ".mp4"],
    ];
    for (const [args, message] of cases) {
      const result = await h.runRaw("export_project", args);
      expect(result.isError).toBe(true);
      expect(ToolHarness.textOf(result)).toContain(message);
    }
    const emptyTimeline = await new ToolHarness().runRaw("export_project", { outputPath: "C:/tmp/out.mp4" });
    expect(emptyTimeline.isError).toBe(true);
    expect(ToolHarness.textOf(emptyTimeline)).toContain("timeline is empty");
  });

  it("handlesDestinationsAndQueue", async () => {
    const h = new ToolHarness(oneClipTimeline());
    fake.files.set("c:/tmp/existing.mp4", "existing");
    const overwriteFalse = await h.runRaw("export_project", { outputPath: "C:/tmp/existing.mp4", overwrite: false });
    expect(overwriteFalse.isError).toBe(true);
    expect(ToolHarness.textOf(overwriteFalse)).toContain("already exists");

    const base = "export-tool-abc";
    h.editor.projectPath = `C:/Projects/${base}.palmier`;
    fake.files.set(`c:/users/t/downloads/${base}.xml`, "existing");
    const unique = await h.runOK("export_project", { mode: "xml" });
    expect(String(unique.path).replace(/\\/g, "/")).toBe(`C:/Users/t/Downloads/${base} 2.xml`);
    await waitForJob(queue, unique.jobId as string);

    const blocker = queue.enqueue({ outputPath: "C:/tmp/export-blocker.mov", projectID: "x", source: "manual", operation: never });
    const result = await h.runOK("export_project", { mode: "video", outputPath: "C:/tmp/export-tool-ui-active.mp4" });
    expect(result.status).toBe("queued");
    expect(result.queuePosition).toBe(1);
    queue.cancel(result.jobId as string);
    queue.cancel(blocker.jobID);
    expect(fake.files.has("c:/tmp/export-tool-ui-active.mp4")).toBe(false);
  });

  it("exportsXMLForANonActiveTimelineById", async () => {
    const h = new ToolHarness();
    const other = oneClipTimeline(42);
    other.name = "B-Roll Cut";
    h.editor.withoutRegistration(() => { h.editor.doc.timelines.push(other); });
    const activeBefore = h.editor.doc.activeTimelineId;

    const result = await h.runOK("export_project", { mode: "xml", outputPath: "C:/tmp/tl.xml", timelineId: other.id.slice(0, 8) });
    expect(result.timeline).toBe("B-Roll Cut");
    expect(result.durationFrames).toBe(42);
    expect(h.editor.doc.activeTimelineId).toBe(activeBefore);
    await waitForJob(queue, result.jobId as string);
    expect(fake.files.get("c:/tmp/tl.xml")).toContain("<name>B-Roll Cut</name>");

    const unknown = await h.runRaw("export_project", { mode: "xml", outputPath: "C:/tmp/x.xml", timelineId: "ffffffff" });
    expect(unknown.isError).toBe(true);
    const palmier = await h.runRaw("export_project", { mode: "palmier", outputPath: "C:/tmp/x.palmier", timelineId: other.id.slice(0, 8) });
    expect(palmier.isError).toBe(true);
    expect(ToolHarness.textOf(palmier)).toContain("palmier");
  });

  it("exportsXML", async () => {
    const nested = Fixtures.clip({ mediaRef: "missing", start: 0, duration: 30 });
    nested.sourceClipType = "sequence";
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [nested] })] }));
    const xml = await h.runOK("export_project", { mode: "xml", outputPath: "C:/tmp/tool.xml" });
    expect(["started", "queued"]).toContain(xml.status);
    expect(xml.mode).toBe("xml");
    expect((xml.warnings as string[]).length).toBe(1);
    await waitForJob(queue, xml.jobId as string);
    expect(fake.files.get("c:/tmp/tool.xml")).toContain('<xmeml version="4">');

    h.editor.withoutRegistration(() => {
      h.editor.doc.mediaManifest = makeMediaManifest();
      h.editor.doc.mediaManifest.entries = [{
        id: "missing", name: "Missing", type: "video", source: { external: { absolutePath: "C:/tmp/missing.mov" } }, duration: 1,
      }];
    });
    const palmier = await h.runOK("export_project", { mode: "palmier", outputPath: "C:/tmp/tool.palmier" });
    await waitForJob(queue, palmier.jobId as string);
    const listed = await h.runOK("manage_exports", { action: "list" });
    const exports = listed.exports as Record<string, unknown>[];
    const first = exports[0];
    expect((first?.warnings as string[]).length).toBe(1);
    const report = first?.result as Record<string, unknown>;
    expect((report.missingMedia as unknown[]).length).toBe(1);
  });

  it("managesCurrentProjectExports", async () => {
    const h = new ToolHarness();
    const projectID = "untitled";
    const active = queue.enqueue({ outputPath: "C:/tmp/active.mov", projectID, source: "manual", operation: never });
    const waiting = queue.enqueue({ outputPath: "C:/tmp/waiting.mov", projectID, source: "manual", operation: async () => {} });
    const other = queue.enqueue({ outputPath: "C:/tmp/other.mov", projectID: "another-project", source: "manual", operation: async () => {} });

    const listed = await h.runOK("manage_exports", { action: "list" });
    const exports = listed.exports as Record<string, unknown>[];
    expect(exports.map((e) => e.jobId)).toEqual([waiting.jobID, active.jobID]);
    expect(exports[0]?.status).toBe("queued");
    expect(exports[0]?.queuePosition).toBe(1);

    const removed = await h.runOK("manage_exports", { action: "cancel", jobId: waiting.jobID });
    expect(removed.status).toBe("removed");
    expect(queue.job(waiting.jobID)?.status).toBe("canceled");

    const canceling = await h.runOK("manage_exports", { action: "cancel", jobId: active.jobID });
    expect(canceling.status).toBe("canceling");
    queue.cancel(other.jobID);
  });
});
