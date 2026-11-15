import { describe, expect, it } from "vitest";
import type { AssetIndex } from "./embeddingStore";
import { cosineSimilarity, l2Normalize, searchIndexes } from "./visualSearch";

function index(rows: { time: number; shotStart: number; shotEnd: number; v: number[] }[]): AssetIndex {
  const dim = rows[0]?.v.length ?? 2;
  return {
    header: { model: "m", modelVersion: 1, samplerVersion: 1, dim, count: rows.length },
    rows: rows.map(({ time, shotStart, shotEnd }) => ({ time, shotStart, shotEnd })),
    vectors: Float32Array.from(rows.flatMap((r) => r.v)),
  };
}

describe("cosineSimilarity", () => {
  it("isOneForParallelZeroForOrthogonalAndSafeForZero", () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBe(0);
    expect(cosineSimilarity([-1, 0], [1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("normalizesToUnitLength", () => {
    const n = l2Normalize(Float32Array.from([3, 4]));
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
    expect(Array.from(l2Normalize(new Float32Array(2)))).toEqual([0, 0]);
  });
});

describe("searchIndexes", () => {
  const query = Float32Array.from([1, 0]);

  it("keepsOnlyTheBestFramePerShotAndRanksAcrossAssets", () => {
    const a = index([
      { time: 1, shotStart: 0, shotEnd: 8, v: [0.5, 0.5] },
      { time: 5, shotStart: 0, shotEnd: 8, v: [0.9, 0.1] },
      { time: 10, shotStart: 8, shotEnd: 20, v: [0.3, 0.7] },
    ]);
    const b = index([{ time: 2, shotStart: 0, shotEnd: 4, v: [0.95, 0] }]);
    const hits = searchIndexes(query, [{ assetID: "a", index: a }, { assetID: "b", index: b }], { relativeCutoff: 0 });
    expect(hits.map((h) => [h.assetID, h.time, h.shotStart, h.shotEnd])).toEqual([
      ["b", 2, 0, 4],
      ["a", 5, 0, 8],
      ["a", 10, 8, 20],
    ]);
    expect(hits[0]?.score).toBeCloseTo(0.95);
  });

  it("dropsHitsBelowTheRelativeCutoffOfTheTopScore", () => {
    const a = index([
      { time: 0, shotStart: 0, shotEnd: 1, v: [1, 0] },
      { time: 2, shotStart: 2, shotEnd: 3, v: [0.9, 0] },
      { time: 4, shotStart: 4, shotEnd: 5, v: [0.8, 0] },
    ]);
    expect(searchIndexes(query, [{ assetID: "a", index: a }]).map((h) => h.time)).toEqual([0, 2]);
  });

  it("appliesMinScoreAndLimit", () => {
    const a = index([
      { time: 0, shotStart: 0, shotEnd: 1, v: [0.04, 0] },
      { time: 2, shotStart: 2, shotEnd: 3, v: [0.5, 0] },
      { time: 4, shotStart: 4, shotEnd: 5, v: [0.45, 0] },
    ]);
    const all = [{ assetID: "a", index: a }];
    expect(searchIndexes(query, all, { minScore: 0.05, relativeCutoff: 0 }).map((h) => h.time)).toEqual([2, 4]);
    expect(searchIndexes(query, all, { limit: 1, relativeCutoff: 0 })).toHaveLength(1);
  });

  it("returnsNothingWhenTheTopScoreIsNotPositiveOrDimsDiffer", () => {
    const neg = index([{ time: 0, shotStart: 0, shotEnd: 1, v: [-1, 0] }]);
    expect(searchIndexes(query, [{ assetID: "a", index: neg }])).toEqual([]);
    const wrong = index([{ time: 0, shotStart: 0, shotEnd: 1, v: [1, 0, 0] }]);
    expect(searchIndexes(query, [{ assetID: "a", index: wrong }])).toEqual([]);
    expect(searchIndexes(query, [])).toEqual([]);
  });
});
