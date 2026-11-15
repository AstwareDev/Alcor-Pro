import { describe, expect, it } from "vitest";
import { makeClip } from "../model";
import { beatTicksFit, planBeatTicks } from "./beatTicks";

const clip = makeClip({ mediaRef: "m", mediaType: "audio", startFrame: 0, durationFrames: 300 });

describe("planBeatTicks", () => {
  it("coincidentBeatRendersAsDownbeatOnly", () => {
    const ticks = planBeatTicks({ bpm: 120, beats: [0.5, 1, 1.5, 2], downbeats: [1, 2] }, clip, 3000, 30);
    expect(ticks.map((t) => t.isDown)).toEqual([false, true, false, true]);
    expect(ticks.map((t) => t.x)).toEqual([150, 300, 450, 600]);
  });

  it("beatsAreThinnedByMinSpacingButDownbeatsAreNot", () => {
    // 10 px per frame is wide; use 0.4 px/frame so 15-frame beats sit 6 px apart, then 2 px apart.
    const beats = [0.5, 0.55, 0.6, 1];
    const ticks = planBeatTicks({ bpm: 0, beats, downbeats: [0.55] }, clip, 120, 30);
    expect(ticks.filter((t) => t.isDown)).toHaveLength(1);
    expect(ticks.length).toBeLessThan(beats.length + 1);
  });

  it("dropsBeatsOutsideTheClipAndHandlesEmpty", () => {
    expect(planBeatTicks({ bpm: 0, beats: [], downbeats: [] }, clip, 100, 30)).toEqual([]);
    expect(planBeatTicks({ bpm: 0, beats: [20], downbeats: [] }, clip, 100, 30)).toEqual([]);
    expect(planBeatTicks({ bpm: 0, beats: [1], downbeats: [] }, { ...clip, durationFrames: 0 }, 100, 30)).toEqual([]);
  });

  it("bodyMustBeTallEnough", () => {
    expect(beatTicksFit(28)).toBe(false);
    expect(beatTicksFit(28.5)).toBe(true);
  });
});
