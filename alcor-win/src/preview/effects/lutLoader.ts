/** Parsed 3D .cube LUT: `data` is RGBA float32, r fastest then g then b (index ((b*n+g)*n+r)*4), values normalised to 0…1, alpha 1. */
export interface CubeLUT {
  dimension: number;
  data: Float32Array;
}

const swiftIntRe = /^[+-]?\d+$/;
const swiftFloatRe = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Swift `Float(String)` (decimal, inf, nan) or undefined. */
function parseFloat32(s: string): number | undefined {
  if (swiftFloatRe.test(s)) return Math.fround(Number(s));
  const lower = s.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(lower)) return NaN;
  return undefined;
}

function compactFloats(parts: string[]): number[] {
  const out: number[] = [];
  for (const p of parts) {
    const f = parseFloat32(p);
    if (f !== undefined) out.push(f);
  }
  return out;
}

const newlineCodes = new Set([10, 11, 12, 13, 0x85, 0x2028, 0x2029]);

/** Swift `split(whereSeparator: .isNewline)` (empty subsequences omitted). */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || newlineCodes.has(text.charCodeAt(i))) {
      if (i > start) out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

/** `LUTLoader.parse` (file loading/caching/storage is the caller's job). */
export function parseCubeLUT(text: string): CubeLUT | undefined {
  let dimension = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];

  for (const rawLine of splitLines(text)) {
    const line = rawLine.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(" ").filter((p) => p !== "");
    const first = parts[0];
    if (first === undefined) continue;
    switch (first.toUpperCase()) {
      case "TITLE":
        break;
      case "LUT_1D_SIZE":
        return undefined;
      case "LUT_3D_SIZE": {
        const last = parts[parts.length - 1] as string;
        dimension = swiftIntRe.test(last) ? Number.parseInt(last, 10) : 0;
        break;
      }
      case "DOMAIN_MIN":
        domainMin = compactFloats(parts.slice(1));
        break;
      case "DOMAIN_MAX":
        domainMax = compactFloats(parts.slice(1));
        break;
      default: {
        if (parts.length < 3) continue;
        const rgb = compactFloats(parts.slice(0, 3));
        if (rgb.length !== 3) return undefined;
        values.push(...rgb);
      }
    }
  }

  if (!(dimension > 1 && dimension <= 128) || values.length !== dimension * dimension * dimension * 3 ||
      domainMin.length !== 3 || domainMax.length !== 3) return undefined;

  const count = values.length / 3;
  const rgba = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const lo = domainMin[c] as number;
      const span = Math.max(0.0001, Math.fround((domainMax[c] as number) - lo));
      const v = Math.fround(Math.fround((values[i * 3 + c] as number) - lo) / span);
      rgba[i * 4 + c] = Math.min(1, Math.max(0, v));
    }
    rgba[i * 4 + 3] = 1;
  }
  return { dimension, data: rgba };
}
