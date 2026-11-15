import { describe, expect, it } from "vitest";
import { makeCrop, makeKeyframe, makeKeyframeTrack, makeStaticEffect, makeTransform } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP copy clip settings", () => {
  it("discoveryCopyReadbackNoOpValidationAndUndo", async () => {
    const source = Fixtures.clip({ id: "source-video", mediaRef: "source-media", start: 0, duration: 60 });
    source.opacity = 0.45;
    source.transform = makeTransform({ centerX: 0.25, centerY: 0.75, width: 0.4, height: 0.6, rotation: 15 });
    source.crop = makeCrop({ left: 0.1, top: 0.2, right: 0, bottom: 0 });
    source.edgeRounding = 0.3;
    source.blendMode = "screen";
    source.effects = [makeStaticEffect("stylize.invert")];

    const target = Fixtures.clip({ id: "target-video", mediaRef: "target-media", start: 90, duration: 45, speed: 1.25 });
    target.fadeInFrames = 6;
    target.opacityTrack = makeKeyframeTrack([makeKeyframe(10, 0.7)]);
    const originalTarget = structuredClone(target);
    const audio = Fixtures.clip({ id: "target-audio", mediaType: "audio", start: 90, duration: 45 });
    const image = Fixtures.clip({ id: "target-image", mediaType: "image", start: 135, duration: 25 });

    const h = new ToolHarness(
      Fixtures.timeline({
        tracks: [Fixtures.videoTrack({ id: "video-track", clips: [source, target, image] }), Fixtures.audioTrack({ clips: [audio] })],
      }),
    );

    const tool = mcpServerTools().find((r) => r.definition.name === "copy_clip_settings");
    if (!tool) throw new Error("copy_clip_settings not listed");
    const properties = (tool.definition.inputSchema as Json).properties as Json;
    expect((properties.sourceClipId as Json).type).toBe("string");
    expect((properties.targetClipIds as Json).type).toBe("array");
    expect((properties.targetTrack as Json).type).toBe("object");

    const args = { sourceClipId: source.id, targetTrack: { trackId: "video-track", range: [0, 160] } };
    const result = await h.runRaw("copy_clip_settings", args);
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const receipt = JSON.parse(ToolHarness.textOf(result)) as Json;
    expect(receipt.changed).toBe(true);
    expect(receipt.matchedClipCount).toBe(1);
    expect(receipt.changedClipCount).toBe(1);
    expect(receipt.unchangedClipCount).toBe(0);
    expect(receipt.incompatibleClipCount).toBe(1);
    expect(receipt.sourceExcluded).toBe(true);
    expect(receipt.targetClipIds).toBeUndefined();
    expect(receipt.changedClipIds).toBeUndefined();
    expect(receipt.excludedClipIds).toBeUndefined();
    expect(receipt.clips).toBeUndefined();

    const repeated = await h.runRaw("copy_clip_settings", args);
    expect(repeated.isError).toBe(false);
    const repeatedReceipt = JSON.parse(ToolHarness.textOf(repeated)) as Json;
    expect(repeatedReceipt.changed).toBe(false);
    expect(repeatedReceipt.changedClipCount).toBe(0);
    expect(repeatedReceipt.unchangedClipCount).toBe(1);
    expect(repeatedReceipt.unchangedClipIds).toBeUndefined();

    const timeline = await h.runOK("get_timeline");
    const readTarget = (timeline.tracks as Json[])
      .flatMap((t) => (t.clips as Json[] | undefined) ?? [])
      .find((c) => target.id.startsWith(c.id as string));
    if (!readTarget) throw new Error("target not in timeline");
    expect(readTarget.opacity).toBe(source.opacity);
    expect(readTarget.blendMode).toBe(source.blendMode);
    expect((readTarget.transform as Json).centerX).toBe(source.transform.centerX);
    expect((readTarget.keyframes as Json).opacity).toBeDefined();
    expect(readTarget.fadeInFrames).toBe(originalTarget.fadeInFrames);
    expect(readTarget.speed).toBe(originalTarget.speed);
    expect((readTarget.effects as Json[])[0].type).toBe("stylize.invert");

    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(target.id)).toEqual(originalTarget);
    expect((await h.runRaw("undo")).isError).toBe(true);

    const invalid = await h.runRaw("copy_clip_settings", { sourceClipId: source.id, targetClipIds: [target.id, audio.id] });
    expect(invalid.isError).toBe(true);
    expect(h.editor.clipFor(target.id)).toEqual(originalTarget);
    expect((await h.runRaw("undo")).isError).toBe(true);

    const emptyRange = await h.runRaw("copy_clip_settings", {
      sourceClipId: source.id,
      targetTrack: { trackId: "video-track", range: [135, 160] },
    });
    expect(emptyRange.isError).toBe(true);
    expect((await h.runRaw("undo")).isError).toBe(true);
  });
});
