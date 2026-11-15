import { describe, expect, it } from "vitest";
import { fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { collectTargets, findSnap, makeSnapState, type SnapTarget } from "./snapEngine";

// baseThreshold=8 pixels, pixelsPerFrame=4 -> 2-frame base threshold.
const basePx = 8;
const pxPerFrame = 4;
const edge = (frame: number): SnapTarget => ({ frame, kind: "clipEdge" });

describe("SnapEngine", () => {
  // MARK: - collectTargets

  it("collectTargetsEmptyTracksProducesNoTargets", () => {
    expect(collectTargets({ tracks: [], includePlayhead: false })).toEqual([]);
  });

  it("collectTargetsIncludesMarkerFrames", () => {
    const targets = collectTargets({ tracks: [], markerFrames: [12, 30] });
    expect(targets.map((t) => t.frame)).toEqual([12, 30]);
    expect(targets.every((t) => t.kind === "marker")).toBe(true);
  });

  it("collectTargetsIncludesPlayheadOnlyWhenRequested", () => {
    const withPlayhead = collectTargets({ tracks: [], playheadFrame: 75, includePlayhead: true });
    expect(withPlayhead.length).toBe(1);
    expect(withPlayhead[0]?.frame).toBe(75);
    expect(withPlayhead[0]?.kind).toBe("playhead");

    const without = collectTargets({ tracks: [], playheadFrame: 75, includePlayhead: false });
    expect(without).toEqual([]);
  });

  it("collectTargetsProducesStartAndEndForEachClip", () => {
    const track = fixtureVideoTrack({
      clips: [fixtureClip({ id: "a", start: 0, duration: 50 }), fixtureClip({ id: "b", start: 100, duration: 80 })],
    });
    const targets = collectTargets({ tracks: [track] });
    expect(targets.map((t) => t.frame).sort((a, b) => a - b)).toEqual([0, 50, 100, 180]);
    expect(targets.every((t) => t.kind === "clipEdge")).toBe(true);
  });

  it("collectTargetsSkipsExcludedClipIds", () => {
    const track = fixtureVideoTrack({
      clips: [fixtureClip({ id: "drag", start: 0, duration: 50 }), fixtureClip({ id: "static", start: 100, duration: 80 })],
    });
    const targets = collectTargets({ tracks: [track], excludeClipIds: new Set(["drag"]) });
    expect(targets.map((t) => t.frame).sort((a, b) => a - b)).toEqual([100, 180]);
  });

  // MARK: - findSnap (basic threshold)

  it("findSnapReturnsNilWhenNoTargets", () => {
    const state = makeSnapState();
    const result = findSnap({ position: 100, targets: [], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result).toBeNull();
    expect(state.currentlySnappedTo).toBeUndefined();
  });

  it("findSnapReturnsNilWhenBeyondThreshold", () => {
    const state = makeSnapState();
    const result = findSnap({ position: 55, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result).toBeNull();
    expect(state.currentlySnappedTo).toBeUndefined();
  });

  it("findSnapSnapsWithinThreshold", () => {
    const state = makeSnapState();
    const result = findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result?.frame).toBe(50);
    expect(result?.probeOffset).toBe(0);
    expect(result?.x).toBe(200);
    expect(state.currentlySnappedTo).toBe(50);
  });

  it("findSnapPicksClosestOfMultipleTargets", () => {
    const state = makeSnapState();
    // Equal distance: first wins (strict <).
    const result = findSnap({ position: 50, targets: [edge(49), edge(51)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result?.frame).toBe(49);
  });

  // MARK: - findSnap (sticky behavior)

  it("findSnapStaysStickyWithinHoldThreshold", () => {
    const targets = [edge(50)];
    const state = makeSnapState();
    findSnap({ position: 49, targets, state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(state.currentlySnappedTo).toBe(50);

    // Hold threshold = 2 * 1.5 = 3 frames; pos=53 is exactly at the boundary, still stuck.
    const stuck = findSnap({ position: 53, targets, state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(stuck?.frame).toBe(50);
    expect(state.currentlySnappedTo).toBe(50);
  });

  it("findSnapReleasesStickyBeyondHoldThreshold", () => {
    const targets = [edge(50)];
    const state = makeSnapState();
    findSnap({ position: 49, targets, state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });

    const result = findSnap({ position: 54, targets, state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result).toBeNull();
    expect(state.currentlySnappedTo).toBeUndefined();
  });

  it("findSnapReleasesWhenStickyTargetDisappears", () => {
    const state = makeSnapState();
    findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(state.currentlySnappedTo).toBe(50);

    const result = findSnap({ position: 50, targets: [edge(200)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(result).toBeNull();
    expect(state.currentlySnappedTo).toBeUndefined();
  });

  // MARK: - findSnap (playhead multiplier)

  it("playheadHasWiderThreshold", () => {
    const state = makeSnapState();
    const result = findSnap({
      position: 103,
      targets: [{ frame: 100, kind: "playhead" }],
      state,
      baseThreshold: basePx,
      pixelsPerFrame: pxPerFrame,
    });
    expect(result?.frame).toBe(100);
  });

  it("playheadStillFailsOutsideItsWiderThreshold", () => {
    const state = makeSnapState();
    const result = findSnap({
      position: 104,
      targets: [{ frame: 100, kind: "playhead" }],
      state,
      baseThreshold: basePx,
      pixelsPerFrame: pxPerFrame,
    });
    expect(result).toBeNull();
  });

  // MARK: - findSnap (multiple probe offsets)

  it("multipleProbesPicksClosestProbeTargetPair", () => {
    const state = makeSnapState();
    const result = findSnap({
      position: 70,
      probeOffsets: [0, 30],
      targets: [edge(50), edge(100)],
      state,
      baseThreshold: basePx,
      pixelsPerFrame: pxPerFrame,
    });
    expect(result?.frame).toBe(100);
    expect(result?.probeOffset).toBe(30);
    expect(state.currentProbeOffset).toBe(30);
  });
});

describe("SnapEngine - adversarial", () => {
  it("doesNotLeaveStateBehindWhenNoTargetMatches", () => {
    const state = makeSnapState();
    const r = findSnap({ position: 50, targets: [edge(1000)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(r).toBeNull();
    expect(state.currentlySnappedTo).toBeUndefined();
    expect(state.currentProbeOffset).toBe(0);
  });

  it("zeroPixelsPerFrameDoesNotCrash", () => {
    const state = makeSnapState();
    findSnap({ position: 1_000_000, targets: [edge(50)], state, baseThreshold: 8, pixelsPerFrame: 0 });
  });

  it("emptyProbeOffsetsProducesNoSnap", () => {
    const state = makeSnapState();
    const r = findSnap({ position: 50, probeOffsets: [], targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame });
    expect(r).toBeNull();
  });
});
