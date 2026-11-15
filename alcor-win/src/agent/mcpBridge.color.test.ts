import { describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeAsset, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { colorFrameIO } from "./tools/colorFrames";
import "./tools/colorGroup";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  responses = new Map<string, McpToolResult>();
  call: ((c: McpCall) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; }
  async setInstructions() {}
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient() { return () => {}; }
}

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    listProjects: async () => [],
    openProject: async () => editor,
    createProject: async () => editor,
    closeProject: async () => {},
    displayName: () => "Test",
    renderTimelineFrame: async () => "SlBFRw==",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const textOf = (r: McpToolResult | undefined): string => (((r?.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text") ?? {}) as { text?: string }).text ?? "";

describe("MCP bridge color tools", () => {
  it("advertises, applies, reads back and inspects color and effects", async () => {
    const backend = new FakeBackend();
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, mediaRef: "m1" })] })]);
    editor.withoutRegistration(() => {
      editor.doc.mediaAssets.push(makeAsset({ id: "m1", type: "video", duration: 5 }));
    });
    await startAgentMcpBridge(fakeHost(editor), { backend });
    const names = backend.tools.map((t) => t.name);
    for (const name of ["apply_color", "apply_effect", "inspect_color"]) expect(names).toContain(name);
    expect(names).toContain("denoise_audio");

    let n = 0;
    const run = async (name: string, args: Record<string, unknown>): Promise<McpToolResult | undefined> => {
      const id = String(++n);
      backend.call?.({ id, name, arguments: args });
      await settle();
      return backend.responses.get(id);
    };

    const graded = await run("apply_color", { clipIds: ["c1"], exposure: 0.4, shadowsHue: 180, shadowsAmount: 0.15 });
    expect(graded?.isError).toBeUndefined();
    expect(JSON.parse(textOf(graded)).clips[0].color).toEqual({ exposure: 0.4, shadowsHue: 180, shadowsAmount: 0.15 });
    expect(editor.clipFor("c1")?.effects?.map((e) => e.type)).toEqual(["color.exposure", "color.wheels"]);
    expect(editor.store.undoActionName).toBe("Color Grade (Agent)");

    const fx = await run("apply_effect", { clipIds: ["c1"], effects: [{ type: "stylize.vignette", params: { amount: -3 } }] });
    expect(JSON.parse(textOf(fx)).clips[0].effects).toEqual([{ type: "stylize.vignette", params: { amount: -1, midpoint: 0.5, roundness: 0, feather: 0.5 } }]);

    const timeline = JSON.parse(textOf(await run("get_timeline", {})));
    expect(timeline.tracks[0].clips[0].color.exposure).toBe(0.4);

    const original = { ...colorFrameIO };
    colorFrameIO.gridFromJpeg = async (_b64, size) =>
      new Uint8ClampedArray(Array.from({ length: size * size * 4 }, (_, i) => (i % 4 === 3 ? 255 : 128)));
    try {
      const inspected = await run("inspect_color", { clipId: "c1" });
      expect(inspected?.isError).toBeUndefined();
      expect((inspected?.content as { type: string }[]).map((c) => c.type)).toEqual(["image", "text"]);
      expect(JSON.parse(textOf(inspected)).clip.saturation).toBe(0);
    } finally {
      Object.assign(colorFrameIO, original);
    }

    const bad = await run("apply_color", { clipIds: ["c1"] });
    expect(bad?.isError).toBe(true);
    expect(textOf(bad)).toBe("No grade parameters provided.");

    expect((await run("undo", {}))?.isError).toBeUndefined();
    expect(editor.clipFor("c1")?.effects?.map((e) => e.type)).toEqual(["color.exposure", "color.wheels"]);
  });
});
