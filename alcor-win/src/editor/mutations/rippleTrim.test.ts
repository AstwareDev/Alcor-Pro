import { describe, expect, it } from "vitest";
import { planRippleTrim, rippleTrimClip } from "./ripple";
import { Fixtures, makeEditor, spans } from "./testFixtures";

describe("EditorViewModel - rippleTrimClip", () => {
  it("rightExtendPushesDownstream", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 50 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    rippleTrimClip(e, "c1", "right", 20, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 120], [120, 170]]);
  });

  it("rightShrinkPullsDownstreamBack", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    rippleTrimClip(e, "c1", "right", -20, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 80], [80, 130]]);
  });

  it("extendNeverOverwritesFollowingClip", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 80 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    rippleTrimClip(e, "c1", "right", 60, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 160], [160, 210]]);
  });

  it("leftRippleAnchorsStartAndShiftsDownstream", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimStart: 30 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    rippleTrimClip(e, "c1", "left", -20, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 120], [120, 170]]);
    expect(e.timeline.tracks[0].clips.find((c) => c.id === "c1")?.trimStartFrame).toBe(10);
  });

  it("linkedPartnerRipplesInSync", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100, trimEnd: 50 });
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100, trimEnd: 50 });
    v1.linkGroupId = "g";
    a1.linkGroupId = "g";
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [v1, Fixtures.clip({ id: "v2", start: 100, duration: 50 })] }),
      Fixtures.audioTrack({ clips: [a1, Fixtures.clip({ id: "a2", mediaType: "audio", start: 100, duration: 50 })] }),
    ]);
    rippleTrimClip(e, "v1", "right", 20, true);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 120], [120, 170]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 120], [120, 170]]);
  });

  it("linkedExtendClampsToMostConstrainedPartner", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100, trimEnd: 50 });
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100, trimEnd: 10 });
    v1.linkGroupId = "g";
    a1.linkGroupId = "g";
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [v1, Fixtures.clip({ id: "v2", start: 100, duration: 50 })] }),
      Fixtures.audioTrack({ clips: [a1, Fixtures.clip({ id: "a2", mediaType: "audio", start: 100, duration: 50 })] }),
    ]);
    rippleTrimClip(e, "v1", "right", 20, true);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 110], [110, 160]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 110], [110, 160]]);
  });

  it("planExposesDownstreamShiftsForPreview", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 50 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    const plan = planRippleTrim(e, "c1", "right", 20, false);
    expect(plan?.durationDelta).toBe(20);
    expect(plan?.shifts).toEqual([{ clipId: "c2", newStartFrame: 120 }]);
    expect(plan?.resizes[0]?.duration).toBe(120);
  });

  it("planClampsDeltaToConstrainedPartner", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100, trimEnd: 50 });
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100, trimEnd: 10 });
    v1.linkGroupId = "g";
    a1.linkGroupId = "g";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v1] }), Fixtures.audioTrack({ clips: [a1] })]);
    const plan = planRippleTrim(e, "v1", "right", 20, true);
    expect(plan?.durationDelta).toBe(10);
  });

  it("outOfSyncPartnerRipplesFromItsOwnEnd", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100, trimEnd: 50 });
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 90, trimEnd: 50 });
    v1.linkGroupId = "g";
    a1.linkGroupId = "g";
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [v1, Fixtures.clip({ id: "v2", start: 100, duration: 50 })] }),
      Fixtures.audioTrack({ clips: [a1, Fixtures.clip({ id: "a2", mediaType: "audio", start: 90, duration: 50 })] }),
    ]);
    rippleTrimClip(e, "v1", "right", 20, true);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 120], [120, 170]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 110], [110, 160]]);
  });

  it("shrinkClampsAtSyncLockedObstacle", () => {
    const a = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] });
    const b = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "b0", start: 60, duration: 30 }), Fixtures.clip({ id: "b1", start: 120, duration: 50 })],
    });
    const e = makeEditor([a, b]);
    const plan = planRippleTrim(e, "c1", "right", -50, false);
    expect(plan?.durationDelta).toBe(-30);
    expect(plan?.blockedAtFrame).toBe(90);
    rippleTrimClip(e, "c1", "right", -50, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 70]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[60, 90], [90, 140]]);
  });

  it("extendNeverBlocksOnSyncLock", () => {
    const a = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 50 })] });
    const b = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "b1", start: 100, duration: 50 })] });
    const e = makeEditor([a, b]);
    const plan = planRippleTrim(e, "c1", "right", 20, false);
    expect(plan?.durationDelta).toBe(20);
    expect(plan?.blockedAtFrame).toBeUndefined();
  });

  it("unlinkedTrimLeavesPartnerTrackAlone", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100, trimEnd: 50 });
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100, trimEnd: 50 });
    v1.linkGroupId = "g";
    a1.linkGroupId = "g";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v1] }), Fixtures.audioTrack({ clips: [a1] })]);
    rippleTrimClip(e, "v1", "right", 20, false);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 120]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 100]]);
  });

  it("rippleTrimUndoesAsOneEntryAndZeroDeltaRecordsNothing", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 50 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    const before = e.timeline;
    rippleTrimClip(e, "c1", "right", 0, false);
    expect(e.store.canUndo).toBe(false);
    rippleTrimClip(e, "c1", "right", 20, false);
    expect(e.store.undoActionName).toBe("Ripple Trim");
    e.undo();
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });
});
