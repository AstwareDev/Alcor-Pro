import { describe, expect, it } from "vitest";
import {
  defaultSilenceRemovalSettings, makeSilenceRemovalSettings, removableMask, visibleRemovableRanges, type SilenceRemovalSettings,
} from "./silenceRemovalSettings";

function settings(minimumPause: number, padding: number): SilenceRemovalSettings {
  const s = makeSilenceRemovalSettings(minimumPause, padding);
  if (!s) throw new Error("invalid settings");
  return s;
}
const range = (lowerBound: number, upperBound: number) => ({ lowerBound, upperBound });
const trues = (n: number): boolean[] => new Array<boolean>(n).fill(true);

describe("Silence removal planner", () => {
  it("filtersPausesShorterThanMinimum", () => {
    const mask = removableMask([false, true, true, true, true, false], settings(0.5, 0), 0.1);
    expect(mask).not.toContain(true);
  });

  it("padsBothSpeechBoundaries", () => {
    const mask = removableMask([false, ...trues(10), false], settings(0.5, 0.2), 0.1);
    expect(mask).toEqual([false, false, false, ...trues(6), false, false, false]);
  });

  it("doesNotPadSourceEdges", () => {
    const mask = removableMask([...trues(5), false, ...trues(5)], settings(0.3, 0.2), 0.1);
    expect(mask).toEqual([true, true, true, false, false, false, false, false, true, true, true]);
  });

  it("removesPaddingAtTrimmedClipEdgesOnly", () => {
    const s = settings(0.5, 0.2);
    const mask = [false, false, true, true, true, true, false, false];
    expect(visibleRemovableRanges(mask, range(0, 9), 10, s, 0.1)).toEqual([range(0, 6)]);
    expect(visibleRemovableRanges(mask, range(-1, 8), 10, s, 0.1)).toEqual([range(2, 8)]);
    expect(visibleRemovableRanges(mask, range(-1, 9), 10, s, 0.1)).toEqual([range(2, 6)]);
    expect(visibleRemovableRanges(mask, range(0, 1), 10, s, 0.1)).toEqual([range(0, 1)]);
    expect(visibleRemovableRanges(mask, range(7, 8), 10, s, 0.1)).toEqual([range(7, 8)]);
  });

  it("rejectsInvalidSettings", () => {
    expect(makeSilenceRemovalSettings(Number.NaN, 0.15)).toBeUndefined();
    expect(makeSilenceRemovalSettings(0.1, 0.15)).toBeUndefined();
    expect(makeSilenceRemovalSettings(0.5, 0.75)).toBeUndefined();
  });

  it("extremeCellResolutionDoesNotOverflow", () => {
    expect(removableMask([true, true], defaultSilenceRemovalSettings, Number.MIN_VALUE)).toEqual([false, false]);
  });

  it("rejectsNonFiniteVisibleSourceBounds", () => {
    expect(visibleRemovableRanges([true], range(0, Number.POSITIVE_INFINITY), 30, defaultSilenceRemovalSettings)).toEqual([]);
  });
});
