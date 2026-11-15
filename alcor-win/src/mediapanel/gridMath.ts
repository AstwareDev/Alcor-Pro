// Layout and windowing maths of the media grid (MediaTab+Grids.gridDimensions) as pure functions.
import type { PanelSection } from "./panelModel";

/** AppTheme.Spacing.md: tile gap and the outer padding of the grid. */
export const gridSpacing = 10;
export const gridPadding = 10;
/** 9 px label with `padding(.vertical, xxs)`. */
export const nameRowHeight = 16;
/** Gap between thumbnail and name row (Spacing.xs). */
export const artNameGap = 4;
export const sectionHeaderHeight = 26;
export const sectionEmptyHeight = 22;
export const sectionGap = 6;

export interface GridDimensions {
  cols: number;
  tileWidth: number;
}

/** Fixed-size columns of at least `thumbnailSize`; leftover width is shared among the tiles. */
export function gridDimensions(width: number, thumbnailSize: number): GridDimensions {
  const usable = Math.max(0, width - gridPadding * 2);
  const cols = Math.max(1, Math.floor((usable + gridSpacing) / (thumbnailSize + gridSpacing)));
  const tileWidth = Math.max(thumbnailSize, (usable - (cols - 1) * gridSpacing) / cols);
  return { cols, tileWidth };
}

export function artHeight(tileWidth: number): number {
  return Math.round((tileWidth * 9) / 16);
}

export function tileHeight(tileWidth: number): number {
  return artHeight(tileWidth) + artNameGap + nameRowHeight;
}

export type LayoutRow =
  | { kind: "header"; section: number; top: number; height: number }
  | { kind: "empty"; section: number; top: number; height: number }
  | { kind: "tiles"; section: number; top: number; height: number; keys: string[] };

export interface GridLayout {
  rows: LayoutRow[];
  totalHeight: number;
  cols: number;
  tileWidth: number;
  /** key -> row index and column. */
  position: Map<string, { row: number; col: number }>;
}

/** Rows stack top to bottom; a tile row's height includes the gap below it. */
export function computeGridLayout(sections: readonly PanelSection[], width: number, thumbnailSize: number): GridLayout {
  const { cols, tileWidth } = gridDimensions(width, thumbnailSize);
  const rowHeight = tileHeight(tileWidth) + gridSpacing;
  const rows: LayoutRow[] = [];
  const position = new Map<string, { row: number; col: number }>();
  let top = 0;
  sections.forEach((section, s) => {
    if (section.title !== null) {
      if (s > 0) top += sectionGap;
      rows.push({ kind: "header", section: s, top, height: sectionHeaderHeight });
      top += sectionHeaderHeight;
    }
    if (section.collapsed) return;
    if (section.items.length === 0) {
      rows.push({ kind: "empty", section: s, top, height: sectionEmptyHeight });
      top += sectionEmptyHeight;
      return;
    }
    for (let i = 0; i < section.items.length; i += cols) {
      const keys = section.items.slice(i, i + cols).map((item) => item.key);
      keys.forEach((key, col) => {
        if (!position.has(key)) position.set(key, { row: rows.length, col });
      });
      rows.push({ kind: "tiles", section: s, top, height: rowHeight, keys });
      top += rowHeight;
    }
  });
  return { rows, totalHeight: top, cols, tileWidth, position };
}

/** Half-open range of rows intersecting the viewport (plus overscan on both sides). */
export function visibleRowRange(
  rows: readonly LayoutRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { start: number; end: number } {
  if (rows.length === 0) return { start: 0, end: 0 };
  const from = scrollTop - overscan;
  const to = scrollTop + viewportHeight + overscan;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height <= from) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  let end = start;
  while (end < rows.length && rows[end].top < to) end += 1;
  return { start, end };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tile rectangle (thumbnail and name) in scroll-content coordinates. */
export function tileRect(layout: GridLayout, key: string): Rect | undefined {
  const pos = layout.position.get(key);
  if (!pos) return undefined;
  const row = layout.rows[pos.row];
  return {
    x: gridPadding + pos.col * (layout.tileWidth + gridSpacing),
    y: row.top,
    width: layout.tileWidth,
    height: tileHeight(layout.tileWidth),
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Keys of the tiles a marquee rectangle touches; only rows in the vertical range are visited. */
export function keysInRect(layout: GridLayout, rect: Rect): string[] {
  const { start, end } = visibleRowRange(layout.rows, rect.y, rect.height, 0);
  const out: string[] = [];
  for (let r = start; r < end; r++) {
    const row = layout.rows[r];
    if (row.kind !== "tiles") continue;
    for (const key of row.keys) {
      const tile = tileRect(layout, key);
      if (tile && intersects(rect, tile)) out.push(key);
    }
  }
  return out;
}

/** Scroll offset that centres the key's row, clamped; undefined when the key is not laid out. */
export function scrollTopToCenter(layout: GridLayout, key: string, viewportHeight: number): number | undefined {
  const rect = tileRect(layout, key);
  if (!rect) return undefined;
  const max = Math.max(0, layout.totalHeight - viewportHeight);
  return Math.min(max, Math.max(0, rect.y + rect.height / 2 - viewportHeight / 2));
}

/** Minimal scroll that brings the key's tile fully into view (keyboard navigation); undefined if already visible. */
export function scrollTopToReveal(layout: GridLayout, key: string, scrollTop: number, viewportHeight: number): number | undefined {
  const rect = tileRect(layout, key);
  if (!rect) return undefined;
  if (rect.y < scrollTop) return Math.max(0, rect.y - gridSpacing);
  if (rect.y + rect.height > scrollTop + viewportHeight) {
    return Math.min(Math.max(0, layout.totalHeight - viewportHeight), rect.y + rect.height - viewportHeight + gridSpacing);
  }
  return undefined;
}
