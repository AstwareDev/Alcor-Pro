import { afterEach, describe, expect, it, vi } from "vitest";
import { clipDenoiseAmount, clipHasDenoiseEnabled } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { beatStore } from "../../beats/beatState";
import { setMediaIo } from "../../media/io";
import { makeFakeIo } from "../../media/fakeIo";
import { ToolHarness } from "./testHarness";
import { mcpServerTools } from "./toolRegistry";

type Json = Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
  setMediaIo(undefined);
});

function harnessWithAudio(): { h: ToolHarness; assetId: string } {
  const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack()] }));
  const asset = h.addAsset({ id: "music", type: "audio", duration: 10 });
  const io = makeFakeIo();
  io.addFile(asset.url, "x");
  setMediaIo(io);
  return { h, assetId: asset.id };
}

describe("MCP detect_beats", () => {
  it("isListedWithVerbatimSchema", () => {
    const tool = mcpServerTools().find((r) => r.definition.name === "detect_beats");
    expect(tool).toBeDefined();
    expect(((tool?.definition.inputSchema as Json).required as string[])).toEqual(["mediaRef"]);
  });

  it("returnsRoundedBeatsDownbeatsAndBpm", async () => {
    const { h, assetId } = harnessWithAudio();
    vi.spyOn(beatStore, "detect").mockResolvedValue({ bpm: 120.04, beats: [0.504, 1.0, 1.5, 2.0], downbeats: [0.504, 2.0] });
    const out = await h.runOK("detect_beats", { mediaRef: assetId });
    expect(out.beats).toEqual([0.5, 1, 1.5, 2]);
    expect(out.downbeats).toEqual([0.5, 2]);
    expect(out.bpm).toBe(120);
    expect(out.units).toBe("source seconds — multiply by fps for frame values");
  });

  it("windowsTheResultAndRecomputesBpmFromTheWindow", async () => {
    const { h, assetId } = harnessWithAudio();
    vi.spyOn(beatStore, "detect").mockResolvedValue({ bpm: 120, beats: [0.5, 1, 1.5, 2, 3, 4], downbeats: [1, 3] });
    const out = await h.runOK("detect_beats", { mediaRef: assetId, startSeconds: 0.9, endSeconds: 2.1 });
    expect(out.beats).toEqual([1, 1.5, 2]);
    expect(out.downbeats).toEqual([1]);
    expect(out.bpm).toBe(120);
    const empty = await h.runOK("detect_beats", { mediaRef: assetId, startSeconds: 8, endSeconds: 9 });
    expect(empty.beats).toEqual([]);
    expect(String(empty.note)).toContain("No beats in the requested window");
  });

  it("noBeatsAndErrors", async () => {
    const { h, assetId } = harnessWithAudio();
    vi.spyOn(beatStore, "detect").mockResolvedValue({ bpm: 0, beats: [], downbeats: [] });
    expect(String((await h.runOK("detect_beats", { mediaRef: assetId })).note)).toContain("No beats found");
    expect((await h.runRaw("detect_beats", { mediaRef: "nope" })).isError).toBe(true);
    vi.spyOn(beatStore, "detect").mockResolvedValue({ bpm: 120, beats: [1, 2], downbeats: [] });
    expect((await h.runRaw("detect_beats", { mediaRef: assetId, startSeconds: 5, endSeconds: 2 })).isError).toBe(true);
    expect((await h.runRaw("detect_beats", { mediaRef: assetId, bogus: 1 })).isError).toBe(true);
    const video = h.addAsset({ id: "silent", type: "video", duration: 3, hasAudio: false });
    const r = await h.runRaw("detect_beats", { mediaRef: video.id });
    expect(r.isError).toBe(true);
    expect(ToolHarness.textOf(r)).toContain("with no audio track");
  });

  it("reportsAMissingFile", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack()] }));
    const asset = h.addAsset({ id: "gone", type: "audio", duration: 3 });
    setMediaIo(makeFakeIo());
    const r = await h.runRaw("detect_beats", { mediaRef: asset.id });
    expect(r.isError).toBe(true);
    expect(ToolHarness.textOf(r)).toContain("Media file not on disk");
  });
});

describe("MCP denoise_audio", () => {
  const setup = (): { h: ToolHarness; id: string; videoId: string } => {
    const audio = Fixtures.clip({ id: "a1", start: 0, duration: 60, mediaType: "audio" });
    const video = Fixtures.clip({ id: "v1", start: 0, duration: 60 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [audio] }), Fixtures.videoTrack({ clips: [video] })] }));
    return { h, id: audio.id, videoId: video.id };
  };

  it("enablesWithDefaultStrengthThenSetsStrengthDisablesAndUndoes", async () => {
    const { h, id } = setup();
    const on = await h.runRaw("denoise_audio", { clipIds: [id] });
    expect(on.isError, ToolHarness.textOf(on)).toBe(false);
    expect(ToolHarness.textOf(on)).toContain("Denoise bakes in the background");
    const clip = (): NonNullable<ReturnType<typeof h.editor.clipFor>> => h.editor.clipFor(id) as NonNullable<ReturnType<typeof h.editor.clipFor>>;
    expect(clipHasDenoiseEnabled(clip())).toBe(true);
    expect(clipDenoiseAmount(clip())).toBeCloseTo(0.6);
    await h.runRaw("denoise_audio", { clipIds: [id], strength: 0.25 });
    expect(clipDenoiseAmount(clip())).toBeCloseTo(0.25);
    const off = await h.runRaw("denoise_audio", { clipIds: [id], enabled: false });
    expect(off.isError).toBe(false);
    expect(ToolHarness.textOf(off)).not.toContain("bakes in the background");
    expect(clipHasDenoiseEnabled(clip())).toBe(false);
    await h.runRaw("undo");
    expect(clipHasDenoiseEnabled(clip())).toBe(true);
  });

  it("validatesInputAndLeavesTheTimelineUntouched", async () => {
    const { h, id, videoId } = setup();
    const refused = [
      { clipIds: [] },
      { clipIds: ["missing"] },
      { clipIds: [videoId] },
      { clipIds: [id], strength: 1.5 },
      { clipIds: [id], strength: -0.1 },
      { clipIds: [id], unknown: true },
    ];
    for (const args of refused) expect((await h.runRaw("denoise_audio", args)).isError, JSON.stringify(args)).toBe(true);
    expect(h.editor.clipFor(id)?.effects).toBeUndefined();
  });
});
