import { describe, expect, it } from "vitest";
import { rippleDeleteRanges, rippleDeleteRangesOnTrack, type RippleRangesReport } from "./ripple";
import { rippleInsertClips } from "./ripple";
import { makeFrameRange as FrameRange } from "../rippleEngine";
import { Fixtures, makeAsset, makeEditor, setup, spans, starts } from "./testFixtures";

function okReport(outcome: ReturnType<typeof rippleDeleteRanges>): RippleRangesReport {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got refused: ${outcome.reason}`);
  return outcome.report;
}

describe("EditorViewModel - rippleDeleteRanges", () => {
  it("cutsMidClipAndClosesGap", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })]);
    const report = okReport(rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]));
    expect(report.removedFrames).toBe(10);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
  });

  it("multipleRangesAccumulateShifts", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })]);
    const report = okReport(rippleDeleteRanges(e, "c1", [FrameRange(60, 70), FrameRange(20, 30)]));
    expect(report.removedFrames).toBe(20);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 20], [20, 50], [50, 80]]);
  });

  it("overlappingRangesMergeBeforeCounting", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })]);
    const report = okReport(rippleDeleteRanges(e, "c1", [FrameRange(40, 55), FrameRange(50, 70)]));
    expect(report.removedFrames).toBe(30);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 70]]);
  });

  it("downstreamClipShiftsByTotalRemoved", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const e = makeEditor([track]);
    rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]);
    expect(starts(e.timeline.tracks[0])).toEqual([0, 40, 90]);
  });

  it("linkedPartnerCutInSync", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100 });
    v1.linkGroupId = "G";
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100 });
    a1.linkGroupId = "G";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v1] }), Fixtures.audioTrack({ clips: [a1] })]);
    const report = okReport(rippleDeleteRanges(e, "v1", [FrameRange(40, 50)]));
    expect(report.clearedTracks).toBe(2);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 40], [40, 90]]);
  });

  it("syncLockedFollowerShifts", () => {
    const v = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] });
    const a = Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "a1", start: 120, duration: 30 })] });
    const e = makeEditor([v, a]);
    rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(starts(e.timeline.tracks[1])).toEqual([110]);
  });

  it("syncLockedFollowerCutInSync", () => {
    const v = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] });
    const a = Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "a1", start: 0, duration: 100 })] });
    const e = makeEditor([v, a]);
    const report = okReport(rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]));
    expect(report.clearedTracks).toBe(2);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 40], [40, 90]]);
  });

  it("trackWideCutSpansMultipleClips", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 }), Fixtures.clip({ id: "c2", start: 100, duration: 100 })],
    });
    const e = makeEditor([track]);
    const report = okReport(rippleDeleteRangesOnTrack(e, 0, [FrameRange(40, 50), FrameRange(150, 160)]));
    expect(report.removedFrames).toBe(20);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90], [90, 140], [140, 180]]);
  });

  it("trackWideCutSyncsLinkedPartnersOfEachClip", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100 });
    v1.linkGroupId = "G1";
    const v2 = Fixtures.clip({ id: "v2", start: 100, duration: 100 });
    v2.linkGroupId = "G2";
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100 });
    a1.linkGroupId = "G1";
    const a2 = Fixtures.clip({ id: "a2", mediaType: "audio", start: 100, duration: 100 });
    a2.linkGroupId = "G2";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v1, v2] }), Fixtures.audioTrack({ clips: [a1, a2] })]);
    const report = okReport(rippleDeleteRangesOnTrack(e, 0, [FrameRange(40, 50), FrameRange(150, 160)]));
    expect(report.clearedTracks).toBe(2);
    expect(spans(e.timeline.tracks[0])).toEqual(spans(e.timeline.tracks[1]));
  });

  it("linkedPartnerOnSyncLockOffTrackCutInSync", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100 });
    v1.linkGroupId = "G";
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100 });
    a1.linkGroupId = "G";
    const r1 = Fixtures.clip({ id: "r1", mediaType: "audio", start: 0, duration: 100 });
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [v1] }),
      Fixtures.audioTrack({ clips: [a1] }),
      Fixtures.audioTrack({ clips: [r1] }),
    ]);
    setup(e, () => {
      e.timeline.tracks[0].syncLocked = false;
    });
    const report = okReport(rippleDeleteRangesOnTrack(e, 2, [FrameRange(40, 50)]));
    expect(report.clearedTracks).toBe(3);
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 40], [40, 90]]);
    expect(spans(e.timeline.tracks[2])).toEqual([[0, 40], [40, 90]]);
  });

  it("rippleInsertPushesDownstream", () => {
    const track = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 50 }), Fixtures.clip({ id: "c2", start: 50, duration: 50 })],
    });
    const e = makeEditor([track]);
    const asset = makeAsset({ id: "m1", type: "video", duration: 1.0, hasAudio: false });
    setup(e, () => {
      e.doc.mediaAssets.push(asset);
    });
    const created = rippleInsertClips(e, [asset], 0, 50);
    expect(created.length).toBe(1);
    const s = spans(e.timeline.tracks[0]);
    expect(s).toContainEqual([0, 50]);
    expect(s).toContainEqual([50, 80]);
    expect(s).toContainEqual([80, 130]);
  });

  it("syncLockedFollowerCutAvoidsShiftCollision", () => {
    const v = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] });
    const a = Fixtures.audioTrack({
      clips: [Fixtures.clip({ id: "a1", start: 0, duration: 95 }), Fixtures.clip({ id: "a2", start: 100, duration: 50 })],
    });
    const e = makeEditor([v, a]);
    okReport(rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]));
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(spans(e.timeline.tracks[1])).toEqual([[0, 40], [40, 85], [90, 140]]);
  });

  it("ignoreSyncLockedTracksLetsCutProceedAndLeavesThemInPlace", () => {
    const v = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] });
    const a = Fixtures.audioTrack({
      clips: [Fixtures.clip({ id: "a1", start: 0, duration: 95 }), Fixtures.clip({ id: "a2", start: 100, duration: 50 })],
    });
    const e = makeEditor([v, a]);
    okReport(rippleDeleteRangesOnTrack(e, 0, [FrameRange(40, 50)], new Set([1])));
    expect(spans(e.timeline.tracks[0])).toEqual([[0, 40], [40, 90]]);
    expect(starts(e.timeline.tracks[1])).toEqual([0, 100]);
  });

  it("refusalsLeaveTheDocumentUntouchedWithoutUndoEntry", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })]);
    expect(rippleDeleteRanges(e, "ghost", [FrameRange(40, 50)])).toEqual({ kind: "refused", reason: "Clip not found: ghost" });
    expect(rippleDeleteRangesOnTrack(e, 5, [FrameRange(40, 50)])).toEqual({ kind: "refused", reason: "Track index out of range: 5" });
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(40, 40)])).toEqual({ kind: "refused", reason: "No non-empty ranges to delete" });
    expect(e.store.canUndo).toBe(false);
  });

  it("undoRestoresExactTimelineAfterMultiTrackCut", () => {
    const v1 = Fixtures.clip({ id: "v1", start: 0, duration: 100 });
    v1.linkGroupId = "G";
    const a1 = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 100 });
    a1.linkGroupId = "G";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v1] }), Fixtures.audioTrack({ clips: [a1] })]);
    const before = e.timeline;
    okReport(rippleDeleteRanges(e, "v1", [FrameRange(40, 50)]));
    expect(e.store.undoActionName).toBe("Ripple Delete");
    e.undo();
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });
});
