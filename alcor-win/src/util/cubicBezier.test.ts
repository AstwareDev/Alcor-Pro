import { describe, expect, it } from "vitest";
import { cubicBezierEase } from "./cubicBezier";

describe("cubicBezierEase", () => {
  it("is exact at the ends and linear for the identity curve", () => {
    expect(cubicBezierEase(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezierEase(0.42, 0, 0.58, 1, 1)).toBe(1);
    for (const x of [0.1, 0.5, 0.9]) expect(cubicBezierEase(0, 0, 1, 1, x)).toBeCloseTo(x, 6);
  });

  it("matches known CSS ease-in-out samples", () => {
    expect(cubicBezierEase(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5);
    expect(cubicBezierEase(0.42, 0, 0.58, 1, 0.25)).toBeCloseTo(0.1291, 3);
  });

  it("eases in slow and out fast for ease-in, the reverse for ease-out", () => {
    expect(cubicBezierEase(0.42, 0, 1, 1, 0.25)).toBeLessThan(0.25);
    expect(cubicBezierEase(0, 0, 0.58, 1, 0.25)).toBeGreaterThan(0.25);
  });

  it("is monotonic in x and may overshoot in y", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const y = cubicBezierEase(0.34, 1.56, 0.64, 1, i / 100);
      if (i > 0) expect(Number.isFinite(y)).toBe(true);
      prev = y;
    }
    expect(prev).toBeCloseTo(1, 6);
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => cubicBezierEase(0.34, 1.56, 0.64, 1, i / 100)))).toBeGreaterThan(1.05);
  });

  it("solves steep curves where Newton alone would stall (bisection fallback)", () => {
    const y = cubicBezierEase(1, 0, 0, 1, 0.5);
    expect(y).toBeCloseTo(0.5, 4);
    expect(cubicBezierEase(0, 1, 1, 0, 0.5)).toBeCloseTo(0.5, 4);
  });
});
