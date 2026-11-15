// Canvas colours resolved from the CSS tokens (AppTheme), with alpha variants precomputed so draw paths never
// build colour strings per frame.

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CanvasPalette {
  surface: string;
  base: string;
  prominent: RGBA;
  borderPrimary: string;
  borderSubtle: string;
  divider: RGBA;
  textPrimary: RGBA;
  textSecondary: RGBA;
  textTertiary: string;
  textMuted: RGBA;
  timecode: RGBA;
  playhead: string;
  error: RGBA;
  clipBorder: string;
  clipBorderSelected: string;
  overlayBg: RGBA;
  overlayPrimary: RGBA;
  /** systemYellow / systemOrange / systemRed */
  yellow: RGBA;
  orange: RGBA;
  multicam: RGBA;
  fontUI: string;
  fontMono: string;
}

const probe = (): CanvasRenderingContext2D | null => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  return canvas.getContext("2d", { willReadFrequently: true });
};

/** Resolves any CSS colour (including `rgb(... / a)`) to components using the canvas parser. */
function parseColor(ctx: CanvasRenderingContext2D, value: string): RGBA {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = value.trim();
  const normalized = String(ctx.fillStyle);
  if (normalized.startsWith("#")) {
    const n = Number.parseInt(normalized.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = normalized.match(/rgba?\(([^)]+)\)/);
  if (!m?.[1]) return { r: 0, g: 0, b: 0, a: 1 };
  const parts = m[1].split(",").map((s) => Number.parseFloat(s));
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
}

const cssCache = new WeakMap<RGBA, Map<number, string>>();

/** Colour string with extra alpha; memoised per colour object so draw loops do not build strings. */
export function css(c: RGBA, alpha = 1): string {
  let byAlpha = cssCache.get(c);
  if (!byAlpha) {
    byAlpha = new Map();
    cssCache.set(c, byAlpha);
  }
  let s = byAlpha.get(alpha);
  if (s === undefined) {
    s = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a * alpha})`;
    byAlpha.set(alpha, s);
  }
  return s;
}

export function readCanvasPalette(root: Element = document.documentElement): CanvasPalette {
  const style = getComputedStyle(root);
  const ctx = probe();
  const get = (name: string): RGBA => (ctx ? parseColor(ctx, style.getPropertyValue(name)) : { r: 0, g: 0, b: 0, a: 1 });
  const str = (name: string): string => css(get(name));
  return {
    surface: str("--bg-surface"),
    base: str("--bg-base"),
    prominent: get("--bg-prominent"),
    borderPrimary: str("--border-primary"),
    borderSubtle: str("--border-subtle"),
    divider: get("--border-divider"),
    textPrimary: get("--text-primary"),
    textSecondary: get("--text-secondary"),
    textTertiary: str("--text-tertiary"),
    textMuted: get("--text-muted"),
    timecode: get("--accent-timecode"),
    playhead: str("--accent-playhead"),
    error: get("--status-error"),
    clipBorder: str("--border-clip"),
    clipBorderSelected: str("--border-clip-selected"),
    overlayBg: get("--overlay-bg"),
    overlayPrimary: get("--overlay-primary"),
    yellow: get("--status-pending"),
    orange: get("--status-warning"),
    multicam: get("--track-multicam"),
    fontUI: style.getPropertyValue("--font-ui").trim() || "sans-serif",
    fontMono: style.getPropertyValue("--font-mono").trim() || "monospace",
  };
}
