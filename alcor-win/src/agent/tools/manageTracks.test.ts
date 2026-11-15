import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { timelineTrackDisplayLabel } from "../../editor/mutations/tracks";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("ToolExecutor — manage_tracks", () => {
  function harness(): ToolHarness {
    return new ToolHarness(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({
            clips: Array.from({ length: 50 }, (_, i) => Fixtures.clip({ mediaType: "text", start: i * 10, duration: 10 })),
          }),
          Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 100 })] }),
          Fixtures.audioTrack({ clips: [Fixtures.clip({ mediaType: "audio", start: 0, duration: 100 })] }),
        ],
      }),
    );
  }

  it("removesTrackWithAllItsClips", async () => {
    const h = harness();
    const json = await h.runOK("manage_tracks", { remove: [0] });
    expect((json.removedClipIds as string[]).length).toBe(50);
    expect((json.tracks as Json[]).length).toBe(2);
    expect(h.editor.timeline.tracks.length).toBe(2);
    expect(h.editor.timeline.tracks.every((track) => !track.clips.some((c) => c.mediaType === "text"))).toBe(true);
  });

  it("removesMultipleTracksWithPreCallIndexes", async () => {
    const h = harness();
    await h.runOK("manage_tracks", { remove: [0, 2] });
    expect(h.editor.timeline.tracks.length).toBe(1);
    expect(timelineTrackDisplayLabel(h.editor, 0)).toBe("V1");
  });

  it("reordersWithinTypeZoneWithoutClipChurn", async () => {
    const h = harness();
    const timeline = await h.runOK("get_timeline");
    const tracks = timeline.tracks as Json[];
    const textRef = tracks[0].trackId as string;
    const movedId = h.editor.timeline.tracks[1].id;
    const json = await h.runOK("manage_tracks", { reorder: [{ index: 1, to: 0 }] });
    expect(h.editor.timeline.tracks[0].id).toBe(movedId);
    // A pure reorder moves no clips — the diff must not enumerate the 51 clips.
    expect(json.clips).toBeUndefined();
    expect(json.shifted).toBeUndefined();
    const order = json.tracks as Json[];
    expect(order.length).toBe(3);
    const receipt = (json.reordered as Json[])[0];
    expect(receipt.to).toBe(0);
    expect(receipt.changed).toBe(true);
    const movedRef = order[0].trackId as string;
    const noOp = await h.runOK("manage_tracks", { reorder: [{ trackId: movedRef, to: 0 }] });
    expect((noOp.reordered as Json[])[0].changed).toBe(false);

    const remove = await h.runOK("manage_tracks", { remove: [{ trackId: textRef }] });
    expect(h.editor.timeline.tracks.some((t) => t.id === movedId)).toBe(true);
    expect(h.editor.timeline.tracks.some((t) => t.clips.some((c) => c.mediaType === "text"))).toBe(false);
    expect((remove.removedTracks as Json[])[0].trackId).toBe(textRef);
  });

  it("setsMuteHiddenAndSyncLock", async () => {
    const h = harness();
    const json = await h.runOK("manage_tracks", {
      set: [{ index: 2, muted: true }, { index: 0, hidden: true, syncLocked: false }],
    });
    expect(h.editor.timeline.tracks[2].muted).toBe(true);
    expect(h.editor.timeline.tracks[0].hidden).toBe(true);
    expect(h.editor.timeline.tracks[0].syncLocked).toBe(false);
    const order = json.tracks as Json[];
    expect(order[0].hidden).toBe(true);
    expect(order[order.length - 1].muted).toBe(true);

    // Setting the same values again is a no-op, not a toggle back.
    await h.runOK("manage_tracks", { set: [{ index: 2, muted: true }] });
    expect(h.editor.timeline.tracks[2].muted).toBe(true);
  });

  it("rejectsOutOfRangeIndexAndEmptyCall", async () => {
    const h = harness();
    const before = structuredClone(h.editor.timeline);
    expect((await h.runRaw("manage_tracks", { remove: [5] })).isError).toBe(true);
    expect((await h.runRaw("manage_tracks", { remove: [1.5] })).isError).toBe(true);
    expect((await h.runRaw("manage_tracks", { reorder: [{ index: 2, to: 0 }] })).isError).toBe(true);
    expect((await h.runRaw("manage_tracks", { reorder: [{ index: 1, to: 99 }] })).isError).toBe(true);
    expect((await h.runRaw("manage_tracks", { set: [{ index: 0, name: "Bad\nName" }] })).isError).toBe(true);
    expect((await h.runRaw("manage_tracks", { set: [{ index: 0, name: 42 }] })).isError).toBe(true);
    expect(h.editor.timeline).toEqual(before);
    expect((await h.runRaw("manage_tracks", {})).isError).toBe(true);
  });
});
