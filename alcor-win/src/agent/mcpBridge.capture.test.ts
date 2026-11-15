import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeAsset, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import "./tools/captureGroup";
import { frameRenderers } from "./tools/captureTools";
import type { RenderedPng } from "./tools/renderTimelineFrame";

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

const settle = () => new Promise((r) => setTimeout(r, 20));
const text = (r: McpToolResult | undefined): string => ((r?.content.find((c) => (c as { type?: string }).type === "text") ?? {}) as { text?: string }).text ?? "";

function fakeHost(editor: Editor, renderTimelineFrame?: AgentHost["renderTimelineFrame"]): AgentHost {
  const host: AgentHost = {
    currentEditor: () => editor,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
  if (renderTimelineFrame) host.renderTimelineFrame = renderTimelineFrame;
  return host;
}

const png = (width: number, height: number, actual?: number): RenderedPng => ({
  bytes: new Uint8Array([137, 80, 78, 71]), width, height, ...(actual !== undefined ? { actualSourceSeconds: actual } : {}),
});

let io: FakeIo;
const original = { ...frameRenderers };
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
  frameRenderers.timeline = async () => png(64, 64);
  frameRenderers.source = async (_asset, seconds) => png(64, 48, seconds);
});
afterEach(() => {
  setMediaIo(undefined);
  Object.assign(frameRenderers, original);
});

function fixture(): { editor: Editor; backend: FakeBackend; sourceId: string } {
  const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 10 })] })], { fps: 5 });
  editor.projectPath = "C:/Proj/Capture.palmier";
  const source = makeAsset({ id: "SRC-VIDEO", type: "video", duration: 2, sourceWidth: 64, sourceHeight: 64 });
  editor.withoutRegistration(() => {
    editor.doc.mediaAssets.push(source);
  });
  return { editor, backend: new FakeBackend(), sourceId: source.id };
}

let counter = 0;
async function call(backend: FakeBackend, name: string, args: Record<string, unknown>): Promise<McpToolResult | undefined> {
  const id = `${name}-${counter++}`;
  backend.call?.({ id, name, arguments: args });
  await settle();
  return backend.responses.get(id);
}

describe("capture_frame", () => {
  it("advertises the schema, captures source and timeline frames, and undoes one asset per call", async () => {
    const { editor, backend, sourceId } = fixture();
    await startAgentMcpBridge(fakeHost(editor), { backend });
    const tool = backend.tools.find((t) => t.name === "capture_frame");
    const props = (tool?.inputSchema as { properties: Record<string, { type: string }> }).properties;
    expect(props.timelineFrame.type).toBe("integer");
    expect(props.mediaRef.type).toBe("string");
    expect(props.sourceSeconds.type).toBe("number");

    const sourceRes = await call(backend, "capture_frame", { mediaRef: sourceId, sourceSeconds: 2, name: "Final source frame" });
    expect(sourceRes?.isError).toBeUndefined();
    const sourceReceipt = JSON.parse(text(sourceRes));
    expect(sourceReceipt).toMatchObject({
      status: "ready", name: "Final source frame", type: "image", mimeType: "image/png", width: 64, height: 48,
      capturedFrom: { mediaRef: sourceId, sourceSeconds: 2, actualSourceSeconds: 2 },
    });
    const sourceAsset = editor.mediaAssets.find((a) => a.id.startsWith(sourceReceipt.mediaRef as string));
    expect(sourceAsset?.type).toBe("image");
    expect(sourceAsset?.duration).toBe(5);
    expect(sourceAsset?.sourceWidth).toBe(64);
    expect(sourceAsset?.url).toMatch(/^C:\/Proj\/Capture\.palmier\/media\/frame-[0-9a-f]{8}\.png$/);
    expect(io.has(sourceAsset?.url ?? "")).toBe(true);
    expect(editor.doc.mediaManifest.entries.some((e) => e.id === sourceAsset?.id)).toBe(true);

    const timelineRes = await call(backend, "capture_frame", { timelineFrame: 0 });
    const timelineReceipt = JSON.parse(text(timelineRes));
    expect(timelineReceipt.name).toBe("Frame 0");
    expect(timelineReceipt.capturedFrom.timelineFrame).toBe(0);
    expect(editor.timeline.id.startsWith(timelineReceipt.capturedFrom.timelineId as string)).toBe(true);
    expect(editor.mediaAssets.length).toBe(3);

    await call(backend, "undo", {});
    expect(editor.mediaAssets.map((a) => a.id)).toContain(sourceAsset?.id);
    expect(editor.mediaAssets.length).toBe(2);
    await call(backend, "undo", {});
    expect(editor.mediaAssets.map((a) => a.id)).toEqual([sourceId]);
  });

  it("rejects invalid requests without creating assets", async () => {
    const { editor, backend, sourceId } = fixture();
    await startAgentMcpBridge(fakeHost(editor), { backend });
    const bad: Record<string, unknown>[] = [
      { timelineFrame: 0, mediaRef: sourceId, sourceSeconds: 0 },
      { timelineFrame: "0" },
      { mediaRef: sourceId },
      { sourceSeconds: 1 },
      { timelineFrame: 10 },
      { timelineFrame: -1 },
      { timelineFrame: 0, name: "   " },
      { timelineFrame: 0, name: "x".repeat(201) },
      { timelineFrame: 0, extra: 1 },
      {},
    ];
    for (const args of bad) expect((await call(backend, "capture_frame", args))?.isError, JSON.stringify(args)).toBe(true);
    expect(text(await call(backend, "capture_frame", { timelineFrame: 0, mediaRef: sourceId, sourceSeconds: 0 })))
      .toBe("Provide exactly one capture mode: timelineFrame, or mediaRef with sourceSeconds.");
    expect(text(await call(backend, "capture_frame", { timelineFrame: 10 }))).toBe("Timeline frame 10 is outside 0..<10.");
    expect(text(await call(backend, "capture_frame", { mediaRef: "NOPE", sourceSeconds: 0 }))).toContain("Media asset not found");
    expect(editor.mediaAssets.map((a) => a.id)).toEqual([sourceId]);
  });

  it("needs an open project and a video asset", async () => {
    const { editor, backend } = fixture();
    const image = makeAsset({ id: "IMG", type: "image", duration: 5 });
    editor.withoutRegistration(() => {
      editor.doc.mediaAssets.push(image);
    });
    await startAgentMcpBridge(fakeHost(editor), { backend });
    expect(text(await call(backend, "capture_frame", { mediaRef: "IMG", sourceSeconds: 0 }))).toBe("Media asset IMG is not a video.");
    editor.projectPath = null;
    expect(text(await call(backend, "capture_frame", { timelineFrame: 0 }))).toBe("No project is open.");
  });
});

describe("inspect_timeline with a host renderer", () => {
  it("returns one overlay image per sampled frame plus metadata", async () => {
    const { editor, backend } = fixture();
    const rendered: [number, number][] = [];
    await startAgentMcpBridge(fakeHost(editor, async (_e, frame, longestEdge) => {
      rendered.push([frame, longestEdge]);
      return "QUJD";
    }), { backend });
    const res = await call(backend, "inspect_timeline", { startFrame: 0, endFrame: 10, maxFrames: 2 });
    expect(res?.isError).toBeUndefined();
    expect(rendered).toEqual([[2, 512], [7, 512]]);
    expect(res?.content.filter((c) => (c as { type?: string }).type === "image").length).toBe(2);
    const meta = JSON.parse(text(res));
    expect(meta.coordinateGrid).toBe("0-1, origin top-left");
    expect(meta.frames).toEqual([{ frame: 2, clips: ["c1"] }, { frame: 7, clips: ["c1"] }]);
  });

  it("fails when no frame can be drawn", async () => {
    const { editor, backend } = fixture();
    await startAgentMcpBridge(fakeHost(editor, async () => null), { backend });
    const res = await call(backend, "inspect_timeline", {});
    expect(res?.isError).toBe(true);
    expect(text(res)).toBe("Failed to render timeline frames.");
  });
});
