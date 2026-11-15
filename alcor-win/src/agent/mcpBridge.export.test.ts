import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["c:/out", "c:/users/t/downloads"]);
  const key = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  return { files, dirs, key };
});

vi.mock("../platform/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/backend")>()),
  fsStat: async (p: string) => {
    const k = fake.key(p);
    const isDir = fake.dirs.has(k);
    return isDir || fake.files.has(k) ? { name: p, path: p, isDir, size: fake.files.get(k)?.length ?? 0, modifiedMs: 0 } : null;
  },
  fsWriteText: async (p: string, t: string) => { fake.files.set(fake.key(p), t); },
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
  appPaths: async () => ({ projects: "C:/d", appData: "C:/a", cache: "C:/c", temp: "C:/t", downloads: "C:/Users/t/Downloads" }),
}));

import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { ExportQueue } from "../export/exportQueue";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import "./tools/exportGroup";
import { exportToolDeps } from "./tools/exportTools";

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  responses = new Map<string, McpToolResult>();
  call: ((c: McpCall) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; }
  async setInstructions() {}
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient() { return () => undefined; }
}

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    onCurrentEditorChange: () => () => undefined,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
}

const text = (r: McpToolResult | undefined): string => ((r?.content[0] ?? {}) as { text?: string }).text ?? "";
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };

describe("MCP bridge: export tools", () => {
  let queue: ExportQueue;
  beforeEach(() => {
    fake.files.clear();
    queue = new ExportQueue();
    exportToolDeps.queue = queue;
  });

  async function setup() {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ mediaRef: "missing", start: 0, duration: 48 })] })]);
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(editor), { backend });
    let n = 0;
    const run = async (name: string, args: unknown): Promise<McpToolResult> => {
      const id = `call-${++n}`;
      backend.call?.({ id, name, arguments: args });
      await until(() => backend.responses.has(id));
      const res = backend.responses.get(id);
      if (!res) throw new Error(`no response for ${name}`);
      return res;
    };
    return { backend, editor, run };
  }

  it("advertises export_project and manage_exports with their Swift schemas", async () => {
    const { backend } = await setup();
    const names = backend.tools.map((t) => t.name);
    expect(names).toContain("export_project");
    expect(names).toContain("manage_exports");
    const schema = backend.tools.find((t) => t.name === "export_project")?.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties["mode"]?.enum).toEqual(["video", "xml", "fcpxml", "palmier"]);
  });

  it("exports fcpxml, then reads the job back through manage_exports", async () => {
    const { run } = await setup();
    const started = JSON.parse(text(await run("export_project", { mode: "fcpxml", fcpxmlTarget: "fcp", outputPath: "C:/out/cut.fcpxml" })));
    expect(["started", "queued"]).toContain(started.status);
    expect(started).toMatchObject({ mode: "fcpxml", format: "FCPXML", durationFrames: 48, path: "C:\\out\\cut.fcpxml" });
    await until(() => queue.job(started.jobId)?.status === "completed");
    expect(fake.files.get("c:/out/cut.fcpxml")).toContain("<fcpxml");

    const listed = JSON.parse(text(await run("manage_exports", { action: "list" })));
    expect(listed.exports).toHaveLength(1);
    expect(listed.exports[0]).toMatchObject({ jobId: started.jobId, filename: "cut.fcpxml", status: "completed", progress: 100 });
  });

  it("writes to Downloads by default and refuses bad destinations", async () => {
    const { run, editor } = await setup();
    editor.projectPath = "C:/Projects/My Film.palmier";
    const xml = JSON.parse(text(await run("export_project", { mode: "xml" })));
    expect(xml.path).toBe("C:\\Users\\t\\Downloads\\My Film.xml");
    await until(() => queue.job(xml.jobId)?.status === "completed");
    expect(fake.files.has("c:/users/t/downloads/my film.xml")).toBe(true);

    const second = JSON.parse(text(await run("export_project", { mode: "xml" })));
    expect(second.path).toBe("C:\\Users\\t\\Downloads\\My Film 2.xml");
    const noDir = await run("export_project", { mode: "xml", outputPath: "C:/missing/a.xml" });
    expect(noDir.isError).toBe(true);
    expect(text(noDir)).toBe("export_project: output directory does not exist");
    const wrongExt = await run("export_project", { mode: "fcpxml", outputPath: "C:/out/a.xml" });
    expect(text(wrongExt)).toBe("export_project: FCPXML exports must use .fcpxml");
    const prores = await run("export_project", { codec: "ProRes", outputPath: "C:/out/a.mov" });
    expect(prores.isError).toBe(true);
    expect(text(prores)).toContain("ProRes");
  });

  it("queues a video export behind a running one and cancels it by id", async () => {
    const { run } = await setup();
    const blocker = queue.enqueue({ outputPath: "C:/out/blocker.mp4", projectID: "x", source: "manual", operation: () => new Promise<void>(() => {}) });
    const video = JSON.parse(text(await run("export_project", { codec: "H.265", resolution: "1080p", outputPath: "C:/out/film" })));
    expect(video).toMatchObject({ status: "queued", queuePosition: 1, mode: "video", format: "H.265", path: "C:\\out\\film.mp4" });
    const cancelled = JSON.parse(text(await run("manage_exports", { action: "cancel", jobId: video.jobId })));
    expect(cancelled).toEqual({ jobId: video.jobId, filename: "film.mp4", status: "removed", cancellationRequested: true });
    const missing = await run("manage_exports", { action: "cancel", jobId: "11111111-2222-3333-4444-555555555555" });
    expect(text(missing)).toBe("manage_exports: export not found in the current project");
    queue.cancel(blocker.jobID);
  });
});
