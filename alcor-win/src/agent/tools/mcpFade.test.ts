import { describe, expect, it } from "vitest";
import { makeKeyframe, makeKeyframeTrack } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function toolProperties(name: string): Json {
  const tool = mcpServerTools().find((r) => r.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not listed`);
  return (tool.definition.inputSchema as Json).properties as Json;
}

describe("MCP clip fades", () => {
  it("discoveryMutationReadbackValidationAndUndo", async () => {
    const clip = Fixtures.clip({ id: "video", start: 0, duration: 60 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.25), makeKeyframe(30, 1)]);
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const properties = toolProperties("set_clip_properties");
    expect((properties.fadeInFrames as Json).type).toBe("integer");
    expect((properties.fadeInFrames as Json).minimum).toBe(0);
    expect((properties.fadeInInterpolation as Json).enum).toEqual(["linear", "smooth"]);

    const update = await h.runRaw("set_clip_properties", {
      clipIds: [clip.id],
      fadeInFrames: 12,
      fadeOutFrames: 18,
      fadeInInterpolation: "smooth",
      fadeOutInterpolation: "linear",
    });
    expect(update.isError, ToolHarness.textOf(update)).toBe(false);

    const timelineClip = async (): Promise<Json> => {
      const payload = await h.runOK("get_timeline");
      const clips = (payload.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
      const found = clips.find((c) => c.id === clip.id);
      if (!found) throw new Error("clip not in timeline");
      return found;
    };
    const updated = await timelineClip();
    expect(updated.fadeInFrames).toBe(12);
    expect(updated.fadeOutFrames).toBe(18);
    expect(updated.fadeInInterpolation).toBe("smooth");
    expect((updated.keyframes as Json | undefined)?.opacity).toBeDefined();

    const invalid = await h.runRaw("set_clip_properties", { clipIds: [clip.id], fadeInFrames: 50, fadeOutFrames: 20 });
    expect(invalid.isError).toBe(true);
    expect(h.editor.clipFor(clip.id)?.fadeInFrames).toBe(12);
    expect(h.editor.clipFor(clip.id)?.fadeOutFrames).toBe(18);

    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(clip.id)?.fadeInFrames).toBe(0);
    expect(h.editor.clipFor(clip.id)?.fadeOutFrames).toBe(0);
    expect(h.editor.clipFor(clip.id)?.opacityTrack?.keyframes.length).toBe(2);
  });
});
