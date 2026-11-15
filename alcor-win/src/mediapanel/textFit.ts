// Middle truncation ("juicym…347c_2") that CSS cannot do; width is measured by an injected function.

const ellipsis = "…";

/** Longest `head…tail` form of `text` that fits `maxWidth`; the original text if it already fits. */
export function truncateMiddle(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (text === "" || measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(shorten(chars, mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return shorten(chars, lo);
}

function shorten(chars: readonly string[], keep: number): string {
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return chars.slice(0, head).join("") + ellipsis + (tail > 0 ? chars.slice(chars.length - tail).join("") : "");
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of `text` in CSS px for a CSS font shorthand; falls back to a 0.55em average outside a browser. */
export function measureText(text: string, font: string, fontSizePx: number): number {
  if (measureContext === undefined) {
    measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return text.length * fontSizePx * 0.55;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
