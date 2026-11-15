import { describe, expect, it } from "vitest";
import { decodeProjectFile, makeProjectFile } from "../../model/projectFile";
import { makeTrack, makeTransition, type Track } from "../../model";
import { splitClip, moveClips, removeClips } from "./clipMutations";
import { rippleTrimClip, trimClips } from "./ripple";
import {
  addTransition, addTransitionAfterClip, addTransitionNearPlayhead, findTransition, removeTransition, timelineCuts, updateTransition,
} from "./transitions";
import { Fixtures, makeEditor } from "./testFixtures";

function twoClips() {
  const track = Fixtures.videoTrack({
    clips: [Fixtures.clip({ id: "a", start: 0, duration: 60, trimEnd: 30 }), Fixtures.clip({ id: "b", start: 60, duration: 60, trimStart: 20 })],
  });
  return { e: makeEditor([track]), track };
}

const transitionsOf = (e: ReturnType<typeof makeEditor>): Track["transitions"] => e.timeline.tracks[0]?.transitions;
const idOf = (r: ReturnType<typeof addTransition>): string => {
  if (!r.ok) throw new Error(r.reason);
  return r.transition.id;
};

describe("transitions - add / change / remove", () => {
  it("adds a 0.5 s cross dissolve at a cut and selects it", () => {
    const { e } = twoClips();
    const r = addTransition(e, "a", "b");
    expect(r.ok).toBe(true);
    const t = transitionsOf(e)?.[0];
    expect(t).toMatchObject({ fromClipId: "a", toClipId: "b", kind: "crossDissolve", durationFrames: 15, alignment: "center" });
    expect(e.ui.selectedTransitionId).toBe(t?.id);
    expect(e.store.undoActionName).toBe("Add Transition");
  });

  it("refuses non-adjacent clips, other tracks, a second transition at one cut and tiny clips", () => {
    const track = Fixtures.videoTrack({
      clips: [
        Fixtures.clip({ id: "a", start: 0, duration: 60 }), Fixtures.clip({ id: "gap", start: 70, duration: 60 }),
        Fixtures.clip({ id: "tiny1", start: 130, duration: 1 }), Fixtures.clip({ id: "tiny2", start: 131, duration: 1 }),
      ],
    });
    const other = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "x", start: 60, duration: 10 })] });
    const e = makeEditor([track, other]);
    expect(addTransition(e, "a", "gap").ok).toBe(false);
    expect(addTransition(e, "a", "x").ok).toBe(false);
    expect(addTransition(e, "tiny1", "tiny2").ok).toBe(false);
    expect(addTransition(e, "a", "nope").ok).toBe(false);
    expect(e.store.canUndo).toBe(false);
    const { e: e2 } = twoClips();
    expect(addTransition(e2, "a", "b").ok).toBe(true);
    expect(addTransition(e2, "a", "b").ok).toBe(false);
  });

  it("changes kind, duration and alignment, clamped to the clips, one undo entry each", () => {
    const { e } = twoClips();
    const id = idOf(addTransition(e, "a", "b"));
    expect(updateTransition(e, id, { kind: "wipeLeft", durationFrames: 20 }).ok).toBe(true);
    expect(findTransition(e, id)?.transition).toMatchObject({ kind: "wipeLeft", durationFrames: 20 });
    updateTransition(e, id, { durationFrames: 9999 });
    expect(findTransition(e, id)?.transition.durationFrames).toBe(60);
    updateTransition(e, id, { alignment: "start" });
    expect(findTransition(e, id)?.transition).toMatchObject({ alignment: "start", durationFrames: 30 });
    e.undo();
    expect(findTransition(e, id)?.transition).toMatchObject({ alignment: "center", durationFrames: 60 });
    const name = e.store.undoActionName;
    updateTransition(e, id, { kind: "wipeLeft" });
    expect(e.store.undoActionName).toBe(name);
  });

  it("removes a transition and undoes it", () => {
    const { e } = twoClips();
    const id = idOf(addTransition(e, "a", "b"));
    expect(removeTransition(e, id)).toBe(true);
    expect(transitionsOf(e)).toBeUndefined();
    expect(e.ui.selectedTransitionId).toBeNull();
    expect(removeTransition(e, id)).toBe(false);
    e.undo();
    expect(transitionsOf(e)).toHaveLength(1);
  });

  it("adds after a clip and near the playhead", () => {
    const track = Fixtures.videoTrack({
      clips: [
        Fixtures.clip({ id: "a", start: 0, duration: 60 }), Fixtures.clip({ id: "b", start: 60, duration: 60 }),
        Fixtures.clip({ id: "c", start: 120, duration: 60 }),
      ],
    });
    const e = makeEditor([track]);
    e.ui.currentFrame = 110;
    const near = addTransitionNearPlayhead(e);
    expect(near.ok && near.transition.fromClipId).toBe("b");
    e.ui.currentFrame = 118;
    const next = addTransitionNearPlayhead(e);
    expect(next.ok && next.transition.fromClipId).toBe("a");
    expect(addTransitionNearPlayhead(e).ok).toBe(false);
    expect(addTransitionAfterClip(e, "c").ok).toBe(false);
    expect(timelineCuts(e)).toHaveLength(2);
  });
});

describe("transitions - kept or dropped by edits", () => {
  it("drops the transition when the clips stop touching, in the same undo entry", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b");
    moveClips(e, [{ clipId: "b", toTrack: 0, toFrame: 80 }]);
    expect(transitionsOf(e)).toBeUndefined();
    e.undo();
    expect(transitionsOf(e)).toHaveLength(1);
    expect(e.timeline.tracks[0]?.clips.find((c) => c.id === "b")?.startFrame).toBe(60);
  });

  it("drops it when a clip is removed", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b");
    removeClips(e, new Set(["b"]));
    expect(transitionsOf(e)).toBeUndefined();
  });

  it("keeps it through a ripple trim that preserves the cut and shortens it when a clip gets too small", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b", { durationFrames: 50 });
    rippleTrimClip(e, "a", "right", -40, false);
    const t = transitionsOf(e)?.[0];
    expect(t?.fromClipId).toBe("a");
    expect(e.timeline.tracks[0]?.clips.find((c) => c.id === "b")?.startFrame).toBe(20);
    expect(t?.durationFrames).toBe(21);
  });

  it("drops it when a plain trim opens a gap at the cut", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b");
    trimClips(e, [{ clipId: "a", trimStartFrame: 0, trimEndFrame: 40 }]);
    expect(e.timeline.tracks[0]?.clips.find((c) => c.id === "a")?.durationFrames).toBe(50);
    expect(transitionsOf(e)).toBeUndefined();
  });

  it("razor: the cut after the clip moves to its right half; a split of the incoming clip keeps it", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b");
    splitClip(e, "a", 30);
    const t = transitionsOf(e)?.[0];
    const right = e.timeline.tracks[0]?.clips.find((c) => c.startFrame === 30);
    expect(t?.fromClipId).toBe(right?.id);
    expect(t?.toClipId).toBe("b");
    splitClip(e, "b", 90);
    expect(transitionsOf(e)).toHaveLength(1);
    expect(transitionsOf(e)?.[0]?.toClipId).toBe("b");
  });

  it("razor close to the cut shortens the transition to what the half can host", () => {
    const { e } = twoClips();
    addTransition(e, "a", "b", { durationFrames: 40 });
    splitClip(e, "a", 50);
    expect(transitionsOf(e)?.[0]?.durationFrames).toBe(11);
  });
});

describe("transitions - project file", () => {
  it("round-trips through the project codec and data without the key still decodes", () => {
    const { e, track } = twoClips();
    addTransition(e, "a", "b", { kind: "irisCircle", durationFrames: 12, alignment: "end" });
    const tl = e.timeline;
    const file = makeProjectFile({ timelines: [tl], activeTimelineId: tl.id, openTimelineIds: [tl.id] });
    const back = decodeProjectFile(JSON.parse(JSON.stringify(file)) as unknown);
    expect(back.timelines[0]?.tracks[0]?.transitions).toEqual(tl.tracks[0]?.transitions);
    const plain = JSON.parse(JSON.stringify(makeProjectFile({ timelines: [{ ...tl, tracks: [track] }], activeTimelineId: tl.id, openTimelineIds: [tl.id] }))) as {
      timelines: { tracks: object[] }[];
    };
    expect("transitions" in (plain.timelines[0]?.tracks[0] ?? {})).toBe(false);
    expect(decodeProjectFile(plain).timelines[0]?.tracks[0]?.transitions).toBeUndefined();
  });

  it("an unknown kind from a newer build decodes to a cross dissolve", () => {
    const t = JSON.parse(JSON.stringify(makeTransition({ fromClipId: "a", toClipId: "b", durationFrames: 9 }))) as Record<string, unknown>;
    t.kind = "starWipe";
    const track = JSON.parse(JSON.stringify(makeTrack({ type: "video" }))) as Record<string, unknown>;
    track.transitions = [t];
    const tl = makeEditor([]).timeline;
    const file = JSON.parse(JSON.stringify(makeProjectFile({ timelines: [tl], activeTimelineId: tl.id, openTimelineIds: [tl.id] }))) as {
      timelines: { tracks: unknown[] }[];
    };
    (file.timelines[0] as { tracks: unknown[] }).tracks = [track];
    expect(decodeProjectFile(file).timelines[0]?.tracks[0]?.transitions?.[0]?.kind).toBe("crossDissolve");
  });
});
