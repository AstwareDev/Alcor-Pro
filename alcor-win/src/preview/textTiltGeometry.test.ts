import { describe, expect, it } from "vitest";
import { makeTransform } from "../model/timeline";
import { textTiltCorners, textTiltCornersContains, textTiltCornersPoints } from "./textTiltGeometry";

const size = { width: 320, height: 180 };

describe("TextTiltGeometry", () => {
  it("oversizedTiltKeepsAValidProjectedQuad", () => {
    const center = { x: 160, y: 90 };
    const corners = textTiltCorners(
      { x: -1120, y: -270, width: 2560, height: 720 }, center,
      makeTransform({ width: 8, height: 4, rotationX: 75, rotationY: 89 }), size,
    );
    expect(textTiltCornersPoints(corners).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(textTiltCornersContains(corners, center)).toBe(true);
  });

  it("no tilt and no rotation is the identity", () => {
    const c = textTiltCorners({ x: 10, y: 20, width: 100, height: 50 }, { x: 160, y: 90 }, makeTransform(), size);
    expect(c.topLeft.x).toBeCloseTo(10, 9);
    expect(c.topLeft.y).toBeCloseTo(20, 9);
    expect(c.bottomRight.x).toBeCloseTo(110, 9);
    expect(c.bottomRight.y).toBeCloseTo(70, 9);
  });

  it("Y tilt foreshortens the far edge", () => {
    const c = textTiltCorners({ x: 60, y: 40, width: 200, height: 100 }, { x: 160, y: 90 }, makeTransform({ rotationY: 40 }), size);
    const left = c.bottomLeft.y - c.topLeft.y, right = c.bottomRight.y - c.topRight.y;
    expect(Math.abs(left - right)).toBeGreaterThan(1);
  });
});
