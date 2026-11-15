import { describe, expect, it } from "vitest";
import { cropMinimumVisibleFraction, makeCrop } from "../../model";
import { cropHitAt, cropRectLocal, pannedCrop, resizedCrop, toClipLocal } from "./cropMath";

const clip = { width: 400, height: 200 };

describe("Crop overlay math", () => {
  it("pansWithoutResizingTheWindow", () => {
    const start = makeCrop({ left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 });
    const c = pannedCrop(start, { width: 40, height: 20 }, clip);
    expect(c.left).toBeCloseTo(0.2);
    expect(c.right).toBeCloseTo(0.2);
    expect(c.top).toBeCloseTo(0.2);
    expect(c.bottom).toBeCloseTo(0.2);
  });

  it("panStopsAtTheSourceEdges", () => {
    const start = makeCrop({ left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 });
    const c = pannedCrop(start, { width: 4000, height: -4000 }, clip);
    expect(c.right).toBeCloseTo(0);
    expect(c.left).toBeCloseTo(0.4);
    expect(c.top).toBe(0);
    expect(c.bottom).toBeCloseTo(0.4);
  });

  it("freeResizeMovesOnlyTheDraggedEdges", () => {
    const start = makeCrop({ left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 });
    const tl = resizedCrop(start, "topLeft", { width: 40, height: 20 }, clip, undefined);
    expect(tl).toEqual(makeCrop({ left: 0.2, top: 0.2, right: 0.1, bottom: 0.1 }));
    const br = resizedCrop(start, "bottomRight", { width: 40, height: 20 }, clip, undefined);
    expect(br.right).toBeCloseTo(0);
    expect(br.bottom).toBeCloseTo(0);
    expect(br.left).toBe(0.1);
    const tr = resizedCrop(start, "topRight", { width: -40, height: 20 }, clip, undefined);
    expect(tr.right).toBeCloseTo(0.2);
    expect(tr.top).toBeCloseTo(0.2);
    const bl = resizedCrop(start, "bottomLeft", { width: -40, height: -20 }, clip, undefined);
    expect(bl.left).toBeCloseTo(0);
    expect(bl.bottom).toBeCloseTo(0.2);
  });

  it("freeResizeKeepsTheMinimumVisibleFraction", () => {
    const c = resizedCrop(makeCrop(), "topLeft", { width: 4000, height: 4000 }, clip, undefined);
    expect(1 - c.left - c.right).toBeCloseTo(cropMinimumVisibleFraction);
    expect(1 - c.top - c.bottom).toBeCloseTo(cropMinimumVisibleFraction);
    const out = resizedCrop(makeCrop(), "bottomRight", { width: 4000, height: 4000 }, clip, undefined);
    expect(out).toEqual(makeCrop());
  });

  it("lockedResizeKeepsTheAspect", () => {
    const aspectN = 1;
    const start = makeCrop();
    const c = resizedCrop(start, "bottomRight", { width: -80, height: 0 }, clip, aspectN);
    const visW = 1 - c.left - c.right;
    const visH = 1 - c.top - c.bottom;
    expect(visW / visH).toBeCloseTo(aspectN);
    expect(visW).toBeCloseTo(0.8);
    expect(c.left).toBe(0);
    expect(c.top).toBe(0);
  });

  it("lockedResizeIsClampedToTheSource", () => {
    const start = makeCrop({ left: 0.2, top: 0, right: 0, bottom: 0 });
    const c = resizedCrop(start, "bottomRight", { width: 4000, height: 4000 }, clip, 1);
    expect(c.right).toBeGreaterThanOrEqual(0);
    expect(c.bottom).toBeGreaterThanOrEqual(0);
    expect(1 - c.left - c.right).toBeCloseTo(1 - c.top - c.bottom);
  });

  it("collapsedClipLeavesCropUnchanged", () => {
    const start = makeCrop({ left: 0.1 });
    expect(pannedCrop(start, { width: 5, height: 5 }, { width: 0, height: 10 })).toEqual(start);
    expect(resizedCrop(start, "topLeft", { width: 5, height: 5 }, { width: 0, height: 10 }, undefined)).toEqual(start);
  });
});

describe("Crop overlay hit zones", () => {
  const crop = cropRectLocal(makeCrop({ left: 0.25, top: 0.25, right: 0.25, bottom: 0.25 }), clip);

  it("cropRectIsInsideTheClipRect", () => {
    expect(crop).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });

  it("cornersBeatPanAndPanBeatsOutside", () => {
    expect(cropHitAt({ x: 100, y: 50 }, crop)).toEqual({ kind: "resize", corner: "topLeft" });
    expect(cropHitAt({ x: 300, y: 150 }, crop)).toEqual({ kind: "resize", corner: "bottomRight" });
    expect(cropHitAt({ x: 200, y: 100 }, crop)).toEqual({ kind: "pan" });
    expect(cropHitAt({ x: 20, y: 20 }, crop)).toBeNull();
  });

  it("mapsRotatedPointsIntoClipLocalSpace", () => {
    const rect = { x: 300, y: 150, width: 400, height: 200 };
    // Clip centre is (500, 250); rotated 90 degrees clockwise, local +x points down the screen.
    const p = toClipLocal({ x: 500, y: 350 }, rect, 90);
    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(100);
  });
});
