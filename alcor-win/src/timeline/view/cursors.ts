import type { TimelineCursor } from "./inputController";

// CSS equivalents of the NSCursors TimelineInputController sets, including its custom trim and slip glyphs
// (red bracket/ticks with a white-outlined arrow on a black halo, 24 px, hot spot centred).

const red = "%23E54F4F";

function svgCursor(body: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>${body}</svg>`;
  return `url("data:image/svg+xml;utf8,${svg}") 12 12`;
}

function trimGlyph(direction: 1 | -1): string {
  const mid = 12;
  const cap = mid + direction * 6;
  const tip = mid + direction * 10;
  const base = mid + direction * 4;
  const bracket = `M${mid} 20 L${mid} 4 M${mid} 4 L${cap} 4 M${mid} 20 L${cap} 20`;
  return (
    `<path d='${bracket}' stroke='black' stroke-width='3' fill='none' stroke-linecap='square'/>` +
    `<path d='${bracket}' stroke='${red}' stroke-width='2' fill='none' stroke-linecap='square'/>` +
    `<path d='M${tip} 12 L${base} 6 L${base} 18 Z' stroke='white' stroke-width='2' stroke-linejoin='round' fill='${red}'/>`
  );
}

const slipGlyph =
  `<path d='M2 4 L2 20 M22 4 L22 20' stroke='black' stroke-width='3' fill='none'/>` +
  `<path d='M2 4 L2 20 M22 4 L22 20' stroke='${red}' stroke-width='2' fill='none'/>` +
  `<path d='M6 12 L10 8 L10 16 Z M18 12 L14 8 L14 16 Z' stroke='white' stroke-width='2' stroke-linejoin='round' fill='${red}'/>`;

const trimLeft = `${svgCursor(trimGlyph(1))}, ew-resize`;
const trimRight = `${svgCursor(trimGlyph(-1))}, ew-resize`;
const slip = `${svgCursor(slipGlyph)}, ew-resize`;

export function cssCursor(cursor: TimelineCursor): string {
  switch (cursor) {
    case "trim-left": return trimLeft;
    case "trim-right": return trimRight;
    case "slip": return slip;
    default: return cursor;
  }
}
