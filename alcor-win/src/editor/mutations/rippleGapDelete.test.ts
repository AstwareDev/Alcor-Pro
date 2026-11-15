import { describe, expect, it } from "vitest";
import { rippleDeleteSelectedGap } from "./ripple";
import { Fixtures, makeEditor, selectGap, sortedByStart } from "./testFixtures";
import type { Track } from "../../model";

const starts = (track: Track): number[] => sortedByStart(track.clips).map((c) => c.startFrame);

describe("EditorViewModel - rippleDeleteSelectedGap", () => {
  it("closesGapAndClearsSelection", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 50 });
    const c2 = Fixtures.clip({ id: "c2", start: 100, duration: 50 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    selectGap(e, 0, 50, 100);
    rippleDeleteSelectedGap(e);
    expect(starts(e.timeline.tracks[0])).toEqual([0, 50]);
    expect(e.ui.selectedGap).toBeNull();
  });

  it("syncLockedTrackFollows", () => {
    const v = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 50 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const a = Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "a1", start: 120, duration: 30 })] });
    const e = makeEditor([v, a]);
    selectGap(e, 0, 50, 100);
    rippleDeleteSelectedGap(e);
    expect(starts(e.timeline.tracks[0])).toEqual([0, 50]);
    expect(starts(e.timeline.tracks[1])).toEqual([70]);
  });

  it("refusesWhenSyncLockedFollowerWouldCollide", () => {
    const v = Fixtures.videoTrack({
      clips: [Fixtures.clip({ id: "c1", start: 0, duration: 50 }), Fixtures.clip({ id: "c2", start: 100, duration: 50 })],
    });
    const a = Fixtures.audioTrack({
      clips: [Fixtures.clip({ id: "a1", start: 0, duration: 55 }), Fixtures.clip({ id: "a2", start: 100, duration: 50 })],
    });
    const e = makeEditor([v, a]);
    selectGap(e, 0, 50, 100);
    rippleDeleteSelectedGap(e);
    expect(starts(e.timeline.tracks[0])).toEqual([0, 100]);
    expect(starts(e.timeline.tracks[1])).toEqual([0, 100]);
    expect(e.store.canUndo).toBe(false);
    expect(e.ui.toast?.kind).toBe("error");
  });

  it("noOpWhenGapNoLongerEmpty", () => {
    const v = Fixtures.videoTrack({
      clips: [
        Fixtures.clip({ id: "c1", start: 0, duration: 50 }),
        Fixtures.clip({ id: "c3", start: 60, duration: 30 }),
        Fixtures.clip({ id: "c2", start: 100, duration: 50 }),
      ],
    });
    const e = makeEditor([v]);
    selectGap(e, 0, 50, 100);
    rippleDeleteSelectedGap(e);
    expect(starts(e.timeline.tracks[0])).toEqual([0, 60, 100]);
    expect(e.ui.selectedGap).toBeNull();
    expect(e.store.canUndo).toBe(false);
  });

  it("undoRestoresTheGap", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 50 });
    const c2 = Fixtures.clip({ id: "c2", start: 100, duration: 50 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    const before = e.timeline;
    selectGap(e, 0, 50, 100);
    rippleDeleteSelectedGap(e);
    expect(e.store.undoActionName).toBe("Ripple Delete");
    e.undo();
    expect(e.timeline).toBe(before);
  });
});
