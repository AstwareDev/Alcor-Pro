import { describe, expect, it } from "vitest";
import { cropIsIdentity } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { ToolHarness } from "./testHarness";
import { mcpServerTools, type JsonObject } from "./toolRegistry";
import { toMcpResult } from "./toolResult";

type Json = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as JsonObject; // checked by the expect above
}

describe("static crop Agent tool", () => {
  function clipCrop(timeline: Json): Json | undefined {
    const tracks = timeline.tracks as Json[] | undefined;
    const clips = tracks?.[0]?.clips as Json[] | undefined;
    return clips?.[0]?.crop as Json | undefined;
  }

  it("MCPDiscoveryMutationReadbackValidationAndUndo", async () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const tool = mcpServerTools().find((r) => r.definition.name === "set_clip_properties");
    expect(tool).toBeDefined();
    const properties = asObject(tool?.definition.inputSchema.properties);
    const crop = asObject(properties.crop);
    expect(crop.type).toBe("object");
    const cropFields = asObject(crop.properties);
    for (const key of ["left", "top", "right", "bottom"]) {
      expect(asObject(cropFields[key]).type).toBe("number");
    }

    const mutation = await h.executor.execute(
      "set_clip_properties",
      { clipIds: [clip.id], crop: { left: 0.2, top: 0.1, right: 0.15, bottom: 0.05 } },
      "mcp",
    );
    expect(toMcpResult(mutation).isError).toBeUndefined();
    const receipt = JSON.parse(ToolHarness.textOf(mutation)) as Json;
    const changed = receipt.clips as Json[];
    const receiptCrop = changed[0].crop as Json;
    expect(receiptCrop.left).toBe(0.2);
    expect(receiptCrop.top).toBe(0.1);
    expect(receiptCrop.right).toBe(0.15);
    expect(receiptCrop.bottom).toBe(0.05);

    const timeline = await h.runOK("get_timeline");
    const timelineCrop = clipCrop(timeline);
    expect(timelineCrop).toBeDefined();
    expect(timelineCrop?.left).toBe(0.2);
    expect(timelineCrop?.top).toBe(0.1);

    const invalid = await h.executor.execute("set_clip_properties", { clipIds: [clip.id], crop: { left: 0.5, right: 0.5 } }, "mcp");
    expect(toMcpResult(invalid).isError).toBe(true);
    expect(h.editor.clipFor(clip.id)?.crop.left).toBe(0.2);

    const undo = await h.executor.execute("undo", {}, "mcp");
    expect(toMcpResult(undo).isError).toBeUndefined();
    const restored = await h.runOK("get_timeline");
    expect(clipCrop(restored)).toBeUndefined();
    const restoredClip = h.editor.clipFor(clip.id);
    expect(restoredClip && cropIsIdentity(restoredClip.crop)).toBe(true);
  });
});
