import { describe, expect, it } from "vitest";
import { placeClip } from "../../editor/mutations/core";
import { insertTrack } from "../../editor/mutations/tracks";
import { clipHasSpeedRamp } from "../../model";
import { ToolHarness } from "./testHarness";

async function setup() {
  const h = new ToolHarness();
  insertTrack(h.editor, 0, "video");
  const asset = h.addAsset({ type: "video" });
  const clipId = placeClip(h.editor, asset, 0, 0, 90)[0];
  if (!clipId) throw new Error("no clip");
  h.editor.store.reset(h.editor.store.committed);
  return { h, clipId };
}

describe("MCP easing and speed ramps", () => {
  it("set_keyframes accepts the new easings and a custom bezier, and get_timeline reports them", async () => {
    const { h, clipId } = await setup();
    const set = await h.runRaw("set_keyframes", {
      clipId,
      property: "opacity",
      keyframes: [[0, 0, "easeIn"], [30, 1, "bezier", [0.2, 0.1, 0.4, 1.3]], [60, 0.5, "easeInOut"], [80, 1, "linear"]],
    });
    expect(set.isError, ToolHarness.textOf(set)).toBe(false);
    const kfs = h.editor.clipFor(clipId)?.opacityTrack?.keyframes ?? [];
    expect(kfs.map((k) => k.interpolationOut)).toEqual(["easeIn", "bezier", "easeInOut", "linear"]);
    expect(kfs[1]?.bezier).toEqual([0.2, 0.1, 0.4, 1.3]);
    const text = JSON.stringify(await h.runOK("get_timeline"));
    expect(text).toContain("easeInOut");
    expect(text).toContain("0.2,0.1,0.4,1.3");
  });

  it("old contracts keep working and bad easings are refused without mutating", async () => {
    const { h, clipId } = await setup();
    expect((await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 0], [10, 1, "linear"], [20, 0, "hold"]] })).isError).toBe(false);
    expect(h.editor.clipFor(clipId)?.opacityTrack?.keyframes[0]?.interpolationOut).toBe("smooth");
    expect((await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 0, "spring"]] })).isError).toBe(true);
    expect((await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 0, "bezier"]] })).isError).toBe(true);
    expect((await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 0, "bezier", [2, 0, 0, 1]]] })).isError).toBe(true);
    expect(h.editor.clipFor(clipId)?.opacityTrack?.keyframes).toHaveLength(3);
  });

  it("set_speed_ramp applies presets, explicit keyframes and frame blending, each undoable", async () => {
    const { h, clipId } = await setup();
    const preset = await h.runRaw("set_speed_ramp", { clipId, preset: "hero" });
    expect(preset.isError, ToolHarness.textOf(preset)).toBe(false);
    const ramped = h.editor.clipFor(clipId);
    expect(ramped && clipHasSpeedRamp(ramped)).toBe(true);
    expect(ramped?.durationFrames).toBe(90);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(clipId)?.speedTrack).toBeUndefined();

    const explicit = await h.runRaw("set_speed_ramp", { clipId, keyframes: [[0, 1], [45, 0.25, "easeInOut"], [89, 2]], frameBlending: true });
    expect(explicit.isError, ToolHarness.textOf(explicit)).toBe(false);
    expect(h.editor.clipFor(clipId)?.speedTrack?.keyframes).toHaveLength(3);
    expect(h.editor.clipFor(clipId)?.frameBlending).toBe(true);

    expect((await h.runRaw("set_speed_ramp", { clipId, preset: "none" })).isError).toBe(false);
    expect(h.editor.clipFor(clipId)?.speedTrack).toBeUndefined();
  });

  it("set_speed_ramp validates input", async () => {
    const { h, clipId } = await setup();
    for (const args of [
      { clipId },
      { clipId, preset: "warp" },
      { clipId, preset: "hero", keyframes: [[0, 1]] },
      { clipId, keyframes: [[0, 99]] },
      { clipId, keyframes: [[500, 1]] },
      { clipId: "nope", preset: "hero" },
    ]) {
      expect((await h.runRaw("set_speed_ramp", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(h.editor.clipFor(clipId)?.speedTrack).toBeUndefined();
  });
});
