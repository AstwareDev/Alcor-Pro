import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP text animations", () => {
  it("discoveryAndValidationExcludeRemovedPresets", async () => {
    const clip = Fixtures.clip({ id: "title", mediaRef: "text", mediaType: "text", start: 0, duration: 60 });
    clip.textContent = "Title";
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    const tool = mcpServerTools().find((r) => r.definition.name === "update_text");
    if (!tool) throw new Error("update_text not listed");
    const properties = (tool.definition.inputSchema as Json).properties as Json;
    const presets = (properties.animation as Json).enum as unknown[];

    for (const preset of ["fadeIn", "wordPop", "wordCycle"]) {
      expect(presets).not.toContain(preset);
      const result = await h.runRaw("update_text", { clipIds: [clip.id], animation: preset });
      expect(result.isError).toBe(true);
      expect(h.editor.clipFor(clip.id)?.textAnimation).toBeUndefined();
    }
  });
});
