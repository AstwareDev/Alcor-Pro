import { describe, expect, it } from "vitest";
import { makeKeyframe, makeKeyframeTrack } from "../model";
import { commitClipProperties } from "../editor/mutations/clipMutations";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import { clipDefaults, valuesModified } from "./resetState";

const resetOpacity = (c: { opacity: number; opacityTrack?: unknown }): void => {
  c.opacity = clipDefaults().opacity;
  delete c.opacityTrack;
};

describe("reset to default", () => {
  it("reportsModifiedOnlyWhenTheResetWouldChangeSomething", () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    expect(valuesModified([clip], resetOpacity)).toBe(false);
    expect(valuesModified([{ ...clip, opacity: 0.4 }], resetOpacity)).toBe(true);
    expect(valuesModified([{ ...clip, opacityTrack: makeKeyframeTrack([makeKeyframe(3, 0.5)]) }], resetOpacity)).toBe(true);
    expect(valuesModified([clip, { ...clip, opacity: 0.4 }], resetOpacity)).toBe(true);
  });

  it("resettingAKeyframedPropertyRemovesTheAnimationInOneUndoEntry", () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    clip.opacity = 0.3;
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0.2), makeKeyframe(10, 0.9)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const before = structuredClone(e.timeline);

    commitClipProperties(e, ["c"], resetOpacity, "Reset Opacity");
    const after = e.timeline.tracks[0].clips[0];
    expect(after.opacity).toBe(clipDefaults().opacity);
    expect(after.opacityTrack).toBeUndefined();
    expect(e.store.undoActionName).toBe("Reset Opacity");

    e.undo();
    expect(e.timeline).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("resettingADefaultValueRecordsNothing", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 0, duration: 30 })] })]);
    commitClipProperties(e, ["c"], resetOpacity, "Reset Opacity");
    expect(e.store.canUndo).toBe(false);
  });
});
