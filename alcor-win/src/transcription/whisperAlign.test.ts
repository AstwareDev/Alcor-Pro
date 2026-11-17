import { describe, expect, it } from "vitest";
import { dynamicTimeWarp, medianFilterRows, rowStartTimes, standardizeColumns, timedWords, whisperFrameSeconds } from "./whisperAlign";

describe("medianFilterRows", () => {
  it("removesASingleFrameSpikeAndKeepsAStep", () => {
    const m = Float32Array.from([0, 0, 9, 0, 0, 0, 1, 1, 1, 1]);
    medianFilterRows(m, 1, 10);
    expect([...m]).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]); // the step edge moves by less than the window
  });

  it("filtersEachRowIndependently", () => {
    const m = Float32Array.from([0, 9, 0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 5]);
    medianFilterRows(m, 2, 8);
    expect([...m.subarray(0, 8)].every((v) => v === 0)).toBe(true);
    expect([...m.subarray(8)].every((v) => v === 5)).toBe(true);
  });
});

describe("standardizeColumns", () => {
  it("givesEveryColumnZeroMeanAndUnitPopulationStd", () => {
    const m = Float32Array.from([1, 10, 3, 10, 5, 10]);
    standardizeColumns(m, 3, 2);
    expect((m[0] as number) + (m[2] as number) + (m[4] as number)).toBeCloseTo(0, 5);
    expect(Math.sqrt(((m[0] as number) ** 2 + (m[2] as number) ** 2 + (m[4] as number) ** 2) / 3)).toBeCloseTo(1, 5);
    expect([...m].every(Number.isFinite)).toBe(true); // the flat column does not divide by zero
  });
});

describe("dynamicTimeWarp", () => {
  it("followsTheCheapestMonotonicPath", () => {
    const cost = new Float32Array(18).fill(1);
    for (const [r, c] of [[0, 0], [0, 1], [1, 2], [1, 3], [2, 4], [2, 5]] as const) cost[r * 6 + c] = 0;
    const path = dynamicTimeWarp(cost, 3, 6);
    expect([...path.rows]).toEqual([0, 0, 1, 1, 2, 2]);
    expect([...path.cols]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("rowStartTimes", () => {
  it("recoversWhereEachTokenStartsFromABlockDiagonalAttention", () => {
    const rows = 4;
    const cols = 80;
    const head = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = r * 20; c < (r + 1) * 20; c++) head[r * cols + c] = 1;
    const starts = rowStartTimes([head, head.slice()], rows, cols);
    expect(starts).toHaveLength(rows);
    for (let r = 0; r < rows; r++) expect(Math.abs((starts[r] as number) - r * 20 * whisperFrameSeconds)).toBeLessThanOrEqual(3 * whisperFrameSeconds);
    for (let r = 1; r < rows; r++) expect(starts[r] as number).toBeGreaterThan(starts[r - 1] as number);
  });
});

describe("timedWords", () => {
  const starts = Float32Array.from([0, 0.2, 0.2, 0.6, 1.0, 5.0]);

  it("runsEachWordFromItsFirstRowToTheRowAfterItsLast", () => {
    const words = timedWords([{ text: "hel", from: 0, to: 1 }, { text: "lo", from: 1, to: 3 }, { text: "x", from: 3, to: 4 }], starts);
    expect(words.map((w) => w.text)).toEqual(["hel", "lo", "x"]);
    expect(words.map((w) => w.start)).toEqual([0, Math.fround(0.2), Math.fround(0.6)]);
    expect(words[1]?.end).toBeCloseTo(0.6, 5);
  });

  it("givesAWordThatTheAlignmentCrossedInOneJumpAFrameOfLength", () => {
    const [w] = timedWords([{ text: "a", from: 1, to: 2 }], starts);
    expect(w?.end).toBeCloseTo(0.2 + whisperFrameSeconds, 5);
  });

  it("trimsAnOverlongWordRightAfterASentenceEnd", () => {
    const starts = Float32Array.from([0, 0.4, 0.8, 1.2, 1.6, 10.6]);
    const words = timedWords(
      ["a", "b", "c", "end.", "Next"].map((text, i) => ({ text, from: i, to: i + 1 })),
      starts,
    );
    expect(words[4]?.end).toBeCloseTo(10.6, 4);
    expect(words[4]?.start).toBeCloseTo(10.6 - 0.8, 4); // twice the 0.4 s median, ending where it ended
  });

  it("leavesALongWordAloneWhenNoSentenceEndIsNearby", () => {
    const words = timedWords([{ text: "one", from: 0, to: 1 }, { text: "two", from: 1, to: 2 }], Float32Array.from([0, 0.4, 9.4]));
    expect(words[1]?.start).toBeCloseTo(0.4, 5);
    expect(words[1]?.end).toBeCloseTo(9.4, 5);
  });
});
