import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import "./colorGroup";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function invertEffect(payload: Json): Json | undefined {
  const changed = payload.clips as Json[] | undefined;
  const clips = changed ?? ((payload.tracks as Json[] | undefined) ?? []).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
  const effects = clips[0]?.effects as Json[] | undefined;
  return effects?.find((e) => e.type === "stylize.invert");
}

describe("MCP invert effect", () => {
  it("discoveryMutationReadbackValidationAndUndo", async () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const tool = mcpServerTools().find((r) => r.definition.name === "apply_effect");
    expect(tool?.definition.description.includes("stylize.invert — Invert: no params")).toBe(true);

    const mutation = await h.runOK("apply_effect", { clipIds: [clip.id], effects: [{ type: "stylize.invert" }] });
    const mutationEffect = invertEffect(mutation);
    expect(mutationEffect).toBeDefined();
    expect(mutationEffect?.params).toBeUndefined();

    expect(invertEffect(await h.runOK("get_timeline"))).toBeDefined();

    const invalid = await h.runRaw("apply_effect", { clipIds: [clip.id], effects: [{ type: "stylize.invert", params: { amount: 1 } }] });
    expect(invalid.isError).toBe(true);
    expect(invertEffect(await h.runOK("get_timeline"))).toBeDefined();

    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(invertEffect(await h.runOK("get_timeline"))).toBeUndefined();
  });
});
