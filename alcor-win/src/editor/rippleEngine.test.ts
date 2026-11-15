import { describe, expect, it } from "vitest";
import {
  computeRipplePush,
  computeRippleShifts,
  computeRippleShiftsForRanges,
  makeFrameRange as FrameRange,
  rippleMarkersClosing,
  rippleMarkersOpening,
} from "./rippleEngine";
import { Fixtures, marker } from "./mutations/testFixtures";

const clip = Fixtures.clip;

describe("RippleEngine", () => {
  // MARK: - computeRippleShifts (delete + close gap)

  it("emptyRemovedIdsProducesNoShifts", () => {
    const a = clip({ id: "a", start: 0, duration: 50 });
    const b = clip({ id: "b", start: 100, duration: 50 });
    expect(computeRippleShifts([a, b], new Set())).toEqual([]);
  });

  it("removingMiddleClipShiftsTrailingClipsLeft", () => {
    const removed = clip({ id: "r", start: 50, duration: 50 });
    const trailing = clip({ id: "t", start: 200, duration: 50 });
    const head = clip({ id: "h", start: 0, duration: 50 });
    const shifts = computeRippleShifts([head, removed, trailing], new Set(["r"]));
    expect(shifts).toEqual([{ clipId: "t", newStartFrame: 150 }]);
  });

  it("clipsBeforeRemovedRangeDoNotShift", () => {
    const head = clip({ id: "h", start: 0, duration: 50 });
    const removed = clip({ id: "r", start: 100, duration: 50 });
    expect(computeRippleShifts([head, removed], new Set(["r"]))).toEqual([]);
  });

  it("removingMultipleClipsShiftsByMergedTotal", () => {
    const r1 = clip({ id: "r1", start: 0, duration: 50 });
    const r2 = clip({ id: "r2", start: 100, duration: 50 });
    const tail = clip({ id: "t", start: 200, duration: 50 });
    const shifts = computeRippleShifts([r1, r2, tail], new Set(["r1", "r2"]));
    expect(shifts).toEqual([{ clipId: "t", newStartFrame: 100 }]);
  });

  // MARK: - computeRippleShiftsForRanges (merge + shift)

  it("overlappingRangesMergeBeforeShifting", () => {
    const c = clip({ id: "c", start: 300, duration: 100 });
    const shifts = computeRippleShiftsForRanges([c], [FrameRange(0, 100), FrameRange(50, 200)]);
    expect(shifts).toEqual([{ clipId: "c", newStartFrame: 100 }]);
  });

  it("touchingRangesMergeBeforeShifting", () => {
    const c = clip({ id: "c", start: 200, duration: 50 });
    const shifts = computeRippleShiftsForRanges([c], [FrameRange(0, 50), FrameRange(50, 100)]);
    expect(shifts).toEqual([{ clipId: "c", newStartFrame: 100 }]);
  });

  it("rangeWhollyBeforeClipShiftsClip_rangeAfterDoesNot", () => {
    const a = clip({ id: "a", start: 100, duration: 50 });
    const b = clip({ id: "b", start: 200, duration: 50 });
    const shifts = computeRippleShiftsForRanges([a, b], [FrameRange(0, 50), FrameRange(400, 500)]);
    expect(shifts).toEqual([
      { clipId: "a", newStartFrame: 50 },
      { clipId: "b", newStartFrame: 150 },
    ]);
  });

  it("rangeMustEndAtOrBeforeClipStartToShift", () => {
    const c = clip({ id: "c", start: 100, duration: 50 });
    expect(computeRippleShiftsForRanges([c], [FrameRange(0, 100)])).toEqual([{ clipId: "c", newStartFrame: 0 }]);
    expect(computeRippleShiftsForRanges([c], [FrameRange(0, 101)])).toEqual([]);
  });

  // MARK: - computeRipplePush (insert + push forward)

  it("pushMovesClipsAtOrAfterInsertFrame", () => {
    const a = clip({ id: "a", start: 0, duration: 50 });
    const b = clip({ id: "b", start: 100, duration: 50 });
    const c = clip({ id: "c", start: 200, duration: 50 });
    expect(computeRipplePush([a, b, c], 100, 30)).toEqual([
      { clipId: "b", newStartFrame: 130 },
      { clipId: "c", newStartFrame: 230 },
    ]);
  });

  it("pushSkipsExcludedIds", () => {
    const a = clip({ id: "a", start: 100, duration: 50 });
    const b = clip({ id: "b", start: 200, duration: 50 });
    expect(computeRipplePush([a, b], 0, 25, new Set(["a"]))).toEqual([{ clipId: "b", newStartFrame: 225 }]);
  });

  // MARK: - rippleMarkers

  it("closingDropsPointInsideRemovedRange", () => {
    const markers = [marker("before", "Before", 10), marker("inside", "Inside", 45), marker("join", "Join", 50), marker("after", "After", 80)];
    const next = rippleMarkersClosing(markers, [[FrameRange(40, 50)]]);
    expect(next.map((m) => m.id)).toEqual(["before", "join", "after"]);
    expect(next.map((m) => m.startFrame)).toEqual([10, 40, 70]);
  });

  it("closingShrinksOverlappingRangeAndDeletesConsumedRange", () => {
    const overlap = marker("overlap", "Overlap", 10, 40);
    const consumed = marker("consumed", "Consumed", 40, 10);
    const after = marker("after", "After", 60, 20);
    const next = rippleMarkersClosing([overlap, consumed, after], [[FrameRange(40, 50)]]);
    expect(next.map((m) => m.id)).toEqual(["overlap", "after"]);
    expect(next[0].startFrame).toBe(10);
    expect(next[0].durationFrames).toBe(30);
    expect(next[1].startFrame).toBe(50);
    expect(next[1].durationFrames).toBe(20);
  });

  it("openingShiftsAtOrAfterAndExtendsContainingRange", () => {
    const before = marker("before", "Before", 10);
    const containing = marker("range", "Range", 20, 40);
    const atInsert = marker("at", "At", 50);
    const next = rippleMarkersOpening([before, containing, atInsert], 50, 20);
    expect(next.map((m) => m.startFrame)).toEqual([10, 20, 70]);
    expect(next[1].durationFrames).toBe(60);
  });

  it("closingKeepsPointsThatStillExistOnAnotherTrack", () => {
    const onPicture = marker("onPicture", "On picture", 220);
    const after = marker("after", "After", 300);
    const next = rippleMarkersClosing([onPicture, after], [[FrameRange(0, 50)], [FrameRange(200, 250)]]);
    expect(next.map((m) => m.id)).toEqual(["onPicture", "after"]);
    expect(next.map((m) => m.startFrame)).toEqual([170, 250]);
  });

  it("closingIgnoresCollapsedMapsFromTracksThatRemovedThePoint", () => {
    const onPicture = marker("onPicture", "On picture", 220);
    const next = rippleMarkersClosing([onPicture], [[FrameRange(0, 50)], [FrameRange(100, 250)]]);
    expect(next.map((m) => m.startFrame)).toEqual([170]);
  });

  it("closingKeepsRangeThatAnotherTrackConsumed", () => {
    const span = marker("span", "Span", 300, 50);
    const next = rippleMarkersClosing([span], [[FrameRange(0, 50)], [FrameRange(200, 400)]]);
    expect(next.map((m) => m.id)).toEqual(["span"]);
    expect(next[0].startFrame).toBe(250);
    expect(next[0].durationFrames).toBe(50);
  });

  it("negativeOpeningClosesTheTrimmedTail", () => {
    const onTail = marker("tail", "Tail", 90);
    const after = marker("after", "After", 120);
    const next = rippleMarkersOpening([onTail, after], 100, -20);
    expect(next.map((m) => m.id)).toEqual(["after"]);
    expect(next[0].startFrame).toBe(100);
  });
});

describe("RippleEngine - adversarial", () => {
  it("shiftsPreserveStartFrameOrder", () => {
    const clips = [
      clip({ id: "a", start: 0, duration: 50 }),
      clip({ id: "b", start: 100, duration: 50 }),
      clip({ id: "c", start: 200, duration: 50 }),
      clip({ id: "d", start: 300, duration: 50 }),
    ];
    const shifts = computeRippleShifts(clips, new Set(["b", "c"]));
    const newStarts: [string, number][] = clips.filter((c) => !["b", "c"].includes(c.id)).map((c) => [c.id, c.startFrame]);
    for (const shift of shifts) {
      const idx = newStarts.findIndex((s) => s[0] === shift.clipId);
      if (idx >= 0) newStarts[idx] = [shift.clipId, shift.newStartFrame];
    }
    const aIdx = newStarts.findIndex((s) => s[0] === "a");
    const dIdx = newStarts.findIndex((s) => s[0] === "d");
    expect(aIdx).toBeLessThan(dIdx);
    const starts = newStarts.map((s) => s[1]);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });

  it("pushDoesNotMakeClipsCollide", () => {
    const clips = [clip({ id: "anchor", start: 0, duration: 50 }), clip({ id: "follower", start: 100, duration: 50 })];
    const shifts = computeRipplePush(clips, 100, 30);
    const followerNewStart = shifts.find((s) => s.clipId === "follower")?.newStartFrame;
    expect(followerNewStart).toBe(130);
    expect(50).toBeLessThanOrEqual(followerNewStart ?? -1);
  });
});
