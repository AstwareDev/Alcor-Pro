import { describe, expect, it } from "vitest";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP custom aspect ratio", () => {
  it("discoveryMutationReadbackValidationNoOpAndUndo", async () => {
    const h = new ToolHarness();
    h.editor.withoutRegistration(() => {
      h.editor.timeline.settingsConfigured = true;
    });

    const tool = mcpServerTools().find((r) => r.definition.name === "set_project_settings");
    if (!tool) throw new Error("set_project_settings not listed");
    const properties = (tool.definition.inputSchema as Json).properties as Json;
    const aspectRatioSchema = properties.aspectRatio as Json;
    expect(aspectRatioSchema.type).toBe("string");
    expect(aspectRatioSchema.enum).toBeUndefined();

    const expectTimelineSize = async (width: number, height: number): Promise<void> => {
      const timeline = await h.runOK("get_timeline");
      expect(timeline.width).toBe(width);
      expect(timeline.height).toBe(height);
    };

    const changed = await h.runRaw("set_project_settings", { aspectRatio: "2.39:1", quality: "4K" });
    expect(changed.isError, ToolHarness.textOf(changed)).toBe(false);
    const changedReceipt = JSON.parse(ToolHarness.textOf(changed)) as Json;
    expect(changedReceipt.resolution).toBe("5162x2160");
    expect(changedReceipt.changed).toEqual(["resolution"]);
    await expectTimelineSize(5162, 2160);

    const invalid = await h.runRaw("set_project_settings", { width: 1440 });
    expect(invalid.isError).toBe(true);
    await expectTimelineSize(5162, 2160);

    const repeated = await h.runRaw("set_project_settings", { aspectRatio: "2.39:1", quality: "4K" });
    expect(repeated.isError).toBe(false);
    const repeatedReceipt = JSON.parse(ToolHarness.textOf(repeated)) as Json;
    expect(repeatedReceipt.changed).toEqual([]);

    expect((await h.runRaw("undo")).isError).toBe(false);
    await expectTimelineSize(1920, 1080);
    expect((await h.runRaw("undo")).isError).toBe(true);
  });
});
