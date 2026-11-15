import { describe, expect, it } from "vitest";
import { clipEndFrame, makeCrop, makeTransform, type Clip, type MulticamSyncMap } from "../../model";
import { makeAsset, makeEditor, setup } from "./testFixtures";
import { addClips, mutateClips, removeClips, splitClip } from "./clipMutations";
import {
  angleSwitchRequest, createMulticamGroup, multicamAngleLabel, multicamProgramRows, savedMulticamGroups, switchMulticamAngles,
  switchMulticamSegment, ungroupMulticam, type MulticamMemberSpec,
} from "./multicam";
import { multicamClips, multicamGroupById } from "./multicamRules";
import { rippleDeleteRangesOnTrack } from "./ripple";
import { insertTrack } from "./tracks";
import { makeFrameRange as FrameRange } from "../rippleEngine";
import type { Editor } from "../editor";

// Ports of the createMulticamGroup / switchMulticamAngles / switchMic / program-row / ungroup / savedMulticamGroups
// cases of Tests/PalmierProTests/Timeline/MulticamEngineTests.swift (group clock at 30fps: camA covers [0, 3600),
// camB [150, 3450), mic1 (master) [60, 3960)).

const syncMap = (offsetSeconds: number, confidence: number): MulticamSyncMap => ({ offsetSeconds, confidence, locked: false });

function harness(): Editor {
  const e = makeEditor([]);
  setup(e, () => {
    e.doc.mediaAssets.push(
      makeAsset({ id: "camA", type: "video", duration: 120, hasAudio: true }),
      makeAsset({ id: "camB", type: "video", duration: 110, hasAudio: true }),
      makeAsset({ id: "mic1", type: "audio", duration: 130 }),
    );
  });
  return e;
}

const specs = (): MulticamMemberSpec[] => [
  { mediaRef: "camA", kind: "angle", angleLabel: "cam-a" },
  { mediaRef: "camB", kind: "angle", angleLabel: "cam-b" },
  { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1" },
];

const maps = (): Map<string, MulticamSyncMap> =>
  new Map([["camA", syncMap(0, 1)], ["camB", syncMap(5, 0.9)], ["mic1", syncMap(2, 1)]]);

function createGroup(e: Editor): { groupId: string; clipIds: string[] } {
  return createMulticamGroup(e, { specs: specs(), syncMaps: maps(), masterRef: "mic1", name: "MC", startFrame: 0 });
}

const span = (lowerBound: number, upperBound: number) => ({ lowerBound, upperBound });

function programClips(e: Editor, groupId: string): Clip[] {
  return multicamClips(e, groupId)
    .filter((c) => e.timeline.tracks[c.trackIndex].type === "video")
    .map((c) => c.clip)
    .sort((a, b) => a.startFrame - b.startFrame);
}

function micClip(e: Editor, groupId: string): Clip {
  const found = multicamClips(e, groupId).find((c) => c.clip.mediaType === "audio");
  if (!found) throw new Error("no mic clip");
  return found.clip;
}

describe("Multicam creation", () => {
  it("createFillsProgramHolesWithCoveringAngles", () => {
    // Seed camera stops early; a longer angle must fill the tail - no gap where some camera has picture.
    const e = makeEditor([]);
    setup(e, () => {
      e.doc.mediaAssets.push(
        makeAsset({ id: "short", type: "video", duration: 20, hasAudio: true }),
        makeAsset({ id: "wide", type: "video", duration: 120, hasAudio: true }),
        makeAsset({ id: "mic1", type: "audio", duration: 130 }),
      );
    });
    const { groupId } = createMulticamGroup(e, {
      specs: [
        { mediaRef: "short", kind: "angle", angleLabel: "close" },
        { mediaRef: "wide", kind: "angle", angleLabel: "wide" },
        { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1" },
      ],
      syncMaps: new Map([["short", syncMap(0, 1)], ["wide", syncMap(0, 1)], ["mic1", syncMap(0, 1)]]),
      masterRef: "mic1",
      name: "MC",
      startFrame: 0,
    });
    const program = programClips(e, groupId);
    expect(program.map((c) => c.mediaRef)).toEqual(["short", "wide"]);
    expect(clipEndFrame(program[0])).toBe(600);
    expect(program[1].startFrame).toBe(600);
    expect(clipEndFrame(program[1])).toBe(3600);
    // The filler shows its own source at the right moment, not from zero.
    expect(program[1].trimStartFrame).toBe(600);
  });

  it("createLaysStampedClips", () => {
    const e = harness();
    const { groupId, clipIds } = createGroup(e);
    expect(clipIds.length).toBe(2);

    const program = programClips(e, groupId);
    expect(program.length).toBe(1);
    // Video spans the union of camera coverage.
    expect(program[0].startFrame).toBe(0);
    expect(clipEndFrame(program[0])).toBe(3600);
    expect(program[0].mediaRef).toBe("camA");
    expect(program[0].multicamGroupId).toBe(groupId);
    expect(multicamAngleLabel(e, program[0])).toBe("cam-a");

    // Mic is its own audio clip at its offset - stamped, not linked: clips select and delete individually.
    const mic = micClip(e, groupId);
    expect(mic.startFrame).toBe(60);
    expect(mic.durationFrames).toBe(3900);
    expect(mic.trimStartFrame).toBe(0);
    expect(mic.linkGroupId).toBeUndefined();

    expect(multicamGroupById(e, groupId)?.name).toBe("MC");
  });

  it("createUndoDropsClipsAndMetadata", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    expect(e.store.undoActionName).toBe("Create Multicam");
    e.undo();
    expect(multicamClips(e, groupId)).toEqual([]);
    expect(multicamGroupById(e, groupId)).toBeUndefined();
    e.redo();
    expect(multicamGroupById(e, groupId)).toBeDefined();
    expect(multicamClips(e, groupId).length).toBe(2);
  });

  it("createValidatesBeforeMutating", () => {
    const e = harness();
    const before = e.timeline;
    expect(() => createMulticamGroup(e, { specs: specs(), syncMaps: maps(), masterRef: "nope" })).toThrow("Master member not found");
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("createUniquifiesAngleLabelsAndDefaultsName", () => {
    const e = harness();
    const { groupId } = createMulticamGroup(e, {
      specs: [
        { mediaRef: "camA", kind: "angle", angleLabel: "Cam A!!" },
        { mediaRef: "camB", kind: "angle", angleLabel: "cam a" },
        { mediaRef: "mic1", kind: "mic", angleLabel: "  " },
      ],
      syncMaps: maps(),
      masterRef: "mic1",
      startFrame: 0,
    });
    const group = multicamGroupById(e, groupId);
    expect(group?.members.map((m) => m.angleLabel)).toEqual(["cam-a", "cam-a-2", "angle"]);
    expect(group?.name).toBe("Multicam 1");
  });
});

describe("Multicam switching", () => {
  it("switchMicRewritesAudioClipInPlace", () => {
    const e = makeEditor([]);
    setup(e, () => {
      e.doc.mediaAssets.push(
        makeAsset({ id: "camA", type: "video", duration: 120, hasAudio: true }),
        makeAsset({ id: "lapel", type: "audio", duration: 130 }),
        makeAsset({ id: "room", type: "audio", duration: 125 }),
      );
    });
    const { groupId } = createMulticamGroup(e, {
      specs: [
        { mediaRef: "camA", kind: "angle", angleLabel: "cam-a" },
        { mediaRef: "lapel", kind: "mic", angleLabel: "lapel" },
        { mediaRef: "room", kind: "mic", angleLabel: "room" },
      ],
      syncMaps: new Map([["camA", syncMap(0, 1)], ["lapel", syncMap(2, 1)], ["room", syncMap(0, 1)]]),
      masterRef: "lapel",
      name: "MC",
      startFrame: 0,
    });
    // Chop the lapel lane, then switch just the middle piece to the room mic.
    const lapel = multicamClips(e, groupId).find((c) => c.clip.mediaRef === "lapel")?.clip;
    splitClip(e, lapel?.id ?? "", 600);
    const mid = multicamClips(e, groupId).find((c) => c.clip.mediaRef === "lapel" && c.clip.startFrame === 600)?.clip;
    splitClip(e, mid?.id ?? "", 1200);
    const target = multicamClips(e, groupId).find((c) => c.clip.mediaRef === "lapel" && c.clip.startFrame === 600)?.clip;

    switchMulticamSegment(e, target?.id ?? "", "room");
    const swapped = e.clipFor(target?.id ?? "");
    expect(swapped?.mediaRef).toBe("room");
    // Same real moment on the room mic's clock: lapel trim 540 + 2s*30.
    expect(swapped?.trimStartFrame).toBe(600);
    expect(swapped?.startFrame).toBe(600);
    expect(swapped ? clipEndFrame(swapped) : -1).toBe(1200);
    // Neighbors untouched.
    expect(multicamClips(e, groupId).filter((c) => c.clip.mediaRef === "lapel").length).toBe(2);
  });

  it("switchRewritesTrimThroughSyncMaps", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    const outcome = switchMulticamAngles(e, groupId, [angleSwitchRequest(span(600, 1200), "cam-b")]);
    expect(outcome.switched).toBe(1);
    const clips = programClips(e, groupId);
    expect(clips.map((c) => c.mediaRef)).toEqual(["camA", "camB", "camA"]);
    // Same real moment on cam-b's clock: 600 - (5-0)*30 = 450.
    expect(clips[1].trimStartFrame).toBe(450);
    expect(clips[1].startFrame).toBe(600);
    expect(clipEndFrame(clips[1])).toBe(1200);
    expect(clips[0].trimStartFrame).toBe(0);
    expect(clips[2].trimStartFrame).toBe(1200);
    expect(clips.every((c) => c.multicamGroupId === groupId)).toBe(true);
    expect(e.store.undoActionName).toBe("Switch Angle");
  });

  it("switchClampsToAngleCoverage", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    // cam-b has no picture before group frame 150.
    const outcome = switchMulticamAngles(e, groupId, [angleSwitchRequest(span(0, 600), "cam-b")]);
    expect(outcome.clamped.length).toBe(1);
    expect(outcome.clamped[0].applied).toEqual(span(150, 600));
    expect(outcome.clamped[0].culprit).toBe("cam-b");
    const clips = programClips(e, groupId);
    expect(clips.map((c) => c.mediaRef)).toEqual(["camA", "camB", "camA"]);
    expect(clips[1].startFrame).toBe(150);
  });

  it("userFramingSurvivesAngleSwitch", () => {
    const e = harness();
    const { groupId } = createGroup(e);

    // Cut a fragment out, then punch in on just that fragment.
    const program = programClips(e, groupId)[0];
    splitClip(e, program.id, 600);
    const fragment = programClips(e, groupId).find((c) => c.startFrame === 600);
    splitClip(e, fragment?.id ?? "", 1200);
    const punched = makeTransform({ width: 1.2, height: 1.2 });
    const framed = programClips(e, groupId).find((c) => c.startFrame === 600);
    mutateClips(e, new Set([framed?.id ?? ""]), "Frame", (c) => {
      c.transform = punched;
      c.crop = makeCrop({ left: 0.1 });
    });

    // The punch-in rides the swap; the crop is untouched.
    switchMulticamAngles(e, groupId, [angleSwitchRequest(span(600, 1200), "cam-b")]);
    const swapped = programClips(e, groupId).find((c) => c.startFrame === 600);
    expect(swapped?.mediaRef).toBe("camB");
    expect(swapped?.transform).toEqual(punched);
    expect(swapped?.crop).toEqual(makeCrop({ left: 0.1 }));

    // An unframed fragment stays at the default fit after switching.
    switchMulticamAngles(e, groupId, [angleSwitchRequest(span(1500, 1800), "cam-b")]);
    const plain = programClips(e, groupId).find((c) => c.startFrame === 1500);
    expect(plain?.crop).toEqual(makeCrop());
  });

  it("sameAngleSwitchMergesBack", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    switchMulticamAngles(e, groupId, [angleSwitchRequest(span(600, 1200), "cam-b")]);
    const back = switchMulticamAngles(e, groupId, [angleSwitchRequest(span(600, 1200), "cam-a")]);
    expect(back.merged).toBe(2);
    expect(programClips(e, groupId).length).toBe(1);
  });

  it("switchSurvivesWordCutFragments", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    // A word cut: ripple out [900, 1000) - the whole group shifts atomically.
    expect(rippleDeleteRangesOnTrack(e, 0, [FrameRange(900, 1000)]).kind).toBe("ok");
    // Switch across the seam.
    const outcome = switchMulticamAngles(e, groupId, [angleSwitchRequest(span(800, 1100), "cam-b")]);
    expect(outcome.switched).toBe(2);
    const swapped = programClips(e, groupId).filter((c) => c.mediaRef === "camB");
    // Each fragment shows cam-b at the same real time its camA content had:
    // before the seam camA trim 800 -> camB 650; after it camA trim 1000 -> camB 850.
    expect(swapped.some((c) => c.startFrame === 800 && c.trimStartFrame === 650)).toBe(true);
    expect(swapped.some((c) => c.trimStartFrame === 850)).toBe(true);
  });

  it("switchOutsideGroupSkips", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    const outcome = switchMulticamAngles(e, groupId, [angleSwitchRequest(span(90000, 90600), "cam-b")]);
    expect(outcome.switched).toBe(0);
    expect(outcome.skipped.length).toBe(1);
  });

  it("switchValidatesBeforeMutating", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    const before = e.timeline;
    expect(() => switchMulticamAngles(e, groupId, [angleSwitchRequest(span(0, 60), "cam-z")])).toThrow("cam-a");
    expect(() => switchMulticamAngles(e, groupId, [{ range: span(0, 60), angles: ["cam-a", "cam-b", "cam-a"], layout: "side_by_side" }])).toThrow(
      "takes at most 2 angle(s)",
    );
    expect(() => switchMulticamAngles(e, "nope", [angleSwitchRequest(span(0, 60), "cam-a")])).toThrow("Not a multicam group");
    expect(e.timeline).toBe(before);
  });

  it("angleSwitchLeavesUnrelatedUpperTrackClipsWhole", () => {
    const e = harness();
    setup(e, () => {
      e.doc.mediaAssets.push(makeAsset({ id: "title", type: "video", duration: 60, hasAudio: false }));
    });
    const { groupId } = createGroup(e);
    const titleAsset = e.mediaAsset("title");
    insertTrack(e, 0, "video");
    if (titleAsset) addClips(e, [titleAsset], 0, 100);
    const titleCount = (): number => e.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.mediaRef === "title").length;
    expect(titleCount()).toBe(1);

    switchMulticamAngles(e, groupId, [angleSwitchRequest(span(300, 900), "cam-b")]);
    expect(titleCount()).toBe(1);
  });

  it("programRowsRunLengthMerge", () => {
    const e = harness();
    const { groupId } = createGroup(e);
    switchMulticamAngles(e, groupId, [angleSwitchRequest(span(600, 1200), "cam-b")]);
    const rows = multicamProgramRows(e, groupId);
    expect(rows.map((r) => r[0])).toEqual(["cam-a", "cam-b", "cam-a"]);
    expect(rows[1][1]).toBe(600);
    expect(rows[1][2]).toBe(1200);
    expect(multicamProgramRows(e, groupId, span(500, 700)).map((r) => r.slice())).toEqual([["cam-a", 500, 600], ["cam-b", 600, 700]]);
  });
});

describe("Multicam lifecycle", () => {
  it("ungroupStripsStampsAndDropsMetadata", () => {
    const e = harness();
    const { groupId, clipIds } = createGroup(e);
    ungroupMulticam(e, groupId);
    expect(multicamClips(e, groupId)).toEqual([]);
    expect(multicamGroupById(e, groupId)).toBeUndefined();
    // Clips stay put as ordinary clips.
    const survivors = e.timeline.tracks.flatMap((t) => t.clips).filter((c) => clipIds.includes(c.id));
    expect(survivors.length).toBe(clipIds.length);
    expect(survivors.every((c) => c.multicamGroupId === undefined)).toBe(true);
    expect(e.store.undoActionName).toBe("Ungroup Multicam");
    e.undo();
    expect(multicamGroupById(e, groupId)).toBeDefined();
    expect(multicamClips(e, groupId).length).toBe(2);
  });

  it("ungroupUnknownGroupRecordsNothing", () => {
    const e = harness();
    ungroupMulticam(e, "missing");
    expect(e.store.canUndo).toBe(false);
  });

  it("unreferencedGroupsDontPersist", () => {
    const e = harness();
    const { groupId, clipIds } = createGroup(e);
    expect(savedMulticamGroups(e)?.length).toBe(1);
    removeClips(e, new Set(clipIds));
    // Metadata stays in memory for undo, but is filtered from saves.
    expect(multicamGroupById(e, groupId)).toBeDefined();
    expect(savedMulticamGroups(e)).toBeUndefined();
  });
});
