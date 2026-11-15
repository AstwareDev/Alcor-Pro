import { describe, expect, it } from "vitest";
import { TrackName } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";
import type { ToolResult } from "./toolResult";

type Json = Record<string, unknown>;

describe("MCP track names", () => {
  it("discoveryNamingReadbackAndUndoRoundTrip", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack()] }));
    const tool = mcpServerTools().find((r) => r.definition.name === "manage_tracks");
    if (!tool) throw new Error("manage_tracks not listed");
    const setSchema = ((tool.definition.inputSchema as Json).properties as Json).set as Json;
    const nameSchema = ((setSchema.items as Json).properties as Json).name as Json;
    expect(nameSchema.type).toBe("string");
    expect(nameSchema.maxLength).toBe(TrackName.maximumLength);
    expect(String(nameSchema.description)).toContain("exactly one short word");

    const setName = (name: string, trackId: string): Promise<ToolResult> =>
      h.runRaw("manage_tracks", { set: [{ trackId, name }] });
    const json = (r: ToolResult): Json => JSON.parse(ToolHarness.textOf(r)) as Json;
    const firstTrack = async (): Promise<Json> => ((await h.runOK("get_timeline")).tracks as Json[])[0];
    const changed = (r: ToolResult): unknown => (json(r).renamed as Json[])[0].changed;

    const trackId = (await firstTrack()).trackId as string;
    const rename = await setName("Dialogue", trackId);
    expect(changed(rename)).toBe(true);
    const renamedTrack = await firstTrack();
    expect(renamedTrack.label).toBe("A1");
    expect(renamedTrack.name).toBe("Dialogue");
    expect(changed(await setName("Dialogue", trackId))).toBe(false);
    expect((await setName("Line one\nLine two", trackId)).isError).toBe(true);
    expect(changed(await setName("", trackId))).toBe(true);
    expect((await firstTrack()).name).toBeUndefined();
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect((await firstTrack()).name).toBe("Dialogue");
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect((await firstTrack()).name).toBeUndefined();
    expect((await h.runRaw("undo")).isError).toBe(true);
  });
});
