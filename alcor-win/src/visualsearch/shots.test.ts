import { describe, expect, it } from "vitest";
import { buildRows, candidateTimes, defaultSamplerOptions, lumaGrid, lumaMeanDiff, ShotSelector } from "./shots";

const flat = (luma: number): Float32Array => new Float32Array(64).fill(luma);

describe("candidateTimes", () => {
  it("samplesSliceMidpoints", () => {
    expect(candidateTimes(7)).toEqual([1, 3, 5]);
    expect(candidateTimes(1)).toEqual([0.5]);
    expect(candidateTimes(0)).toEqual([]);
  });

  it("widensTheIntervalOnLongFootage", () => {
    expect(candidateTimes(3600).length).toBeLessThanOrEqual(defaultSamplerOptions.maxCandidates);
  });
});

describe("luma", () => {
  it("weightsChannelsAndAveragesTheDifference", () => {
    const px = new Uint8ClampedArray(64 * 4).fill(255);
    expect(lumaGrid(px)[0]).toBeCloseTo(255);
    expect(lumaMeanDiff(flat(10), flat(30))).toBe(20);
  });
});

describe("ShotSelector", () => {
  it("startsAShotOnASceneChangeAndKeepsStaticFramesOnlyAtTheCoverageFloor", () => {
    const s = new ShotSelector();
    expect(s.consider(1, flat(10))).toEqual({ keep: true, isNewShot: true });
    expect(s.consider(3, flat(11))).toEqual({ keep: false, isNewShot: false });
    expect(s.consider(5, flat(12))).toEqual({ keep: false, isNewShot: false });
    expect(s.consider(9, flat(12))).toEqual({ keep: true, isNewShot: false });
    expect(s.consider(11, flat(80))).toEqual({ keep: true, isNewShot: true });
  });

  it("ignoresNonIncreasingTimestamps", () => {
    const s = new ShotSelector();
    s.consider(4, flat(0));
    expect(s.consider(4, flat(255)).keep).toBe(false);
    expect(s.consider(2, flat(255)).keep).toBe(false);
  });
});

describe("buildRows", () => {
  it("closesEachShotWhereTheNextStartsAndTheLastAtDuration", () => {
    const rows = buildRows(
      [{ time: 1, isNewShot: true }, { time: 9, isNewShot: false }, { time: 11, isNewShot: true }, { time: 15, isNewShot: true }],
      20,
    );
    expect(rows).toEqual([
      { time: 1, shotStart: 0, shotEnd: 11 },
      { time: 9, shotStart: 0, shotEnd: 11 },
      { time: 11, shotStart: 11, shotEnd: 15 },
      { time: 15, shotStart: 15, shotEnd: 20 },
    ]);
    expect(buildRows([], 5)).toEqual([]);
  });
});
