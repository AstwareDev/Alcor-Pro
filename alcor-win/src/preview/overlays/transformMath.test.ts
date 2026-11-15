import { describe, expect, it } from "vitest";
import { makeTransform } from "../../model";
import { handleHitSize, rotateHandleOffset } from "./overlayMetrics";
import {
  angleStep,
  boxGeometry,
  movedTransform,
  pointerAngle,
  resizeCursor,
  resizedTransform,
  rotationFromDrag,
  textScaleFromDrag,
  toLocalDelta,
  transformHitAt,
} from "./transformMath";

const canvas = { width: 1000, height: 500 };
const none = { width: 0, height: 0 };

describe("Preview transform overlay", () => {
  it("rotatedMoveSnapsToBothCanvasAxes", () => {
    const start = makeTransform({ centerX: 0.496, centerY: 0.51, width: 0.4, height: 0.2, rotation: 37 });
    const result = movedTransform(start, none, canvas);
    expect(result.transform.centerX).toBe(0.5);
    expect(result.transform.centerY).toBe(0.5);
    expect(result.guides.x).toBe(true);
    expect(result.guides.y).toBe(true);
    expect(result.transform.rotation).toBe(37);
  });

  it("rotatedMoveReportsOnlyTheAlignedAxis", () => {
    const start = makeTransform({ centerX: 0.496, centerY: 0.7, rotation: 90 });
    const result = movedTransform(start, none, canvas);
    expect(result.transform.centerX).toBe(0.5);
    expect(result.transform.centerY).toBe(0.7);
    expect(result.guides.x).toBe(true);
    expect(result.guides.y).toBe(false);
  });

  it("tiltedMoveDoesNotSnapUnprojectedCanvasEdges", () => {
    const start = makeTransform({ centerX: 0.202, centerY: 0.7, width: 0.4, height: 0.2, rotationY: 30 });
    const result = movedTransform(start, none, canvas);
    expect(result.transform.centerX).toBe(0.202);
    expect(result.transform.rotationY).toBe(30);
    expect(result.guides.x).toBe(false);
    expect(result.guides.y).toBe(false);
  });
});

describe("movedTransform", () => {
  it("translatesByPixelsOverCanvasSize", () => {
    const start = makeTransform({ centerX: 0.3, centerY: 0.3, width: 0.2, height: 0.2 });
    const { transform } = movedTransform(start, { width: 100, height: 50 }, canvas);
    expect(transform.centerX).toBeCloseTo(0.4);
    expect(transform.centerY).toBeCloseTo(0.4);
  });

  it("snapsEdgesToCanvasWithinEightPixels", () => {
    const start = makeTransform({ centerX: 0.3, centerY: 0.5, width: 0.2, height: 0.2 });
    // Left edge lands at 0.2 - 0.195 = 0.005 (5px of 1000) -> snaps to 0.
    const near = movedTransform(start, { width: -195, height: 0 }, canvas).transform;
    expect(near.centerX - near.width / 2).toBeCloseTo(0, 12);
    // 12px away: no snap.
    const far = movedTransform(start, { width: -188, height: 0 }, canvas).transform;
    expect(far.centerX - far.width / 2).toBeCloseTo(0.012, 12);
  });

  it("snapsCentreToCanvasCentreWithGuides", () => {
    const start = makeTransform({ centerX: 0.3, centerY: 0.3, width: 0.2, height: 0.2 });
    const r = movedTransform(start, { width: 196, height: 40 }, canvas);
    expect(r.transform.centerX).toBe(0.5);
    expect(r.guides).toEqual({ x: true, y: false });
  });

  it("collapsedCanvasLeavesTransformUnchanged", () => {
    const start = makeTransform({ centerX: 0.3 });
    expect(movedTransform(start, { width: 10, height: 10 }, { width: 0, height: 0 }).transform).toEqual(start);
  });
});

describe("resizedTransform", () => {
  const start = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 });

  it("bottomRightGrowsFromTopLeftAnchor", () => {
    const r = resizedTransform(start, "bottomRight", { width: 100, height: 50 }, canvas, undefined, false);
    expect(r.width).toBeCloseTo(0.5);
    expect(r.height).toBeCloseTo(0.5);
    expect(r.centerX - r.width / 2).toBeCloseTo(0.3);
    expect(r.centerY - r.height / 2).toBeCloseTo(0.3);
  });

  it("topLeftKeepsBottomRightAnchor", () => {
    const r = resizedTransform(start, "topLeft", { width: -100, height: -50 }, canvas, undefined, false);
    expect(r.centerX + r.width / 2).toBeCloseTo(0.7);
    expect(r.centerY + r.height / 2).toBeCloseTo(0.7);
    expect(r.width).toBeCloseTo(0.5);
  });

  it("topRightAndBottomLeftMoveTheirOwnEdges", () => {
    const tr = resizedTransform(start, "topRight", { width: 100, height: -50 }, canvas, undefined, false);
    expect(tr.centerX - tr.width / 2).toBeCloseTo(0.3);
    expect(tr.centerY + tr.height / 2).toBeCloseTo(0.7);
    const bl = resizedTransform(start, "bottomLeft", { width: -100, height: 50 }, canvas, undefined, false);
    expect(bl.centerX + bl.width / 2).toBeCloseTo(0.7);
    expect(bl.centerY - bl.height / 2).toBeCloseTo(0.3);
  });

  it("neverInvertsBelowMinimumSize", () => {
    const r = resizedTransform(start, "bottomRight", { width: -900, height: -900 }, canvas, undefined, false);
    expect(r.width).toBeCloseTo(0.05);
    expect(r.height).toBeCloseTo(0.05);
    expect(r.centerX - r.width / 2).toBeCloseTo(0.3);
  });

  it("aspectLockDrivesHeightFromWidthWhenWidthLeads", () => {
    const aspect = 2;
    const s = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 });
    const r = resizedTransform(s, "bottomRight", { width: 100, height: 0 }, canvas, aspect, false);
    expect(r.width / r.height).toBeCloseTo(aspect);
    expect(r.width).toBeCloseTo(0.5);
  });

  it("aspectLockDrivesWidthFromHeightWhenHeightLeads", () => {
    const aspect = 2;
    const s = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 });
    const r = resizedTransform(s, "topLeft", { width: 0, height: -100 }, canvas, aspect, false);
    expect(r.width / r.height).toBeCloseTo(aspect);
    expect(r.centerX + r.width / 2).toBeCloseTo(0.7);
    expect(r.centerY + r.height / 2).toBeCloseTo(0.6);
  });

  it("snapsDraggedEdgeToCanvasBoundaryAndKeepsAspect", () => {
    const aspect = 2;
    const s = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 });
    // Right edge would land at 0.996 (4px from 1) -> snaps to 1, height follows from the aspect.
    const r = resizedTransform(s, "bottomRight", { width: 296, height: 0 }, canvas, aspect, false);
    expect(r.centerX + r.width / 2).toBeCloseTo(1);
    expect(r.width / r.height).toBeCloseTo(aspect);
  });

  it("doesNotSnapToCanvasEdgesWhenRotated", () => {
    const s = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4, rotation: 20 });
    const r = resizedTransform(s, "bottomRight", { width: 296, height: 0 }, canvas, undefined, true);
    expect(r.width).toBeCloseTo(0.4 + 0.296);
    expect(r.rotation).toBe(20);
  });

  it("rotatedResizeKeepsTheOppositeCornerFixedOnScreen", () => {
    const s = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4, rotation: 30 });
    const cornerPx = (t: typeof s, sx: number, sy: number) => {
      const lx = (sx * t.width * canvas.width) / 2, ly = (sy * t.height * canvas.height) / 2;
      const a = (t.rotation * Math.PI) / 180;
      return { x: t.centerX * canvas.width + lx * Math.cos(a) - ly * Math.sin(a), y: t.centerY * canvas.height + lx * Math.sin(a) + ly * Math.cos(a) };
    };
    const before = cornerPx(s, -1, -1);
    // Drag the bottom-right corner 80px along the clip's own x axis (screen delta rotated into clip axes).
    const a = (30 * Math.PI) / 180;
    const screen = { width: 80 * Math.cos(a), height: 80 * Math.sin(a) };
    const local = toLocalDelta(screen, 30);
    expect(local.width).toBeCloseTo(80);
    expect(local.height).toBeCloseTo(0);
    const r = resizedTransform(s, "bottomRight", local, canvas, undefined, true);
    const after = cornerPx(r, -1, -1);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(r.width).toBeCloseTo(0.4 + 0.08);
  });

  it("collapsedCanvasLeavesTransformUnchanged", () => {
    expect(resizedTransform(start, "topLeft", { width: 5, height: 5 }, { width: 0, height: 10 }, undefined, false)).toEqual(start);
  });
});

describe("textScaleFromDrag", () => {
  const t = makeTransform({ width: 0.4, height: 0.2 });

  it("growsWithTheDraggedCornerAndShrinksBack", () => {
    const grown = textScaleFromDrag({ width: 100, height: 50 }, "bottomRight", t, 1, canvas);
    expect(grown).toBeCloseTo(Math.sqrt((0.5 / 0.4) * (0.3 / 0.2)));
    expect(textScaleFromDrag({ width: -100, height: -50 }, "topLeft", t, 1, canvas)).toBeCloseTo(grown);
  });

  it("clampsToMinimumScale", () => {
    expect(textScaleFromDrag({ width: -900, height: -900 }, "bottomRight", t, 2, canvas)).toBe(0.05);
  });

  it("returnsStartScaleForDegenerateInput", () => {
    expect(textScaleFromDrag({ width: 10, height: 10 }, "bottomRight", makeTransform({ width: 0 }), 1.5, canvas)).toBe(1.5);
  });
});

describe("rotation drag", () => {
  it("pointerAngleIsClockwiseFromUp", () => {
    const c = { x: 100, y: 100 };
    expect(pointerAngle(c, { x: 100, y: 50 })).toBeCloseTo(0);
    expect(pointerAngle(c, { x: 150, y: 100 })).toBeCloseTo(90);
    expect(pointerAngle(c, { x: 100, y: 150 })).toBeCloseTo(180);
    expect(pointerAngle(c, { x: 50, y: 100 })).toBeCloseTo(-90);
  });

  it("angleStepFoldsAcrossTheSeam", () => {
    expect(angleStep(170, -170)).toBeCloseTo(20);
    expect(angleStep(-170, 170)).toBeCloseTo(-20);
    expect(angleStep(10, 30)).toBeCloseTo(20);
  });

  it("snapsNearAxesWithGuides", () => {
    expect(rotationFromDrag(87, false)).toEqual({ rotation: 90, guides: true });
    expect(rotationFromDrag(-3, false)).toEqual({ rotation: 0, guides: true });
  });

  it("leavesOtherAnglesExactAndHidesGuides", () => {
    expect(rotationFromDrag(44.5, false)).toEqual({ rotation: 44.5, guides: false });
  });

  it("shiftSteps15Degrees", () => {
    expect(rotationFromDrag(52, true)).toEqual({ rotation: 45, guides: false });
    expect(rotationFromDrag(83, true)).toEqual({ rotation: 90, guides: true });
  });
});

describe("handle hit zones", () => {
  const t = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 });
  const g = boxGeometry(t, canvas, false);

  it("cornersLandOnTheRect", () => {
    expect(g.corners.topLeft).toEqual({ x: 300, y: 150 });
    expect(g.corners.bottomRight).toEqual({ x: 700, y: 350 });
  });

  it("rotateHandleSitsAboveTheTopEdge", () => {
    expect(g.rotateHandle.x).toBeCloseTo(500);
    expect(g.rotateHandle.y).toBeCloseTo(150 - rotateHandleOffset);
  });

  it("rotateHandleFollowsRotation", () => {
    const r = boxGeometry(makeTransform({ ...t, rotation: 90 }), canvas, false);
    expect(r.rotateHandle.x).toBeCloseTo(500 + 100 + rotateHandleOffset);
    expect(r.rotateHandle.y).toBeCloseTo(250);
  });

  it("cornerHitZoneIsHandleHitSizeSquare", () => {
    const half = handleHitSize / 2;
    expect(transformHitAt({ x: 300 + half, y: 150 - half }, g)).toEqual({ kind: "resize", corner: "topLeft" });
    expect(transformHitAt({ x: 300 - half - 1, y: 150 }, g)).toBeNull();
    expect(transformHitAt({ x: 700, y: 350 }, g)).toEqual({ kind: "resize", corner: "bottomRight" });
    expect(transformHitAt({ x: 700, y: 150 }, g)).toEqual({ kind: "resize", corner: "topRight" });
    expect(transformHitAt({ x: 300, y: 350 }, g)).toEqual({ kind: "resize", corner: "bottomLeft" });
  });

  it("handlesBeatTheBodyAndBodyBeatsOutside", () => {
    expect(transformHitAt({ x: 500, y: 250 }, g)).toEqual({ kind: "move" });
    expect(transformHitAt({ x: 100, y: 100 }, g)).toBeNull();
    expect(transformHitAt({ x: g.rotateHandle.x, y: g.rotateHandle.y }, g)).toEqual({ kind: "rotate" });
  });

  it("rotatedBodyUsesTheRotatedQuad", () => {
    const wide = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.6, height: 0.1, rotation: 90 });
    const rg = boxGeometry(wide, canvas, false);
    // Unrotated it would cover x 200..800 at y 225..275; rotated 90 degrees it is tall instead.
    expect(transformHitAt({ x: 500, y: 130 }, rg)).toEqual({ kind: "move" });
    expect(transformHitAt({ x: 250, y: 250 }, rg)).toBeNull();
  });

  it("tiltedTextUsesTheProjectedQuad", () => {
    const tilt = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.6, height: 0.2, rotationY: 60 });
    const tg = boxGeometry(tilt, { width: 320, height: 180 }, true);
    expect(transformHitAt({ x: 160, y: 90 }, tg)).toEqual({ kind: "move" });
    expect(transformHitAt({ x: 90, y: 90 }, tg)).toBeNull();
  });
});

describe("resizeCursor", () => {
  it("followsCornerAndRotation", () => {
    expect(resizeCursor("topLeft", 0)).toBe("nwse-resize");
    expect(resizeCursor("bottomRight", 0)).toBe("nwse-resize");
    expect(resizeCursor("topRight", 0)).toBe("nesw-resize");
    expect(resizeCursor("topLeft", 45)).toBe("ns-resize");
    expect(resizeCursor("topLeft", 90)).toBe("nesw-resize");
    expect(resizeCursor("topLeft", -45)).toBe("ew-resize");
  });
});
