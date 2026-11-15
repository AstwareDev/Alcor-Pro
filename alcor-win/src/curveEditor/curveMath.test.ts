import { describe, expect, it } from "vitest";
import { clampHandles, curvePresets, fromPixel, interpolationForHandles, speedCurvePoints, toPixel, valueCurvePoints } from "./curveMath";

const box = { x: 10, y: 10, width: 200, height: 150 };

describe("curve editor math", () => {
  it("maps between plot pixels and curve space both ways", () => {
    for (const [x, y] of [[0, 0], [1, 1], [0.3, -0.2], [0.8, 1.4]] as const) {
      const p = toPixel(box, x, y);
      const back = fromPixel(box, p.x, p.y);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it("clamps x to 0..1 and y to an overshoot range", () => {
    expect(clampHandles([-1, -9, 2, 9])).toEqual([0, -2, 1, 3]);
  });

  it("stores matching curves as named easings and the rest as bezier", () => {
    expect(interpolationForHandles([0, 0, 1, 1])).toEqual({ interpolation: "linear" });
    expect(interpolationForHandles([0.42, 0, 0.58, 1])).toEqual({ interpolation: "easeInOut" });
    expect(interpolationForHandles([0, 0, 0.58, 1])).toEqual({ interpolation: "easeOut" });
    expect(interpolationForHandles([0.42, 0, 1, 1])).toEqual({ interpolation: "easeIn" });
    expect(interpolationForHandles([0.1, 0.2, 0.3, 0.4])).toEqual({ interpolation: "bezier", bezier: [0.1, 0.2, 0.3, 0.4] });
  });

  it("presets are valid handles and the curves have the expected sample counts", () => {
    for (const p of curvePresets) {
      expect(clampHandles(p.handles)).toEqual(p.handles);
      expect(valueCurvePoints(box, p.handles, 10).split(" ")).toHaveLength(11);
      expect(speedCurvePoints(box, p.handles, 10).split(" ")).toHaveLength(11);
    }
  });

  it("the value curve starts bottom-left and ends top-right", () => {
    const pts = valueCurvePoints(box, [0.42, 0, 0.58, 1], 4).split(" ");
    const a = toPixel(box, 0, 0);
    const b = toPixel(box, 1, 1);
    expect(pts[0]).toBe(`${a.x.toFixed(1)},${a.y.toFixed(1)}`);
    expect(pts[4]).toBe(`${b.x.toFixed(1)},${b.y.toFixed(1)}`);
  });
});
