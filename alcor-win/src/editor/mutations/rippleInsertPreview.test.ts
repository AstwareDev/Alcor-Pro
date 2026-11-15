import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../../model";
import type { Editor } from "../editor";
import { makeFrameRange as FrameRange } from "../rippleEngine";
import {
  dropPlanAudioOnlyAssets,
  dropPlanVisualAssets,
  existingTrack,
  newTrackAt,
  resolveDropPlan,
  trackDropTargetKey,
  trackDropTargetsEqual,
} from "./linking";
import { planRippleInsertPreview } from "./ripple";
import { Fixtures, makeAsset, makeEditor, setup } from "./testFixtures";

function previewEditor(tracks: ReturnType<typeof Fixtures.videoTrack>[]): Editor {
  return makeEditor(tracks);
}

const ids = (assets: MediaAsset[]): string[] => assets.map((a) => a.id);

function unlocked<T extends { syncLocked: boolean }>(track: T): T {
  track.syncLocked = false;
  return track;
}

describe("EditorViewModel - ripple insert preview", () => {
  it("mixedVisualAndAudioOnlyDropUsesSeparateTargetTrackPushes", () => {
    const videoTrack = unlocked(Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "video-tail", start: 100, duration: 30 })] }));
    const audioTrack = unlocked(
      Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "audio-tail", mediaType: "audio", start: 100, duration: 30 })] }),
    );
    const e = previewEditor([videoTrack, audioTrack]);
    const video = makeAsset({ id: "video", type: "video", duration: 2 });
    const audio = makeAsset({ id: "audio", type: "audio", duration: 1 });

    const plan = resolveDropPlan(e, existingTrack(0), [video, audio], 50);
    const preview = planRippleInsertPreview(e, plan, 50);

    expect(ids(dropPlanVisualAssets(plan))).toEqual(["video"]);
    expect(ids(dropPlanAudioOnlyAssets(plan))).toEqual(["audio"]);
    expect(preview?.gapRangesByTrackIndex.get(0)).toEqual(FrameRange(50, 110));
    expect(preview?.gapRangesByTrackIndex.get(1)).toEqual(FrameRange(50, 80));
    expect(preview?.shiftDeltasByClipId.get("video-tail")).toBe(60);
    expect(preview?.shiftDeltasByClipId.get("audio-tail")).toBe(30);
  });

  it("syncLockedFollowerReceivesBothMixedDropPushes", () => {
    const videoTrack = unlocked(Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "video-tail", start: 100, duration: 30 })] }));
    const audioTrack = unlocked(
      Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "audio-tail", mediaType: "audio", start: 100, duration: 30 })] }),
    );
    const syncTrack = Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "sync-tail", mediaType: "audio", start: 100, duration: 30 })] });
    syncTrack.syncLocked = true;
    const e = previewEditor([videoTrack, audioTrack, syncTrack]);
    const video = makeAsset({ id: "video", type: "video", duration: 2 });
    const audio = makeAsset({ id: "audio", type: "audio", duration: 1 });

    const plan = resolveDropPlan(e, existingTrack(0), [video, audio], 50);
    const preview = planRippleInsertPreview(e, plan, 50);

    expect(preview?.gapRangesByTrackIndex.get(2)).toEqual(FrameRange(50, 140));
    expect(preview?.shiftDeltasByClipId.get("sync-tail")).toBe(90);
  });

  it("newTrackDropShowsShiftedVisualAndAudioTargetGaps", () => {
    const videoTrack = unlocked(Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "video-tail", start: 100, duration: 30 })] }));
    const audioTrack = unlocked(
      Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "audio-tail", mediaType: "audio", start: 100, duration: 30 })] }),
    );
    const e = previewEditor([videoTrack, audioTrack]);
    const video = makeAsset({ id: "video", type: "video", duration: 2 });
    const audio = makeAsset({ id: "audio", type: "audio", duration: 1 });

    const plan = resolveDropPlan(e, newTrackAt(1), [video, audio], 50);
    const preview = planRippleInsertPreview(e, plan, 50);

    expect(trackDropTargetsEqual(plan.visualTarget, newTrackAt(1))).toBe(true);
    expect(trackDropTargetsEqual(plan.audioTarget, newTrackAt(1))).toBe(true);
    expect(preview?.newTrackGapRangesByTarget.get(trackDropTargetKey(newTrackAt(1)))).toEqual(FrameRange(50, 110));
    expect(preview?.newTrackGapRangesByTarget.get(trackDropTargetKey(newTrackAt(2)))).toEqual(FrameRange(50, 80));
    expect(preview?.gapRangesByTrackIndex.size).toBe(0);
    expect(preview?.shiftDeltasByClipId.size).toBe(0);
  });

  it("emptyPlanProducesNoPreview", () => {
    const e = previewEditor([Fixtures.videoTrack()]);
    setup(e, () => undefined);
    expect(planRippleInsertPreview(e, resolveDropPlan(e, existingTrack(0), [], 0), 0)).toBeNull();
  });
});
