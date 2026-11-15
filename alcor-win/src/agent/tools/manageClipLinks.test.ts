import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { ToolHarness } from "./testHarness";

describe("ToolExecutor — manage_clip_links", () => {
  function harness(linked = false): ToolHarness {
    const video = Fixtures.clip({ id: "video", start: 10, duration: 40 });
    const audio = Fixtures.clip({ id: "audio", mediaType: "audio", start: 5, duration: 50 });
    if (linked) {
      video.linkGroupId = "group";
      audio.linkGroupId = "group";
    }
    return new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [video] }), Fixtures.audioTrack({ clips: [audio] })] }));
  }

  it("linksAndUnlinksWithoutChangingTiming", async () => {
    const h = harness();

    await h.runOK("manage_clip_links", { action: "link", clipIds: ["video", "audio"] });
    const group = h.editor.clipFor("video")?.linkGroupId;
    expect(group).toBeDefined();
    expect(h.editor.clipFor("audio")?.linkGroupId).toBe(group);
    expect(h.editor.clipFor("video")?.startFrame).toBe(10);
    expect(h.editor.clipFor("audio")?.startFrame).toBe(5);

    await h.runOK("manage_clip_links", { action: "unlink", clipIds: ["video"] });
    expect(h.editor.clipFor("video")?.linkGroupId).toBeUndefined();
    expect(h.editor.clipFor("audio")?.linkGroupId).toBeUndefined();
    expect(h.editor.clipFor("video")?.durationFrames).toBe(40);
    expect(h.editor.clipFor("audio")?.durationFrames).toBe(50);
  });

  it("linkingMergesCompleteExistingGroups", async () => {
    const video1 = Fixtures.clip({ id: "video1", start: 0, duration: 40 });
    const audio1 = Fixtures.clip({ id: "audio1", mediaType: "audio", start: 0, duration: 40 });
    const video2 = Fixtures.clip({ id: "video2", start: 50, duration: 40 });
    const audio2 = Fixtures.clip({ id: "audio2", mediaType: "audio", start: 50, duration: 40 });
    video1.linkGroupId = "group1";
    audio1.linkGroupId = "group1";
    video2.linkGroupId = "group2";
    audio2.linkGroupId = "group2";
    const h = new ToolHarness(
      Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [video1, video2] }), Fixtures.audioTrack({ clips: [audio1, audio2] })] }),
    );

    await h.runOK("manage_clip_links", { action: "link", clipIds: ["video1", "video2"] });

    const group = h.editor.clipFor("video1")?.linkGroupId;
    expect(group).toBeDefined();
    expect(h.editor.clipFor("audio1")?.linkGroupId).toBe(group);
    expect(h.editor.clipFor("video2")?.linkGroupId).toBe(group);
    expect(h.editor.clipFor("audio2")?.linkGroupId).toBe(group);
  });

  it("rejectsInvalidAndNoOpRequests", async () => {
    const h = harness();

    expect((await h.runRaw("manage_clip_links", { action: "link", clipIds: ["video"] })).isError).toBe(true);
    expect((await h.runRaw("manage_clip_links", { action: "unlink", clipIds: ["video"] })).isError).toBe(true);
    expect((await h.runRaw("manage_clip_links", { action: "invalid", clipIds: ["video", "audio"] })).isError).toBe(true);
    expect(h.editor.timeline.tracks.flatMap((t) => t.clips).every((c) => c.linkGroupId === undefined)).toBe(true);
  });
});
