import { describe, expect, it } from "vitest";
import { clipBlurRadius, makeTextStyle, VolumeScale } from "../../model";
import { placeClip } from "../../editor/mutations/core";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { insertTrack } from "../../editor/mutations/tracks";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP volume keyframes", () => {
  it("decibelVolumeRoundTripsAndUndoesThroughMCP", async () => {
    const h = new ToolHarness();
    insertTrack(h.editor, 0, "video");
    const asset = h.addAsset({ type: "video" });
    const clipId = placeClip(h.editor, asset, 0, 0, 60)[0];
    expect(clipId).toBeDefined();
    const textClip = Fixtures.clip({ id: "blur-text", mediaType: "text", start: 0, duration: 60 });
    textClip.textStyle = makeTextStyle();
    insertTrack(h.editor, 0, "video");
    h.editor.withoutRegistration(() => {
      h.editor.timeline.tracks[0].clips = [textClip];
    });

    h.editor.store.reset(h.editor.store.committed);
    const tools = mcpServerTools();
    const tool = tools.find((r) => r.definition.name === "set_keyframes");
    if (!tool) throw new Error("set_keyframes not listed");
    expect(tool.definition.description).toContain("volumeDb `[frame, decibels]` — −60 through +15 dB");
    const keyframeProperties = (tool.definition.inputSchema as Json).properties as Json;
    const propertyValues = (keyframeProperties.property as Json).enum as unknown[];
    expect(propertyValues).toContain("volumeDb");
    expect(propertyValues).toContain("blur");
    expect(propertyValues).not.toContain("volume");

    const clipTool = tools.find((r) => r.definition.name === "set_clip_properties");
    if (!clipTool) throw new Error("set_clip_properties not listed");
    const clipProperties = (clipTool.definition.inputSchema as Json).properties as Json;
    const volumeSchema = clipProperties.volumeDb as Json;
    expect(volumeSchema.minimum).toBe(VolumeScale.floorDb);
    expect(volumeSchema.maximum).toBe(VolumeScale.ceilingDb);
    expect(clipProperties.volume).toBeUndefined();

    const set = await h.runRaw("set_keyframes", {
      clipId,
      property: "volumeDb",
      keyframes: [
        [0, 0],
        [30, -6, "linear"],
        [60, -60],
      ],
    });
    expect(set.isError, ToolHarness.textOf(set)).toBe(false);
    const receipt = JSON.parse(ToolHarness.textOf(set)) as Json;
    const receiptClip = (receipt.clips as Json[])[0];
    expect((receiptClip.keyframes as Json).volumeDb).toBeDefined();
    expect((receiptClip.keyframes as Json).volume).toBeUndefined();

    const stored = h.editor.clipFor(clipId)?.volumeTrack?.keyframes;
    if (!stored) throw new Error("volumeTrack missing");
    expect(stored.length).toBe(3);
    expect(Math.abs(stored[0].value)).toBeLessThan(0.0001);
    expect(stored[1].value).toBe(-6);
    expect(stored[2].value).toBe(VolumeScale.floorDb);

    const timeline = await h.runOK("get_timeline");
    const clips = (timeline.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
    const clip = clips.find((c) => clipId.startsWith(c.id as string));
    if (!clip) throw new Error("clip not in timeline");
    const rows = (clip.keyframes as Json).volumeDb as number[][];
    expect(rows.length).toBe(3);
    expect(Math.abs(rows[0][1] - 0)).toBeLessThan(0.0001);
    expect(Math.abs(rows[1][1] - -6)).toBeLessThan(0.0001);
    expect(Math.abs(rows[2][1] - -60)).toBeLessThan(0.0001);
    expect((clip.keyframes as Json).volume).toBeUndefined();

    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(clipId)?.volumeTrack).toBeUndefined();
    expect((await h.runRaw("undo")).isError).toBe(true);

    const removedProperty = await h.runRaw("set_keyframes", { clipId, property: "volume", keyframes: [[0, 1]] });
    expect(removedProperty.isError).toBe(true);

    const outOfRange = await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, 15.01]] });
    expect(outOfRange.isError).toBe(true);
    expect(h.editor.clipFor(clipId)?.volumeTrack).toBeUndefined();
    expect((await h.runRaw("undo")).isError).toBe(true);

    for (const id of [clipId, textClip.id]) {
      const result = await h.runRaw("set_keyframes", {
        clipId: id,
        property: "blur",
        keyframes: [
          [0, 0, "linear"],
          [30, 60],
        ],
      });
      expect(result.isError, ToolHarness.textOf(result)).toBe(false);
      const c = h.editor.clipFor(id);
      if (!c) throw new Error("clip missing");
      expect(clipBlurRadius(c, 15)).toBe(30);
    }
    const blurState = await h.runOK("get_timeline");
    const returnedText = (blurState.tracks as Json[])
      .flatMap((t) => (t.clips as Json[] | undefined) ?? [])
      .find((c) => textClip.id.startsWith(c.id as string));
    expect(returnedText?.effects).toBeUndefined();
    expect((returnedText?.keyframes as Json | undefined)?.blur).toBeDefined();
  });
});
