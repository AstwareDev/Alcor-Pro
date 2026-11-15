import { describe, expect, it } from "vitest";
import { parseCubeLUT } from "./lutLoader";

function cubeText(n: number): string {
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  }
  return lines.join("\n");
}

describe("LUTLoader", () => {
  it("parses33PointCube", () => {
    expect(parseCubeLUT(cubeText(33))?.dimension).toBe(33);
  });

  it("parses65PointCube", () => {
    const lut = parseCubeLUT(cubeText(65));
    expect(lut?.dimension).toBe(65);
    expect(lut?.data.length).toBe(65 * 65 * 65 * 4);
  });

  it("rejects1DLUT", () => {
    expect(parseCubeLUT("LUT_1D_SIZE 16\n0 0 0")).toBeUndefined();
  });

  it("packs r-fastest RGBA with alpha 1", () => {
    const lut = parseCubeLUT(cubeText(2))!;
    expect(Array.from(lut.data.slice(4, 8))).toEqual([1, 0, 0, 1]);
    expect(Array.from(lut.data.slice(8, 12))).toEqual([0, 1, 0, 1]);
    expect(Array.from(lut.data.slice(16, 20))).toEqual([0, 0, 1, 1]);
  });

  it("normalises the domain, clamps, skips comments/title, tolerates CRLF", () => {
    const text = ["# c", 'TITLE "x y"', "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 2 2 2"]
      .concat(Array.from({ length: 8 }, () => "1 4 -1")).join("\r\n");
    const lut = parseCubeLUT(text)!;
    expect(Array.from(lut.data.slice(0, 4))).toEqual([0.5, 1, 0, 1]);
  });

  it("rejects wrong counts, bad sizes and non-numeric rows", () => {
    expect(parseCubeLUT("LUT_3D_SIZE 2\n0 0 0")).toBeUndefined();
    expect(parseCubeLUT("LUT_3D_SIZE 1\n0 0 0")).toBeUndefined();
    expect(parseCubeLUT("LUT_3D_SIZE 2\na b c")).toBeUndefined();
  });
});
