import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Editor } from "../editor/editor";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { mediaHooks } from "../media/mediaHooks";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { mcpServerInstructions, startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import { setInspectBackend } from "./tools/inspectBackend";
import { transcriptOf } from "./tools/mediaTestSupport";

// One call per media tool through the real MCP bridge, reading state back.

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  responses = new Map<string, McpToolResult>();
  call: ((c: McpCall) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; }
  async setInstructions(_t: string | null) {}
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient(_h: (i: unknown) => void) { return () => undefined; }
}

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const textOf = (r: McpToolResult | undefined): string => ((r?.content.find((c) => (c as { type?: string }).type === "text") ?? {}) as { text?: string }).text ?? "";

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
  mediaHooks.parseSubtitleDuration = async () => 3;
});
afterEach(() => {
  setMediaIo(undefined);
  setInspectBackend(undefined);
  delete mediaHooks.parseSubtitleDuration;
});

describe("MCP media tools", () => {
  it("advertisesGetInspectImportOrganizeAndSearch", async () => {
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(makeEditor()), { backend });
    const names = backend.tools.map((t) => t.name);
    for (const name of ["get_media", "inspect_media", "import_media", "organize_media", "search_media"]) expect(names).toContain(name);
    expect(mcpServerInstructions.length).toBeGreaterThan(0);
  });

  it("importsThenReadsBackThroughGetAndInspect", async () => {
    const backend = new FakeBackend();
    const editor = makeEditor([Fixtures.videoTrack({ clips: [] })]);
    editor.projectPath = "C:/Proj/Media.palmier";
    io.addFile("/refs/talk.srt", "1\n00:00:00,000 --> 00:00:03,000\nHello\n");
    setInspectBackend({
      readImage: async () => null,
      videoFrames: async () => "noVideoTrack",
      overview: async () => { throw new Error("unused"); },
      transcribe: async () => transcriptOf([["unused", 0, 1, ["unused"]]]),
    });
    await startAgentMcpBridge(fakeHost(editor), { backend });

    backend.call?.({ id: "1", name: "import_media", arguments: { source: { path: "/refs/talk.srt" }, name: "Talk", folder: "Refs" } });
    await settle();
    const imported = JSON.parse(textOf(backend.responses.get("1"))) as { mediaRef: string; status: string };
    expect(imported.status).toBe("ready");
    expect(editor.mediaAssets[0].name).toBe("Talk");

    backend.call?.({ id: "2", name: "get_media", arguments: {} });
    await settle();
    const library = JSON.parse(textOf(backend.responses.get("2"))) as { assets: { id: string; name: string; type: string; folder: string; durationSeconds: number }[]; folders: string[] };
    expect(library.folders).toEqual(["Refs"]);
    expect(library.assets).toEqual([{ id: imported.mediaRef, name: "Talk", type: "subtitle", durationSeconds: 3, folder: "Refs" }]);

    backend.call?.({ id: "3", name: "inspect_media", arguments: { mediaRef: imported.mediaRef } });
    await settle();
    const inspected = JSON.parse(textOf(backend.responses.get("3"))) as { cueCount: number; cues: { text: string }[] };
    expect(inspected.cueCount).toBe(1);
    expect(inspected.cues[0].text).toBe("Hello");

    backend.call?.({ id: "4", name: "organize_media", arguments: { renames: [{ item: imported.mediaRef, name: "Talk 2" }] } });
    await settle();
    expect(backend.responses.get("4")?.isError).toBeUndefined();
    expect(editor.mediaAssets[0].name).toBe("Talk 2");
  });

  it("answersBadArgumentsWithErrors", async () => {
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(makeEditor()), { backend });
    backend.call?.({ id: "a", name: "import_media", arguments: {} });
    backend.call?.({ id: "b", name: "inspect_media", arguments: { mediaRef: "nope" } });
    backend.call?.({ id: "c", name: "frobnicate_media", arguments: { query: "dog" } });
    await settle();
    expect(textOf(backend.responses.get("a"))).toBe("Missing required 'source' object");
    expect(textOf(backend.responses.get("b"))).toBe("Media asset not found: nope");
    expect(textOf(backend.responses.get("c"))).toBe("Unknown tool: frobnicate_media");
    expect(backend.responses.get("c")?.isError).toBe(true);
  });
});
