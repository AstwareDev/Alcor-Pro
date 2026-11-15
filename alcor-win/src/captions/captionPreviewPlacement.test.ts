import { describe, expect, it } from "vitest";
import { movedCenter, viewOffset } from "./captionPreviewPlacement";

describe("Caption preview placement", () => {
  it("dragTranslationUsesNormalizedCanvasCoordinatesAndSnapsToCenter", () => {
    const center = movedCenter({ x: 0.4, y: 0.6 }, { width: 20, height: -20 }, { width: 200, height: 200 });
    expect(center).toEqual({ x: 0.5, y: 0.5 });
  });

  it("dragTranslationAllowsOffCanvasPlacement", () => {
    const center = movedCenter({ x: 0.9, y: 0.1 }, { width: 50, height: -50 }, { width: 100, height: 100 });
    expect(Math.abs(center.x - 1.4)).toBeLessThan(0.000001);
    expect(Math.abs(center.y + 0.4)).toBeLessThan(0.000001);
  });

  it("invalidCanvasSizeLeavesCenterUnchanged", () => {
    const start = { x: 0.3, y: 0.7 };
    expect(movedCenter(start, { width: 20, height: 20 }, { width: 0, height: 0 })).toEqual(start);
  });

  it("viewOffsetMovesCenteredRasterToPreviewPosition", () => {
    const offset = viewOffset({ x: 1.4, y: -0.4 }, { width: 200, height: 200 });
    expect(Math.abs(offset.width - 180)).toBeLessThan(0.000001);
    expect(Math.abs(offset.height + 180)).toBeLessThan(0.000001);
  });
});
