import { describe, expect, it } from "vitest";
import { makeTextStyle } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP — text scale", () => {
  it("discoveryUpdateReadbackValidationAndUndo", async () => {
    const clip = Fixtures.clip({ id: "text-1", mediaRef: "", mediaType: "text", start: 0, duration: 90 });
    clip.textContent = "Stretch";
    clip.textStyle = makeTextStyle({ widthScale: 0.85, heightScale: 1.1 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const tool = mcpServerTools().find((r) => r.definition.name === "update_text");
    if (!tool) throw new Error("update_text not listed");
    const properties = (tool.definition.inputSchema as Json).properties as Json;
    const style = (properties.style as Json).properties as Json;
    expect((style.widthScale as Json).minimum).toBe(0.1);
    expect((style.widthScale as Json).maximum).toBe(10);
    expect((style.heightScale as Json).minimum).toBe(0.1);
    expect((style.heightScale as Json).maximum).toBe(10);
    expect((style.blur as Json).minimum).toBe(0);
    expect((style.blur as Json).maximum).toBe(100);

    const timelineClip = async (): Promise<Json> => {
      const payload = await h.runOK("get_timeline");
      const clips = (payload.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
      const found = clips.find((c) => c.id === clip.id);
      if (!found) throw new Error("clip not in timeline");
      return found;
    };
    const textStyle = async (): Promise<Json> => (await timelineClip()).textStyle as Json;

    const update = await h.runRaw("update_text", {
      clipIds: [clip.id],
      style: { widthScale: 1.5, heightScale: 0.75, blur: 24 },
    });
    expect(update.isError, ToolHarness.textOf(update)).toBe(false);
    const updatedStyle = await textStyle();
    expect(updatedStyle.widthScale).toBe(1.5);
    expect(updatedStyle.heightScale).toBe(0.75);
    expect(updatedStyle.blur).toBe(24);

    const invalid = await h.runRaw("update_text", { clipIds: [clip.id], style: { widthScale: 0 } });
    expect(invalid.isError).toBe(true);
    expect((await textStyle()).widthScale).toBe(1.5);
    const invalidBlur = await h.runRaw("update_text", { clipIds: [clip.id], style: { blur: 101 } });
    expect(invalidBlur.isError).toBe(true);

    const animated = await h.runRaw("set_keyframes", {
      clipId: clip.id,
      property: "scale",
      keyframes: [
        [0, 1, 1],
        [45, 2, 2, "linear"],
      ],
    });
    expect(animated.isError, ToolHarness.textOf(animated)).toBe(false);
    const animatedClip = await timelineClip();
    expect(((animatedClip.keyframes as Json).scale as unknown[]).length).toBe(2);

    const undoScale = await h.runRaw("undo");
    expect(undoScale.isError).toBe(false);
    const afterScaleUndo = await timelineClip();
    expect((afterScaleUndo.keyframes as Json | undefined)?.scale).toBeUndefined();

    const undoStyle = await h.runRaw("undo");
    expect(undoStyle.isError).toBe(false);
    const restoredStyle = await textStyle();
    expect(restoredStyle.widthScale).toBe(0.85);
    expect(restoredStyle.heightScale).toBe(1.1);
    expect(restoredStyle.blur).toBeUndefined();
  });
});
