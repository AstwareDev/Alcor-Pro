import { describe, expect, it } from "vitest";
import { clipSourceDurationFrames, makeKeyframe, makeKeyframeTrack } from "../../model";
import { commitSlip } from "./linking";
import { Fixtures, makeEditor } from "./testFixtures";

describe("EditorViewModel - commitSlip", () => {
  it("slipRightRevealsEarlierMaterial", () => {
    const clip = Fixtures.clip({ id: "c1", start: 100, duration: 60, trimStart: 30, trimEnd: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 10, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(20);
    expect(updated.trimEndFrame).toBe(30);
    expect(updated.startFrame).toBe(100);
    expect(updated.durationFrames).toBe(60);
    expect(clipSourceDurationFrames(updated)).toBe(clipSourceDurationFrames(clip));
  });

  it("slipLeftRevealsLaterMaterial", () => {
    const clip = Fixtures.clip({ id: "c1", start: 100, duration: 60, trimStart: 30, trimEnd: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", -10, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(40);
    expect(updated.trimEndFrame).toBe(10);
  });

  it("slipClampsAtHeadMaterial", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 5, trimEnd: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 30, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(0);
    expect(updated.trimEndFrame).toBe(25);
  });

  it("slipClampsAtTailMaterial", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 20, trimEnd: 5 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", -30, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(25);
    expect(updated.trimEndFrame).toBe(0);
  });

  it("slipScalesTimelineDeltaThroughSpeed", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 40, trimEnd: 40, speed: 2.0 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 10, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(20);
    expect(updated.trimEndFrame).toBe(60);
  });

  it("slipSpeedAwareClampKeepsTrimsNonNegative", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 10, trimEnd: 40, speed: 2.0 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 10, true);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.trimStartFrame).toBe(0);
    expect(updated.trimEndFrame).toBe(50);
  });

  it("slipPropagatesToLinkedPartnerAndTightestHeadroomWins", () => {
    const v = Fixtures.clip({ id: "v1", start: 0, duration: 60, trimStart: 30, trimEnd: 30 });
    const a = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 60, trimStart: 8, trimEnd: 30 });
    v.linkGroupId = "g1";
    a.linkGroupId = "g1";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    commitSlip(e, "v1", 20, true);
    const video = e.timeline.tracks[0].clips[0];
    const audio = e.timeline.tracks[1].clips[0];
    expect(video.trimStartFrame).toBe(22);
    expect(video.trimEndFrame).toBe(38);
    expect(audio.trimStartFrame).toBe(0);
    expect(audio.trimEndFrame).toBe(38);
  });

  it("slipWithoutPropagationMovesOnlyLead", () => {
    const v = Fixtures.clip({ id: "v1", start: 0, duration: 60, trimStart: 30, trimEnd: 30 });
    const a = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 60, trimStart: 30, trimEnd: 30 });
    v.linkGroupId = "g1";
    a.linkGroupId = "g1";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    commitSlip(e, "v1", 10, false);
    expect(e.timeline.tracks[0].clips[0].trimStartFrame).toBe(20);
    expect(e.timeline.tracks[1].clips[0].trimStartFrame).toBe(30);
  });

  it("slipRefusesMulticamAndImageClips", () => {
    const mc = Fixtures.clip({ id: "mc", start: 0, duration: 60, trimStart: 30, trimEnd: 30 });
    mc.multicamGroupId = "group";
    const img = Fixtures.clip({ id: "img", mediaType: "image", start: 100, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [mc, img] })]);
    commitSlip(e, "mc", 10, true);
    commitSlip(e, "img", 10, true);
    expect(e.timeline.tracks[0].clips[0].trimStartFrame).toBe(30);
    expect(e.timeline.tracks[0].clips[1].trimStartFrame).toBe(0);
    expect(e.store.canUndo).toBe(false);
  });

  it("slipUndoRestoresOriginalTrims", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 30, trimEnd: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const before = e.timeline;
    commitSlip(e, "c1", 10, true);
    expect(e.timeline.tracks[0].clips[0].trimStartFrame).toBe(20);
    expect(e.store.undoActionName).toBe("Slip Clip");
    e.undo();
    const restored = e.timeline.tracks[0].clips[0];
    expect(restored.trimStartFrame).toBe(30);
    expect(restored.trimEndFrame).toBe(20);
    expect(e.timeline).toBe(before);
  });

  it("slipLeavesKeyframesUntouched", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 30, trimEnd: 20 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1.0), makeKeyframe(30, 0.5)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 10, true);
    expect(e.timeline.tracks[0].clips[0].opacityTrack?.keyframes.map((k) => k.frame)).toEqual([0, 30]);
  });

  it("slipZeroDeltaIsNoOp", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60, trimStart: 30, trimEnd: 20 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    commitSlip(e, "c1", 0, true);
    expect(e.store.canUndo).toBe(false);
    expect(e.timeline.tracks[0].clips[0].trimStartFrame).toBe(30);
  });
});
