import { describe, expect, it } from "vitest";
import { makeTextStyle, type Clip } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { droppingAutofilledBlanks } from "./toolArgs";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function textClip(p: { id: string; start: number; duration: number; content?: string }): Clip {
  const clip = Fixtures.clip({ id: p.id, mediaRef: "text", mediaType: "text", start: p.start, duration: p.duration });
  clip.textContent = p.content ?? "text";
  clip.textStyle = makeTextStyle();
  return clip;
}

describe("ToolExecutor — smoke", () => {
  it("unknownToolReturnsError", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("nonexistent_tool");
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Unknown tool");
  });

  it("autofilledBlankArgsAreTreatedAsOmitted", async () => {
    const scrubbed = droppingAutofilledBlanks({ reference: "", mediaRef: null, clipId: "C026AE24", atFrame: 45_788 });
    expect(Object.keys(scrubbed).sort()).toEqual(["atFrame", "clipId"]);
    // End to end: blank ids must not be looked up.
    const h = new ToolHarness();
    const result = await h.runRaw("remove_clips", { clipIds: [], timelineId: "" });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Missing or empty 'clipIds'");
    expect(ToolHarness.textOf(result)).not.toContain("not found");
  });

  it("getTimelineReturnsParseableJSON", async () => {
    const h = new ToolHarness();
    const json = await h.runOK("get_timeline");
    expect(json.fps).toBe(30);
    expect(Array.isArray(json.tracks)).toBe(true);
    expect(typeof json.currentFrame).toBe("number");
    expect(typeof json.canGenerate).toBe("boolean");
  });

  it("noEditorReportsEditorNotAvailable", async () => {
    const { ToolExecutor } = await import("./toolExecutor");
    const executor = ToolExecutor.forSession({
      currentEditor: () => null,
      listProjects: async () => [],
      openProject: async () => {
        throw new Error("unused");
      },
      createProject: async () => {
        throw new Error("unused");
      },
      closeProject: async () => {},
      displayName: () => "",
    });
    const result = await executor.execute("get_timeline", {}, "mcp");
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toBe("Editor not available");
  });
});

describe("ToolExecutor — read-only handlers", () => {
  it("getTimelineReflectsCurrentTracksAndFrame", async () => {
    const h = new ToolHarness(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 50 })] }),
          Fixtures.audioTrack({ clips: [Fixtures.clip({ start: 0, duration: 100 })] }),
        ],
      }),
    );
    h.editor.ui.currentFrame = 42;

    const json = await h.runOK("get_timeline");
    const tracks = json.tracks as Json[];
    expect(tracks.length).toBe(2);
    expect(tracks[0].label).toBe("V1");
    expect(tracks[1].label).toBe("A1");
    expect(json.currentFrame).toBe(42);
  });

  it("getTimelineReportsTrackGaps", async () => {
    const h = new ToolHarness(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({
            clips: [Fixtures.clip({ start: 0, duration: 10 }), Fixtures.clip({ start: 30, duration: 10 }), Fixtures.clip({ start: 35, duration: 20 })],
          }),
        ],
      }),
    );
    const json = await h.runOK("get_timeline");
    const track = (json.tracks as Json[])[0];
    expect(track.gaps).toEqual([[10, 30]]);
  });

  it("getTimelineWindowsClipsToRequestedRange", async () => {
    const h = new ToolHarness(
      Fixtures.timeline({
        tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "a", start: 0, duration: 10 }), Fixtures.clip({ id: "b", start: 100, duration: 10 })] })],
      }),
    );
    const json = await h.runOK("get_timeline", { startFrame: 50, endFrame: 200 });
    const track = (json.tracks as Json[])[0];
    expect((track.clips as Json[]).map((c) => c.id)).toEqual(["b"]);
    expect(track.totalClips).toBe(2);
    expect(json.window).toEqual([50, 110]);
  });

  it("getTimelineRejectsInvalidWindow", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("get_timeline", { startFrame: 100, endFrame: 50 });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Invalid window");
  });

  it("getTimelineFoldsLinkedAudioIntoVideoClip", async () => {
    const video = Fixtures.clip({ id: "v1", start: 0, duration: 60 });
    video.linkGroupId = "LG";
    const audio = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 60 });
    audio.linkGroupId = "LG";
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [video] }), Fixtures.audioTrack({ clips: [audio] })] }));
    const json = await h.runOK("get_timeline");
    const tracks = json.tracks as Json[];
    const v = (tracks[0].clips as Json[])[0];
    expect((v.audio as Json).id).toBe("a1");
    expect(v.linkGroupId).toBeUndefined();
    expect(tracks[1].clips).toBeUndefined();
    expect(tracks[1].linkedClips).toBe(1);
  });

  it("getTimelineRoundsFloatingPointNumbersToThreeDecimalPlaces", async () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    clip.opacity = 0.123456;
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    const json = await h.runOK("get_timeline");
    const c = ((json.tracks as Json[])[0].clips as Json[])[0];
    expect(c.opacity).toBe(0.123);
  });
});

describe("ToolExecutor — clip handlers", () => {
  function setupWithVideoTrack(): { h: ToolHarness; asset: { id: string } } {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video" });
    h.editor.perform("setup", () => {
      h.editor.timeline.tracks.push(Fixtures.videoTrack());
    });
    return { h, asset };
  }

  it("setSpeedRescalesDurationToPreserveSource", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    const result = await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 2.0 });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(2.0);
    expect(clip.durationFrames).toBe(50);
  });

  it("setSpeedWithExplicitDurationKeepsThatDuration", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    const result = await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 2.0, durationFrames: 80 });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(2.0);
    expect(clip.durationFrames).toBe(80);
  });

  it("setHalfSpeedDoublesDuration", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 0.5 });
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(0.5);
    expect(clip.durationFrames).toBe(200);
  });

  it("setSpeedRescalesTextWordTimings", async () => {
    const clip = textClip({ id: "caption", start: 0, duration: 120, content: "one two" });
    clip.wordTimings = [{ text: "one", startFrame: 0, endFrame: 60 }, { text: "two", startFrame: 60, endFrame: 120 }];
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("set_clip_properties", { clipIds: ["caption"], speed: 2.0 });

    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const updated = h.editor.timeline.tracks[0].clips[0];
    expect(updated.durationFrames).toBe(60);
    expect(updated.wordTimings).toEqual([
      { text: "one", startFrame: 0, endFrame: 30 },
      { text: "two", startFrame: 30, endFrame: 60 },
    ]);
  });

  it("addClipsPlacesClipOnTrack", async () => {
    const { h, asset } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 60 }] });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const clips = h.editor.timeline.tracks[0].clips;
    expect(clips.length).toBe(1);
    expect(clips[0].startFrame).toBe(0);
    expect(clips[0].durationFrames).toBe(60);
    expect(clips[0].mediaRef).toBe(asset.id);
  });

  it("addClipsRejectsOutOfRangeTrackIndex", async () => {
    const { h, asset } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 99, startFrame: 0, endFrame: 30 }] });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("out of range");
  });

  it("addClipsAutoCreatesTrackWhenIndexOmitted", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video" });
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, endFrame: 60 }] });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(1);
    expect(h.editor.timeline.tracks[0].clips.length).toBe(1);
    const json = JSON.parse(ToolHarness.textOf(result)) as Json;
    expect((json.createdTracks as Json[])[0].index).toBe(0);
  });

  it("oneToolCallIsOneUndoEntry", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video" });
    await h.runOK("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, endFrame: 60 }, { mediaRef: asset.id, startFrame: 60, endFrame: 90 }] });
    expect(h.editor.timeline.tracks[0].clips.length).toBe(2);
    expect(h.editor.store.undoActionName).toBe("Add Clips (Agent)");
    const undone = await h.runRaw("undo");
    expect(undone.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(0);
  });
});
