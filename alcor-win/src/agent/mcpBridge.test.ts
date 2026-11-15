import { describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { mcpServerInstructions, startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import { defineTools, registeredTools } from "./tools/toolRegistry";
import { ok } from "./tools/toolResult";

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  pushes = 0;
  instructions: string | null = null;
  responses = new Map<string, McpToolResult>();
  call: ((c: McpCall) => void) | null = null;
  client: ((i: unknown) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; this.pushes += 1; }
  async setInstructions(t: string | null) { this.instructions = t; }
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient(h: (i: unknown) => void) { this.client = h; return () => { this.client = null; }; }
}

function fakeHost(initial: Editor | null): AgentHost & { editor: Editor | null; listeners: (() => void)[] } {
  const host = {
    editor: initial,
    listeners: [] as (() => void)[],
    currentEditor: () => host.editor,
    onCurrentEditorChange: (l: () => void) => { host.listeners.push(l); return () => undefined; },
    listProjects: async () => [],
    openProject: async () => { throw new Error("No such file"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
  return host;
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const text = (r: McpToolResult | undefined): string => ((r?.content[0] ?? {}) as { text?: string }).text ?? "";

describe("MCP bridge", () => {
  it("pushes tools and instructions, advertising only registered tools", async () => {
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(null), { backend });
    const names = backend.tools.map((t) => t.name);
    expect(backend.instructions).toBe(mcpServerInstructions);
    expect(names).toContain("get_timeline");
    expect(names).toContain("manage_project");
    for (const pending of ["send_feedback", "read_skill"]) expect(names).not.toContain(pending);
    for (const live of ["get_media", "search_media", "capture_frame", "apply_color", "export_project", "generate_image", "get_transcript", "add_captions", "remove_silence", "sync_clips", "manage_multicam", "change_cam", "get_multicam"]) expect(names).toContain(live);
    expect(names.length).toBe(registeredTools().filter((r) => r.inAppOnly !== true).length);
  });

  it("runs mcp calls against the open editor and reads state back", async () => {
    const backend = new FakeBackend();
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })]);
    await startAgentMcpBridge(fakeHost(editor), { backend });
    backend.call?.({ id: "1", name: "split_clips", arguments: { trackIndex: 0, frames: [40] } });
    await settle();
    const res = backend.responses.get("1");
    expect(res?.isError).toBeUndefined();
    expect(JSON.parse(text(res)).clips.length).toBeGreaterThan(0);
    expect(editor.timeline.tracks[0].clips.map((c) => c.durationFrames)).toEqual([40, 60]);
    expect(editor.store.undoActionName).toBe("Split Clip (Agent)");

    backend.call?.({ id: "2", name: "get_timeline", arguments: {} });
    await settle();
    const tl = JSON.parse(text(backend.responses.get("2")));
    expect(tl.tracks[0].clips.length).toBe(2);
  });

  it("answers errors without a project, unknown tools and bad arguments", async () => {
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(null), { backend });
    backend.call?.({ id: "a", name: "get_timeline", arguments: {} });
    backend.call?.({ id: "b", name: "nope", arguments: {} });
    backend.call?.({ id: "c", name: "manage_project", arguments: { action: "list" } });
    backend.call?.({ id: "d", name: "get_timeline", arguments: [] });
    backend.call?.({ id: "e", name: "manage_project", arguments: { action: "open", path: "C:/x.palmier" } });
    await settle();
    expect(text(backend.responses.get("a"))).toBe("Editor not available");
    expect(backend.responses.get("a")?.isError).toBe(true);
    expect(text(backend.responses.get("b"))).toBe("Unknown tool: nope");
    expect(JSON.parse(text(backend.responses.get("c"))).openCount).toBe(0);
    expect(backend.responses.get("d")?.isError).toBe(true);
    expect(text(backend.responses.get("e"))).toBe("No project at C:/x.palmier.");
  });

  it("re-pushes only when the registered tool list changes, and records client info", async () => {
    const backend = new FakeBackend();
    const host = fakeHost(null);
    const bridge = await startAgentMcpBridge(host, { backend });
    const before = backend.pushes;
    host.listeners.forEach((l) => l());
    await bridge.refresh();
    expect(backend.pushes).toBe(before);
    defineTools("zz-test", [{ definition: { name: "zz_test", description: "d", inputSchema: { type: "object" } }, run: () => ok("hi") }]);
    await settle();
    expect(backend.pushes).toBe(before + 1);
    expect(backend.tools.some((t) => t.name === "zz_test")).toBe(true);
    defineTools("zz-test", []);
    await settle();
    backend.client?.({ name: "claude-code", version: "1" });
    expect(bridge.clientInfo()).toEqual({ name: "claude-code", version: "1" });
    bridge.dispose();
  });
});
