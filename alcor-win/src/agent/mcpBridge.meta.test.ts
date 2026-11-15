import { describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import "./tools/metaGroup";
import { memorySkillFs } from "./skills/skillFs";
import { SkillStore } from "./skills/skillStore";
import { useSkillStore } from "./tools/skillTools";

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

const settle = () => new Promise((r) => setTimeout(r, 20));
const text = (r: McpToolResult | undefined): string => ((r?.content[0] ?? {}) as { text?: string }).text ?? "";

describe("MCP bridge: meta tools", () => {
  it("keeps the in-app skill tools and the unported send_feedback off the MCP server", async () => {
    const store = new SkillStore("/skills", memorySkillFs());
    await store.reloadSkills();
    const restore = useSkillStore(async () => store);
    try {
      const backend = new FakeBackend();
      await startAgentMcpBridge(fakeHost(makeEditor([Fixtures.videoTrack({ clips: [] })])), { backend });
      const names = backend.tools.map((t) => t.name);
      for (const hidden of ["read_skill", "manage_skills", "send_feedback"]) expect(names).not.toContain(hidden);

      backend.call?.({ id: "1", name: "manage_skills", arguments: { action: "create", name: "Private", description: "d", instructions: "i" } });
      backend.call?.({ id: "2", name: "read_skill", arguments: { id: "private" } });
      await settle();
      for (const id of ["1", "2"]) {
        expect(backend.responses.get(id)?.isError).toBe(true);
        expect(text(backend.responses.get(id))).toContain("Unknown tool");
      }
      expect(store.skills).toEqual([]);
    } finally {
      restore();
    }
  });
});
