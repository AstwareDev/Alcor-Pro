import { describe, expect, it } from "vitest";
import type { Editor } from "../../editor/editor";
import type { AgentHost } from "./agentHost";
import { ToolHarness } from "./testHarness";
import { ToolExecutor } from "./toolExecutor";
import { mcpServerTools, type JsonObject } from "./toolRegistry";

function asObject(value: unknown): JsonObject {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as JsonObject; // checked by the expect above
}

/** In-memory host: one open editor, no registered projects. */
function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    listProjects: async () => [],
    openProject: async () => {
      throw new Error("unused");
    },
    createProject: async () => {
      throw new Error("unused");
    },
    closeProject: async () => {},
    displayName: () => "Fake",
  };
}

describe("manage_project tool", () => {
  it("replacesIndividualProjectTools", () => {
    const names = new Set(mcpServerTools().map((r) => r.definition.name));

    expect(names.has("manage_project")).toBe(true);
    expect(names.has("get_projects")).toBe(false);
    expect(names.has("open_project")).toBe(false);
    expect(names.has("new_project")).toBe(false);
    expect(names.has("close_project")).toBe(false);

    const tool = mcpServerTools().find((r) => r.definition.name === "manage_project");
    expect(tool).toBeDefined();
    const properties = asObject(tool?.definition.inputSchema.properties);
    const action = asObject(properties.action);
    const actions = action.enum as string[];
    const aspectRatio = asObject(properties.aspectRatio);
    expect(actions).toEqual(["list", "open", "create", "close"]);
    expect(actions.includes("delete")).toBe(false);
    expect(aspectRatio.type).toBe("string");
    expect(aspectRatio.enum).toBeUndefined();
  });

  it("rejectsDeleteAndActionSpecificFields", async () => {
    const executor = ToolExecutor.forSession(fakeHost(new ToolHarness().editor));

    const del = await executor.execute("manage_project", { action: "delete" }, "mcp");
    expect(del.isError).toBe(true);
    expect(ToolHarness.textOf(del)).toContain("Unknown project action");

    const invalidList = await executor.execute("manage_project", { action: "list", name: "Example" }, "mcp");
    expect(invalidList.isError).toBe(true);
    expect(ToolHarness.textOf(invalidList)).toContain("Allowed: none");
  });

  it("rejectsInvalidAndConflictingSelectors", async () => {
    const executor = ToolExecutor.forSession(fakeHost(new ToolHarness().editor));
    const cases: Record<string, unknown>[] = [
      { action: "open" },
      { action: "open", name: "A", path: "/tmp/A.palmier" },
      { action: "close", id: "A", path: "/tmp/A.palmier" },
      { action: "open", name: "" },
      { action: "close", path: "   " },
      { action: "open", id: "not-a-project-id" },
      { action: "create", name: 42 },
    ];

    for (const args of cases) {
      const result = await executor.execute("manage_project", args, "mcp");
      expect(result.isError, `Expected rejection for ${JSON.stringify(args)}`).toBe(true);
    }
  });
});
