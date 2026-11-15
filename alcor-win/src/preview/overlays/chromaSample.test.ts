import { describe, expect, it } from "vitest";
import { keyHueFromRGB } from "./chromaSample";

describe("keyHueFromRGB", () => {
  it("returnsHsbHueFraction", () => {
    expect(keyHueFromRGB(1, 0, 0)).toBe(0);
    expect(keyHueFromRGB(0, 1, 0)).toBeCloseTo(1 / 3);
    expect(keyHueFromRGB(0, 0, 1)).toBeCloseTo(2 / 3);
    expect(keyHueFromRGB(1, 0, 0.5)).toBeCloseTo(11 / 12);
  });

  it("rejectsGreyAndNearGreySamples", () => {
    expect(keyHueFromRGB(0.5, 0.5, 0.5)).toBeUndefined();
    expect(keyHueFromRGB(0, 0, 0)).toBeUndefined();
    expect(keyHueFromRGB(1, 0.9, 0.9)).toBeUndefined();
    expect(keyHueFromRGB(1, 0.85, 0.85)).toBeDefined();
  });
});
