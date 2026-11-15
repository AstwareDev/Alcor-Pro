import { describe, expect, it } from "vitest";
import {
  artHeight, computeGridLayout, gridDimensions, keysInRect, scrollTopToCenter, scrollTopToReveal, tileHeight,
  tileRect, visibleRowRange,
} from "./gridMath";
import type { PanelSection } from "./panelModel";

function section(count: number, over: Partial<PanelSection> = {}): PanelSection {
  return {
    key: "", title: null, collapsible: false, collapsed: false,
    items: Array.from({ length: count }, (_, i) => ({ key: `k${i}`, kind: "asset" as const, id: `k${i}` })),
    ...over,
  };
}

describe("gridDimensions", () => {
  it("fitsColumnsOfAtLeastThumbnailSize", () => {
    expect(gridDimensions(500, 80)).toEqual({ cols: 5, tileWidth: 88 });
    expect(gridDimensions(300, 110).cols).toBe(2);
  });
  it("neverReturnsFewerThanOneColumn", () => {
    const d = gridDimensions(40, 200);
    expect(d.cols).toBe(1);
    expect(d.tileWidth).toBe(200);
  });
  it("tileHeightAddsGapAndNameRow", () => expect(tileHeight(160)).toBe(artHeight(160) + 4 + 16));
});

describe("computeGridLayout", () => {
  it("wrapsItemsIntoRows", () => {
    const l = computeGridLayout([section(11)], 500, 80);
    expect(l.cols).toBe(5);
    expect(l.rows.map((r) => (r.kind === "tiles" ? r.keys.length : 0))).toEqual([5, 5, 1]);
    expect(l.position.get("k7")).toEqual({ row: 1, col: 2 });
    expect(l.totalHeight).toBe(3 * (tileHeight(l.tileWidth) + 10));
  });
  it("addsHeaderRowsAndSkipsCollapsedSections", () => {
    const l = computeGridLayout(
      [section(3, { title: "Library", collapsible: true }), section(3, { title: "A", collapsible: true, collapsed: true }), section(0, { title: "B", collapsible: true })],
      500, 80,
    );
    expect(l.rows.map((r) => r.kind)).toEqual(["header", "tiles", "header", "header", "empty"]);
  });
  it("emptyLayoutHasNoRows", () => expect(computeGridLayout([], 500, 80).totalHeight).toBe(0));
});

describe("visibleRowRange", () => {
  const layout = computeGridLayout([section(5000)], 500, 80);
  it("mountsOnlyRowsNearTheViewport", () => {
    const { start, end } = visibleRowRange(layout.rows, 0, 500, 200);
    expect(start).toBe(0);
    expect(end - start).toBeLessThan(12);
    expect(layout.rows.length).toBe(1000);
  });
  it("tracksScrollPosition", () => {
    const rowH = layout.rows[0].height;
    const { start, end } = visibleRowRange(layout.rows, rowH * 500, 400, 0);
    expect(start).toBe(500);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(505);
  });
  it("clampsPastTheEnd", () => {
    const { start, end } = visibleRowRange(layout.rows, 1e9, 500, 100);
    expect(start).toBe(layout.rows.length);
    expect(end).toBe(layout.rows.length);
  });
  it("emptyRows", () => expect(visibleRowRange([], 0, 100, 10)).toEqual({ start: 0, end: 0 }));
});

describe("marquee and scrolling", () => {
  const layout = computeGridLayout([section(12)], 500, 80);
  it("keysInRectReturnsTouchedTilesOnly", () => {
    const t0 = tileRect(layout, "k0");
    const t6 = tileRect(layout, "k6");
    expect(t0 && t6).toBeTruthy();
    const keys = keysInRect(layout, { x: 5, y: 0, width: 150, height: 20 });
    expect(keys).toEqual(["k0", "k1"]);
    expect(keysInRect(layout, { x: 0, y: 0, width: 1000, height: 1000 })).toHaveLength(12);
    expect(keysInRect(layout, { x: 0, y: 5000, width: 10, height: 10 })).toEqual([]);
  });
  it("scrollTopToRevealIsMinimal", () => {
    expect(scrollTopToReveal(layout, "k0", 0, 100)).toBeUndefined();
    const below = scrollTopToReveal(layout, "k11", 0, 100);
    expect(below).toBeGreaterThan(0);
    expect(scrollTopToReveal(layout, "missing", 0, 100)).toBeUndefined();
  });
  it("scrollTopToCenterClamps", () => {
    expect(scrollTopToCenter(layout, "k0", 100)).toBe(0);
    const last = scrollTopToCenter(layout, "k11", 100);
    expect(last).toBeLessThanOrEqual(layout.totalHeight - 100);
  });
});
