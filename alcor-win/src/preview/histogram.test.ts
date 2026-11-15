import { describe, expect, it } from "vitest";
import { histogramYRGB, hueHistogram, makeHistogram } from "./histogram";

const px = (...rgb: number[][]) => new Uint8Array(rgb.flatMap(([r, g, b]) => [r as number, g as number, b as number, 255]));

describe("histograms", () => {
  it("bins channels and luma, normalized to the global maximum", () => {
    const h = makeHistogram(256);
    expect(histogramYRGB(px([0, 0, 0], [0, 0, 0], [255, 255, 255]), 3, h)).toBe(true);
    expect(h.r[0]).toBe(1);
    expect(h.r[255]).toBe(0.5);
    expect(h.y[0]).toBe(1);
    expect(h.y[255]).toBe(0.5);
  });

  it("puts pure colors in their own channel", () => {
    const h = makeHistogram(16);
    histogramYRGB(px([255, 0, 0]), 1, h);
    expect(h.r[15]).toBe(1);
    expect(h.g[0]).toBe(1);
    expect(h.y[Math.floor(0.2126 * 16)]).toBe(1);
  });

  it("returns false and zeros for an empty frame", () => {
    const h = makeHistogram(8);
    h.y[3] = 1;
    expect(histogramYRGB(new Uint8Array(0), 0, h)).toBe(false);
    expect(h.y[3]).toBe(0);
  });

  it("hue histogram ignores gray and peaks at the hue bin", () => {
    const out = new Float32Array(12);
    hueHistogram(px([128, 128, 128], [0, 255, 0]), 2, out);
    expect(out[4]).toBe(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
    expect(hueHistogram(px([10, 10, 10]), 1, out)).toBe(true);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});
