import { describe, expect, it } from "vitest";
import type { BlendMode } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { ToolHarness } from "./testHarness";

describe("set_clip_properties — blendMode", () => {
  function harness(): { h: ToolHarness; id: string } {
    const clip = Fixtures.clip({ id: "v1", start: 0, duration: 30 });
    const timeline = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] });
    return { h: new ToolHarness(timeline), id: clip.id };
  }

  function blendMode(h: ToolHarness): BlendMode | undefined {
    return h.editor.timeline.tracks[0].clips[0].blendMode;
  }

  it("setsBlendMode", async () => {
    const { h, id } = harness();
    const r = await h.runRaw("set_clip_properties", { clipIds: [id], blendMode: "screen" });
    expect(r.isError).toBe(false);
    expect(blendMode(h)).toBe("screen");
  });

  it("normalClearsBlendMode", async () => {
    const { h, id } = harness();
    await h.runRaw("set_clip_properties", { clipIds: [id], blendMode: "multiply" });
    expect(blendMode(h)).toBe("multiply");
    await h.runRaw("set_clip_properties", { clipIds: [id], blendMode: "normal" });
    expect(blendMode(h)).toBeUndefined();
  });

  it("invalidBlendModeErrors", async () => {
    const { h, id } = harness();
    const r = await h.runRaw("set_clip_properties", { clipIds: [id], blendMode: "glow" });
    expect(r.isError).toBe(true);
  });

  it("rejectedOnAudioClip", async () => {
    const clip = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    const r = await h.runRaw("set_clip_properties", { clipIds: ["a1"], blendMode: "screen" });
    expect(r.isError).toBe(true);
  });
});
