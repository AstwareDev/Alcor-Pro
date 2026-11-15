import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { ToolHarness } from "./testHarness";
import { mcpServerTools, type JsonObject } from "./toolRegistry";
import { toMcpResult } from "./toolResult";

type Json = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as JsonObject; // checked by the expect above
}

describe("image adjustment Agent tool", () => {
  function firstClip(timeline: Json): Json | undefined {
    const tracks = timeline.tracks as Json[] | undefined;
    const clips = tracks?.[0]?.clips as Json[] | undefined;
    return clips?.[0];
  }

  it("MCPDiscoveryMutationReadbackValidationAndUndo", async () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const tool = mcpServerTools().find((r) => r.definition.name === "set_clip_properties");
    expect(tool).toBeDefined();
    const properties = asObject(tool?.definition.inputSchema.properties);
    expect(asObject(properties.edgeRounding).type).toBe("number");
    expect(asObject(properties.edgeSoftness).type).toBe("number");

    const mutation = await h.executor.execute("set_clip_properties", { clipIds: [clip.id], edgeRounding: 0.4, edgeSoftness: 0.25 }, "mcp");
    expect(toMcpResult(mutation).isError).toBeUndefined();
    const receipt = JSON.parse(ToolHarness.textOf(mutation)) as Json;
    const changed = receipt.clips as Json[];
    expect(changed[0].edgeRounding).toBe(0.4);
    expect(changed[0].edgeSoftness).toBe(0.25);

    const timeline = await h.runOK("get_timeline");
    expect(firstClip(timeline)?.edgeRounding).toBe(0.4);
    expect(firstClip(timeline)?.edgeSoftness).toBe(0.25);

    const invalid = await h.executor.execute("set_clip_properties", { clipIds: [clip.id], edgeSoftness: 1.1 }, "mcp");
    expect(toMcpResult(invalid).isError).toBe(true);
    expect(h.editor.clipFor(clip.id)?.edgeRounding).toBe(0.4);
    expect(h.editor.clipFor(clip.id)?.edgeSoftness).toBe(0.25);

    const undo = await h.executor.execute("undo", {}, "mcp");
    expect(toMcpResult(undo).isError).toBeUndefined();
    const restored = await h.runOK("get_timeline");
    expect(firstClip(restored)?.edgeRounding).toBeUndefined();
    expect(firstClip(restored)?.edgeSoftness).toBeUndefined();
    expect(h.editor.clipFor(clip.id)?.edgeRounding).toBe(0);
    expect(h.editor.clipFor(clip.id)?.edgeSoftness).toBe(0);
  });
});
