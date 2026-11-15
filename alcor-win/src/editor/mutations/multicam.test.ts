import { describe, expect, it } from "vitest";
import {
  clipEndFrame, clipFreshenIds, decodeClip, decodeProjectFile, makeClip, makeMulticamMember, makeMulticamSource,
  makeProjectFile, makeTrack, type Clip, type MulticamSource,
} from "../../model";
import { addClips, commitClipSpeed, moveClips, removeClips, splitClip } from "./clipMutations";
import { duplicateClipsToPositions } from "./clipboard";
import { commitTrim, linkGroupOffsets } from "./linking";
import { multicamClips, multicamTrimBounds } from "./multicamRules";
import { planRippleTrim, rippleTrimPlanTargetIds, rippleDeleteRangesOnTrack, rippleDeleteSelectedClips, rippleTrimClip } from "./ripple";
import { makeFrameRange as FrameRange } from "../rippleEngine";
import { Fixtures, clipById, makeAsset, makeEditor, setup, sortedByStart } from "./testFixtures";
import type { Editor } from "../editor";

// Port of the editor-dependent Tests/PalmierProTests/Timeline/MulticamEngineTests.swift cases.
// `harness()` writes the state createMulticamGroup produces for the fixture below (see multicamSwitching.test.ts for
// the tests that call it): one stamped camA program clip on the new video track 0, and the stamped mic clip on its
// own audio track, no link group.
// Group clock at 30fps: camA covers [0, 3600), camB [150, 3450), mic1 (master) [60, 3960).
const groupId = "G";

function harness(): { e: Editor; group: MulticamSource } {
  const camA = makeMulticamMember({ id: "ma", mediaRef: "camA", kind: "angle", angleLabel: "cam-a", sync: { offsetSeconds: 0, confidence: 1, locked: false } });
  const camB = makeMulticamMember({ id: "mb", mediaRef: "camB", kind: "angle", angleLabel: "cam-b", sync: { offsetSeconds: 5, confidence: 0.9, locked: false } });
  const mic = makeMulticamMember({ id: "mm", mediaRef: "mic1", kind: "mic", angleLabel: "mic-1", sync: { offsetSeconds: 2, confidence: 1, locked: false } });
  const group = makeMulticamSource({ id: groupId, name: "MC", members: [camA, camB, mic], masterMemberId: mic.id });
  const program = Fixtures.clip({ id: "prog", mediaRef: "camA", mediaType: "video", start: 0, duration: 3600 });
  program.multicamGroupId = groupId;
  const micClip = Fixtures.clip({ id: "micc", mediaRef: "mic1", mediaType: "audio", start: 60, duration: 3900 });
  micClip.multicamGroupId = groupId;
  const e = makeEditor([Fixtures.videoTrack({ clips: [program] }), Fixtures.audioTrack({ clips: [micClip] })]);
  setup(e, () => {
    e.doc.multicamGroups.push(group);
    e.doc.mediaAssets.push(
      makeAsset({ id: "camA", type: "video", duration: 120, hasAudio: true }),
      makeAsset({ id: "camB", type: "video", duration: 110, hasAudio: true }),
      makeAsset({ id: "mic1", type: "audio", duration: 130 }),
    );
  });
  return { e, group };
}

function programClips(e: Editor): Clip[] {
  return sortedByStart(multicamClips(e, groupId).filter((c) => e.timeline.tracks[c.trackIndex].type === "video").map((c) => c.clip));
}

function micClips(e: Editor): Clip[] {
  return sortedByStart(multicamClips(e, groupId).filter((c) => c.clip.mediaType === "audio").map((c) => c.clip));
}

function need<T>(v: T | null | undefined): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

function rippleSeam(e: Editor) {
  expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(600, 700)]).kind).toBe("ok");
  const program = programClips(e);
  const mic = micClips(e);
  return {
    leftProgram: need(program.find((c) => clipEndFrame(c) === 600)),
    rightProgram: need(program.find((c) => c.startFrame === 600)),
    leftMic: need(mic.find((c) => clipEndFrame(c) === 600)),
    rightMic: need(mic.find((c) => c.startFrame === 600)),
  };
}

const toastMentionsMulticam = (e: Editor): boolean => e.ui.toast?.message.toLowerCase().includes("multicam") === true;

describe("Multicam (model)", () => {
  it("groupMetadataRoundTripsThroughProjectFile", () => {
    const member = makeMulticamMember({ mediaRef: "a", kind: "both", angleLabel: "host", sync: { offsetSeconds: 1.5, confidence: 0.91, locked: false } });
    const group = makeMulticamSource({ name: "Pod", members: [member], masterMemberId: member.id });
    const timeline = Fixtures.timeline();
    const stamped = makeClip({ mediaRef: "a", startFrame: 0, durationFrames: 10 });
    stamped.multicamGroupId = group.id;
    timeline.tracks = [makeTrack({ type: "video", clips: [stamped] })];
    const file = makeProjectFile({ timelines: [timeline], multicamGroups: [group] });
    const decoded = decodeProjectFile(JSON.parse(JSON.stringify(file)));
    expect(decoded.multicamGroups).toEqual([group]);
  });

  it("clipStampSurvivesCodingAndLegacyDecodesNil", () => {
    const clip = makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 10 });
    clip.multicamGroupId = "g1";
    expect(decodeClip(JSON.parse(JSON.stringify(clip))).multicamGroupId).toBe("g1");
    const plain = decodeClip(JSON.parse(JSON.stringify(makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 10 }))));
    expect(plain.multicamGroupId).toBeUndefined();
  });

  it("freshenIdsPreservesStampVerbatim", () => {
    const clip = makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 10 });
    clip.multicamGroupId = "g1";
    clip.linkGroupId = "L1";
    clipFreshenIds(clip, new Map());
    expect(clip.multicamGroupId).toBe("g1");
    expect(clip.linkGroupId).not.toBe("L1");
  });
});

describe("Multicam (guardrails)", () => {
  it("partialRippleAcrossGroupRefuses", () => {
    const { e } = harness();
    // The Swift test severs the A/V link first; this fixture has none.
    const outcome = rippleDeleteRangesOnTrack(e, 1, [FrameRange(300, 400)], new Set([0]));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.toLowerCase()).toContain("multicam");
    expect(toastMentionsMulticam(e)).toBe(true);
  });

  it("atomicRippleKeepsRelativeAlignment", () => {
    const { e } = harness();
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(300, 400)]).kind).toBe("ok");
    // Fragment after the cut resumes at source 400 - content at a position never changed.
    expect(programClips(e).find((c) => c.startFrame === 300)?.trimStartFrame).toBe(400);
    const mic = micClips(e);
    expect(mic.length).toBe(2);
    expect(mic[1].startFrame).toBe(300);
    // mic offset is 2s (60 frames): group 400 -> mic source 340.
    expect(mic[1].trimStartFrame).toBe(340);
  });

  it("partialMoveRefused", () => {
    const { e } = harness();
    const before = programClips(e)[0].startFrame;
    moveClips(e, [{ clipId: "prog", toTrack: 0, toFrame: before + 500 }]);
    expect(programClips(e)[0].startFrame).toBe(before);
  });

  it("speedRefusedOnStampedClips", () => {
    const { e } = harness();
    commitClipSpeed(e, ["prog"], 2.0);
    expect(programClips(e)[0].speed).toBe(1.0);
  });

  it("splitAndDeleteStayFree", () => {
    const { e } = harness();
    splitClip(e, "prog", 600);
    let clips = programClips(e);
    expect(clips.length).toBe(2);
    expect(clips.every((c) => c.multicamGroupId === groupId)).toBe(true);
    removeClips(e, new Set([clips[1].id]));
    clips = programClips(e);
    expect(clips.length).toBe(1);
  });

  it("manualRippleRefusedOnlyWhenStraddlingGroup", () => {
    const { e } = harness();
    splitClip(e, "prog", 600);
    const left = programClips(e)[0];

    // Deleting the first fragment shifts through the mic's middle - refused.
    const before = programClips(e).map((c) => c.startFrame);
    e.ui.selectedClipIds = new Set([left.id]);
    rippleDeleteSelectedClips(e);
    expect(programClips(e).map((c) => c.startFrame)).toEqual(before);
    expect(toastMentionsMulticam(e)).toBe(true);

    // Ripple trim mid-group straddles the mic - refused.
    e.ui.toast = null;
    rippleTrimClip(e, left.id, "right", -60, false);
    expect(programClips(e).map((c) => c.startFrame)).toEqual(before);
    expect(toastMentionsMulticam(e)).toBe(true);

    // Range ripples (remove_silence / remove_words) stay allowed.
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(100, 200)]).kind).toBe("ok");
  });

  it("alignedRippleTrimShrinksProgramAndMicTogether", () => {
    const { e } = harness();
    const seam = rippleSeam(e);
    rippleTrimClip(e, seam.leftProgram.id, "right", -60, false);
    expect(clipEndFrame(clipById(e, seam.leftProgram.id))).toBe(540);
    expect(clipById(e, seam.rightProgram.id).startFrame).toBe(540);
    expect(clipEndFrame(clipById(e, seam.leftMic.id))).toBe(540);
    expect(clipById(e, seam.rightMic.id).startFrame).toBe(540);
    expect(linkGroupOffsets(e).size).toBe(0);
  });

  it("alignedRippleExtendGrowsProgramAndMicTogether", () => {
    const { e } = harness();
    const seam = rippleSeam(e);
    const plan = planRippleTrim(e, seam.leftProgram.id, "right", 40, false);
    expect(plan).not.toBeNull();
    expect(plan ? rippleTrimPlanTargetIds(plan) : undefined).toEqual(new Set([seam.leftProgram.id, seam.leftMic.id]));
    rippleTrimClip(e, seam.leftProgram.id, "right", 40, false);
    expect(clipEndFrame(clipById(e, seam.leftProgram.id))).toBe(640);
    expect(clipById(e, seam.rightProgram.id).startFrame).toBe(640);
    expect(clipEndFrame(clipById(e, seam.leftMic.id))).toBe(640);
    expect(clipById(e, seam.rightMic.id).startFrame).toBe(640);
    expect(linkGroupOffsets(e).size).toBe(0);
  });

  it("alignedRippleShrinkStopsAtShortestMember", () => {
    const { e } = harness();
    const seam = rippleSeam(e);
    const micLoc = need(e.findClip(seam.leftMic.id));
    const shortenedDuration = 30;
    const removedHead = seam.leftMic.durationFrames - shortenedDuration;
    setup(e, () => {
      const mic = e.timeline.tracks[micLoc.trackIndex].clips[micLoc.clipIndex];
      mic.startFrame += removedHead;
      mic.trimStartFrame += removedHead;
      mic.durationFrames = shortenedDuration;
    });

    const plan = planRippleTrim(e, seam.leftProgram.id, "right", -60, false);
    expect(plan?.durationDelta).toBe(-(shortenedDuration - 1));
    rippleTrimClip(e, seam.leftProgram.id, "right", -60, false);

    const expectedEdge = clipEndFrame(seam.leftProgram) - (shortenedDuration - 1);
    expect(clipEndFrame(clipById(e, seam.leftProgram.id))).toBe(expectedEdge);
    expect(clipById(e, seam.leftMic.id).durationFrames).toBe(1);
    expect(clipEndFrame(clipById(e, seam.leftMic.id))).toBe(expectedEdge);
    expect(clipById(e, seam.rightProgram.id).startFrame).toBe(expectedEdge);
    expect(clipById(e, seam.rightMic.id).startFrame).toBe(expectedEdge);
    expect(linkGroupOffsets(e).size).toBe(0);
  });

  it("alignedLeftRippleTargetsProgramAndMicTogether", () => {
    const { e } = harness();
    const seam = rippleSeam(e);
    const programTrim = seam.rightProgram.trimStartFrame;
    const micTrim = seam.rightMic.trimStartFrame;
    rippleTrimClip(e, seam.rightProgram.id, "left", 30, false);
    expect(clipById(e, seam.rightProgram.id).trimStartFrame).toBe(programTrim + 30);
    expect(clipById(e, seam.rightMic.id).trimStartFrame).toBe(micTrim + 30);
    expect(linkGroupOffsets(e).size).toBe(0);
  });

  it("alignedRippleTrimUndoesAsOneAction", () => {
    const { e } = harness();
    const seam = rippleSeam(e);
    const before = e.timeline;
    rippleTrimClip(e, seam.leftProgram.id, "right", -60, false);
    expect(e.store.undoActionName).toBe("Ripple Trim");
    expect(e.undo()).toBe("Ripple Trim");
    expect(e.timeline).toBe(before);
  });

  it("manualRippleAfterGroupStaysAllowed", () => {
    const { e } = harness();
    // Plain clip entirely after the group; deleting it shifts nothing of the group.
    const camA = need(e.doc.mediaAssets.find((a) => a.id === "camA"));
    addClips(e, [camA], 0, 5000);
    const stray = need(e.timeline.tracks.flatMap((t) => t.clips).find((c) => c.multicamGroupId === undefined && c.startFrame === 5000));
    const groupBefore = programClips(e).map((c) => c.startFrame);
    e.ui.selectedClipIds = new Set([stray.id]);
    rippleDeleteSelectedClips(e);
    expect(e.clipFor(stray.id)).toBeNull();
    expect(programClips(e).map((c) => c.startFrame)).toEqual(groupBefore);
  });

  it("duplicateDropsStamp", () => {
    const { e } = harness();
    duplicateClipsToPositions(e, [{ clipId: "prog", toTrack: 0, toFrame: 9000 }]);
    const clone = e.timeline.tracks.flatMap((t) => t.clips).find((c) => c.startFrame === 9000);
    expect(clone).toBeDefined();
    expect(clone?.multicamGroupId).toBeUndefined();
  });

  it("overwriteTrimClearsWhatItCovers", () => {
    const { e } = harness();
    splitClip(e, "prog", 600);
    let clips = programClips(e);
    const left = clips[0];
    const right = clips[1];
    // Shrink the right clip's head, then extend the left clip over the gap: growth must overwrite the neighbour.
    commitTrim(e, right.id, "left", 90, false);
    commitTrim(e, left.id, "right", 150, false);
    clips = programClips(e);
    expect(clips.length).toBe(2);
    expect(clipEndFrame(clips[0])).toBe(750);
    expect(clips[1].startFrame).toBe(750);
  });

  it("trimStopsAtRippleSeamAndCoverage", () => {
    const { e } = harness();
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(600, 700)]).kind).toBe("ok");
    const program = programClips(e);
    const left = need(program.find((c) => clipEndFrame(c) === 600));
    const right = need(program.find((c) => c.startFrame === 600));
    removeClips(e, new Set([left.id]));

    // Seam stop: leftward growth is 0 - those frames were cut and the mics no longer carry them.
    const bounds = multicamTrimBounds(e, clipById(e, right.id));
    expect(bounds?.left).toBe(0);
    commitTrim(e, right.id, "left", -80, false);
    expect(clipById(e, right.id).startFrame).toBe(600);

    // Coverage stop: rightward growth caps at the remaining camera footage.
    const tail = clipById(e, right.id);
    expect(bounds?.right).toBe(tail.trimEndFrame);
    commitTrim(e, right.id, "right", tail.trimEndFrame + 500, false);
    expect(clipById(e, right.id).trimEndFrame).toBe(0);
  });

  it("syncedMembersShowNoLinkOffsetBadge", () => {
    const { e } = harness();
    // Members sit at different trims by design - the misalignment badge must stay silent for an in-sync group.
    expect(linkGroupOffsets(e).size).toBe(0);
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(300, 400), FrameRange(900, 1050)]).kind).toBe("ok");
    expect(linkGroupOffsets(e).size).toBe(0);

    // A genuine slip (dodging the guards) must still be flagged.
    const loc = need(e.findClip(micClips(e)[0].id));
    setup(e, () => {
      e.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].trimStartFrame += 24;
    });
    expect(linkGroupOffsets(e).size).toBeGreaterThan(0);
  });
});
