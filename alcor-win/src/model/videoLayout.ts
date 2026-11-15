export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutSlot {
  id: string;
  rect: LayoutRect;
  z: number;
}

export const layoutFits = ["fill", "fit"] as const;
export type LayoutFit = (typeof layoutFits)[number];

export const videoLayouts = [
  "full", "side_by_side", "top_bottom",
  "pip_bottom_right", "pip_bottom_left", "pip_top_right", "pip_top_left",
  "grid_2x2", "grid_3x3", "grid_4x4",
  "main_sidebar", "three_up", "three_stack",
] as const;

/** Values are the Swift raw values (e.g. `sideBySide = "side_by_side"`). */
export type VideoLayout = (typeof videoLayouts)[number];

const displayNames: Record<VideoLayout, string> = {
  full: "Full Frame",
  side_by_side: "Side by Side",
  top_bottom: "Top / Bottom",
  pip_bottom_right: "PiP Bottom Right",
  pip_bottom_left: "PiP Bottom Left",
  pip_top_right: "PiP Top Right",
  pip_top_left: "PiP Top Left",
  grid_2x2: "Grid 2×2",
  grid_3x3: "Grid 3×3",
  grid_4x4: "Grid 4×4",
  main_sidebar: "Main + Sidebar",
  three_up: "Three-Up",
  three_stack: "Three-Stack",
};

export function videoLayoutDisplayName(layout: VideoLayout): string {
  return displayNames[layout];
}

const pipInset = 0.28;
const pipMargin = 0.035;

function slot(id: string, x: number, y: number, w: number, h: number, z = 0): LayoutSlot {
  return { id, rect: { x, y, w, h }, z };
}

function grid(rows: number, columns: number): LayoutSlot[] {
  const width = 1.0 / columns;
  const height = 1.0 / rows;
  const out: LayoutSlot[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      out.push(slot(`r${row + 1}c${column + 1}`, column * width, row * height, width, height));
    }
  }
  return out;
}

function pip(insetX: number, insetY: number): LayoutSlot[] {
  return [slot("main", 0, 0, 1, 1, 0), slot("inset", insetX, insetY, pipInset, pipInset, 1)];
}

export function videoLayoutSlots(layout: VideoLayout): LayoutSlot[] {
  switch (layout) {
    case "full":
      return [slot("main", 0, 0, 1, 1)];
    case "side_by_side":
      return [slot("left", 0, 0, 0.5, 1), slot("right", 0.5, 0, 0.5, 1)];
    case "top_bottom":
      return [slot("top", 0, 0, 1, 0.5), slot("bottom", 0, 0.5, 1, 0.5)];
    case "pip_bottom_right": return pip(1 - pipMargin - pipInset, 1 - pipMargin - pipInset);
    case "pip_bottom_left": return pip(pipMargin, 1 - pipMargin - pipInset);
    case "pip_top_right": return pip(1 - pipMargin - pipInset, pipMargin);
    case "pip_top_left": return pip(pipMargin, pipMargin);
    case "grid_2x2": return grid(2, 2);
    case "grid_3x3": return grid(3, 3);
    case "grid_4x4": return grid(4, 4);
    case "main_sidebar":
      return [slot("main", 0, 0, 0.7, 1), slot("sidebar", 0.7, 0, 0.3, 1)];
    case "three_up": {
      const third = 1.0 / 3.0;
      return [slot("left", 0, 0, third, 1), slot("center", third, 0, third, 1), slot("right", third * 2, 0, third, 1)];
    }
    case "three_stack": {
      const third = 1.0 / 3.0;
      return [slot("top", 0, 0, 1, third), slot("middle", 0, third, 1, third), slot("bottom", 0, third * 2, 1, third)];
    }
  }
}
