import { describe, expect, it } from "vitest";
import { seededCorrelate } from "../../audio/audioSyncCorrelator";
import type { SourceTiming, SyncServices } from "../../audio/sourceTiming";
import { envelopeHopSeconds } from "../../media/peaks";
import { makeLinkGroupFixture } from "./syncTestSupport";
import { Fixtures, makeAsset, makeEditor, setup } from "./testFixtures";
import {
  retimeGrowthWouldClobberUnmovedClip, syncClips, syncSelection, synchronizeSummary, timecodeAlignedStart, type SyncBatchReport,
} from "./sync";
import { correlate } from "../../audio/audioSyncCorrelator";

// Ports of Tests/PalmierProTests/Timeline/TimecodeSyncTests.swift (cases that do not need AVFoundation) plus
// behaviour tests of syncClips driven by synthetic envelopes.

const hop = envelopeHopSeconds;

function noise(count: number, seed: number): Float32Array {
  let state = BigInt(seed);
  const mask = (1n << 64n) - 1n;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    out[i] = Number((state >> 33n) % 1000n) / 1000;
  }
  return out;
}

function services(envelopes: Record<string, Float32Array>, timings: Record<string, SourceTiming> = {}): SyncServices {
  return {
    envelope: async (ref) => (envelopes[ref] ? { hopSeconds: hop, samples: envelopes[ref] } : null),
    timing: async (ref) => timings[ref] ?? {},
    correlate: (params, signal) => seededCorrelate(params, signal),
  };
}

const tc = (frame: number, quanta: number): { seconds: number } => ({ seconds: frame / quanta });

describe("TimecodeSync", () => {
  it("timecodeAlignedStartHandlesOffsetTrimAndSpeed", () => {
    const start = (p: { refStart?: number; refTrim?: number; refSpeed?: number; refFrame: number; targetTrim?: number; targetFrame: number }): number =>
      timecodeAlignedStart({
        refStartFrame: p.refStart ?? 0,
        refTrimStartFrame: p.refTrim ?? 0,
        refSpeed: p.refSpeed ?? 1,
        refTimecode: tc(p.refFrame, 25),
        targetTrimStartFrame: p.targetTrim ?? 0,
        targetTimecode: tc(p.targetFrame, 25),
        fps: 25,
      });
    expect(start({ refStart: 120, refFrame: 90000, targetFrame: 90000 })).toBe(120);
    expect(start({ refFrame: 1000, targetFrame: 1250 })).toBe(250);
    expect(start({ refStart: 100, refTrim: 50, refFrame: 0, targetFrame: 0 })).toBe(50);
    expect(start({ refSpeed: 2, refFrame: 0, targetFrame: 250 })).toBe(125);
  });

  it("syncClipsThrowsInsteadOfMutatingWhenCancelled", async () => {
    const ref = Fixtures.clip({ id: "ref", start: 0, duration: 60 });
    const target = Fixtures.clip({ id: "t1", start: 200, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [ref] }), Fixtures.videoTrack({ clips: [target] })]);
    const before = e.timeline;
    const controller = new AbortController();
    controller.abort();
    await expect(syncClips(e, services({}), { referenceClipId: "ref", targetClipIds: ["t1"], signal: controller.signal })).rejects.toThrow();
    expect(e.timeline).toBe(before);
  });

  it("retimeGrowthClobberDetectionRespectsNeighborsGapsAndBatch", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 100 });
    const neighbor = Fixtures.clip({ id: "n1", start: 100, duration: 50 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip, neighbor] })]);
    const clobbers = (id: string, finalStart: number, newDuration: number, moved: string[]): boolean =>
      retimeGrowthWouldClobberUnmovedClip(e, id, finalStart, newDuration, new Set(moved));

    expect(clobbers("c1", 0, 101, ["c1"])).toBe(true);
    expect(clobbers("c1", 0, 100, ["c1"])).toBe(false);
    expect(clobbers("c1", 0, 99, ["c1"])).toBe(false);
    expect(clobbers("c1", 0, 101, ["c1", "n1"])).toBe(false);
    expect(clobbers("c1", 25, 101, ["c1"])).toBe(true);
    expect(clobbers("c1", 200, 101, ["c1"])).toBe(false);

    const gapped = Fixtures.clip({ id: "c2", start: 300, duration: 100 });
    const e2 = makeEditor([Fixtures.videoTrack({ clips: [gapped, Fixtures.clip({ id: "n2", start: 450, duration: 50 })] })]);
    expect(retimeGrowthWouldClobberUnmovedClip(e2, "c2", 300, 150, new Set(["c2"]))).toBe(false);
    expect(retimeGrowthWouldClobberUnmovedClip(e2, "c2", 300, 151, new Set(["c2"]))).toBe(true);
  });

  it("seededCorrelationFindsLagOutsideSymmetricWindow", () => {
    const reference = new Float32Array(4000);
    const target = noise(400, 42);
    reference.set(target, 3000);
    expect(correlate(reference, target, 100)?.lagHops).not.toBe(3000);
    const seeded = correlate(reference, target, 100, 2950);
    expect(seeded?.lagHops).toBe(3000);
    expect(seeded?.confidence ?? 0).toBeGreaterThan(0.99);
    // A thin shared edge (30 hops) wins loose correlation but is rejected by a real overlap floor.
    const ref2 = noise(2000, 1);
    const tgt2 = noise(1000, 2);
    const shared = noise(30, 3);
    ref2.set(shared, 1970);
    tgt2.set(shared, 0);
    expect(correlate(ref2, tgt2, 1970)?.lagHops).toBe(1970);
    const strict = correlate(ref2, tgt2, 1970, 0, 300);
    expect(strict?.lagHops).not.toBe(1970);
    expect(strict?.confidence ?? 1).toBeLessThan(0.5);
  });
});

describe("syncClips", () => {
  // Reference: 20 s of envelope; target is the same audio starting 2 s in, so it belongs 2 s (60 frames) later.
  const refEnvelope = noise(8_000, 77);
  const targetEnvelope = refEnvelope.slice(800, 800 + 6_000);

  function audioEditor() {
    const ref = Fixtures.clip({ id: "ref", mediaRef: "refMedia", mediaType: "audio", start: 100, duration: 600 });
    const target = Fixtures.clip({ id: "tgt", mediaRef: "tgtMedia", mediaType: "audio", start: 5000, duration: 450 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [ref] }), Fixtures.audioTrack({ clips: [target] })]);
    setup(e, () => {
      e.doc.mediaAssets.push(makeAsset({ id: "refMedia", type: "audio", duration: 20 }), makeAsset({ id: "tgtMedia", type: "audio", duration: 15 }));
    });
    return e;
  }

  it("alignsTargetByAudioInOneUndoEntry", async () => {
    const e = audioEditor();
    const report = await syncClips(e, services({ refMedia: refEnvelope, tgtMedia: targetEnvelope }), { referenceClipId: "ref", targetClipIds: ["tgt"] });
    expect(report.failures).toEqual([]);
    expect(report.synced.length).toBe(1);
    expect(report.synced[0].method).toBe("audio");
    expect(report.synced[0].confidence).toBeGreaterThan(0.99);
    expect(e.clipFor("tgt")?.startFrame).toBe(160);
    expect(report.synced[0].offsetFrames).toBe(160 - 5000);
    expect(e.clipFor("ref")?.startFrame).toBe(100);
    expect(e.store.undoActionName).toBe("Synchronize");
    e.undo();
    expect(e.clipFor("tgt")?.startFrame).toBe(5000);
  });

  it("shiftsTheWholeGroupRightWhenATargetWouldLandBeforeFrameZero", async () => {
    const e = audioEditor();
    // Target audio precedes the reference by 2 s while the reference sits at frame 10: needs a 50 frame shift.
    setup(e, () => {
      e.timeline.tracks[0].clips[0].startFrame = 10;
    });
    const early = refEnvelope.slice(0, 6_000);
    const late = refEnvelope.slice(800);
    const report = await syncClips(e, services({ refMedia: late, tgtMedia: early }), { referenceClipId: "ref", targetClipIds: ["tgt"] });
    expect(report.synced.length).toBe(1);
    expect(report.shiftedFrames).toBe(50);
    expect(e.clipFor("tgt")?.startFrame).toBe(0);
    expect(e.clipFor("ref")?.startFrame).toBe(60);
  });

  it("reportsFailureWhenAudioDoesNotMatch", async () => {
    const e = audioEditor();
    const before = e.timeline;
    const report = await syncClips(e, services({ refMedia: refEnvelope, tgtMedia: noise(6_000, 999) }), { referenceClipId: "ref", targetClipIds: ["tgt"] });
    expect(report.synced).toEqual([]);
    expect(report.failures[0]?.message).toContain("No confident alignment");
    expect(e.timeline).toBe(before);
  });

  it("reportsMissingAudioAndTimecodeModeFailures", async () => {
    const e = audioEditor();
    const noAudio = await syncClips(e, services({ refMedia: refEnvelope }), { referenceClipId: "ref", targetClipIds: ["tgt"] });
    expect(noAudio.failures).toEqual([{ clipId: "tgt", message: "Clip has no audio." }]);
    const tcMode = await syncClips(e, services({ refMedia: refEnvelope }), { referenceClipId: "ref", targetClipIds: ["tgt"], mode: "timecode" });
    expect(tcMode.failures).toEqual([{ clipId: "tgt", message: "Reference has no source timecode." }]);
    const missing = await syncClips(e, services({}), { referenceClipId: "nope", targetClipIds: ["tgt"] });
    expect(missing.failures).toEqual([{ clipId: "tgt", message: "Reference clip unavailable." }]);
  });

  it("alignsByTimecodeWhenBothFilesCarryOne", async () => {
    const e = audioEditor();
    // Target recorded 10 s after the reference started (25 fps timecode) -> 300 frames at 30 fps.
    const timings = { refMedia: { timecode: tc(1000, 25) }, tgtMedia: { timecode: tc(1250, 25) } };
    const report = await syncClips(e, services({}, timings), { referenceClipId: "ref", targetClipIds: ["tgt"], mode: "timecode" });
    expect(report.synced).toEqual([{ clipId: "tgt", offsetFrames: 400 - 5000, confidence: 1, method: "timecode" }]);
    expect(e.clipFor("tgt")?.startFrame).toBe(400);
  });

  it("movesLinkedPartnersAndRefusesSharedTrack", async () => {
    const { editor } = makeLinkGroupFixture();
    const report = await syncClips(editor, services({ refMedia: refEnvelope, tgtMedia: targetEnvelope }), { referenceClipId: "ref", targetClipIds: ["tgtA"] });
    expect(report.synced.length).toBe(1);
    expect(editor.clipFor("tgtA")?.startFrame).toBe(160);
    expect(editor.clipFor("tgtV")?.startFrame).toBe(160);
  });

  it("syncSelectionPicksLinkedVisualUnitAsReference", () => {
    const { editor } = makeLinkGroupFixture();
    editor.ui.selectedClipIds = new Set(["ref", "tgtA", "tgtV"]);
    const selection = syncSelection(editor);
    expect(selection?.referenceClipId).toBe("tgtA");
    expect(selection?.targetClipIds).toEqual(["ref"]);
    editor.ui.selectedClipIds = new Set(["ref"]);
    expect(syncSelection(editor)).toBeUndefined();
  });

  it("synchronizeSummaryDescribesTheRun", () => {
    const base: SyncBatchReport = { synced: [], failures: [], shiftedFrames: 0, retimed: [], retimeSkipped: [] };
    expect(synchronizeSummary({ ...base, failures: [{ clipId: "a", message: "Clip has no audio." }] })).toBe("Clip has no audio.");
    expect(synchronizeSummary({ ...base, failures: [{ clipId: "a", message: "x" }, { clipId: "b", message: "y" }] })).toBe("Couldn't align 2 clips.");
    const synced = [{ clipId: "a", offsetFrames: 1, confidence: 1, method: "audio" as const }];
    expect(synchronizeSummary({ ...base, synced, shiftedFrames: 3 })).toBe("Synchronized 1 clip: by audio, group moved right to fit.");
  });
});
