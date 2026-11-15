import { describe, expect, it } from "vitest";
import { formatContentRect, gridLinePositions, outsideRects, safeZoneInset, toggleGuide } from "./canvasGuides";

describe("canvas guides", () => {
  it("grid lines split the canvas evenly", () => {
    expect(gridLinePositions(3)).toEqual([1 / 3, 2 / 3]);
    expect(gridLinePositions(5)).toHaveLength(4);
  });

  it("safe zone insets", () => {
    expect(safeZoneInset("actionSafe")).toBe(0.035);
    expect(safeZoneInset("titleSafe")).toBe(0.05);
    expect(safeZoneInset("center")).toBeNull();
  });

  it("format rect pillarboxes a wider canvas and letterboxes a narrower one", () => {
    expect(formatContentRect(1, 200, 100)).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    expect(formatContentRect(2, 100, 100)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(formatContentRect(0, 100, 100).width).toBe(0);
  });

  it("outside rects drop empty bars", () => {
    expect(outsideRects({ x: 0, y: 25, width: 100, height: 50 }, 100, 100)).toEqual([
      { x: 0, y: 0, width: 100, height: 25 },
      { x: 0, y: 75, width: 100, height: 25 },
    ]);
  });

  it("toggleGuide keeps canonical order", () => {
    expect(toggleGuide(["center"], "actionSafe")).toEqual(["actionSafe", "center"]);
    expect(toggleGuide(["actionSafe", "center"], "actionSafe")).toEqual(["center"]);
  });
});
