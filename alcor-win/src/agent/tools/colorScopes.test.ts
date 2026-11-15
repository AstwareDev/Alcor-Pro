import { describe, expect, it } from "vitest";
import { measureScopes, scopesGap, scopesReadout } from "./colorScopes";

function grid(n: number, px: (i: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const [r, g, b] = px(i);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

describe("ColorScopes", () => {
  it("measures a flat mid-gray frame", () => {
    const s = measureScopes(grid(8, () => [128, 128, 128]), 8);
    expect(s?.lumaMean).toBeCloseTo(128 / 255, 5);
    expect(s?.saturationMean).toBe(0);
    expect(s?.colorfulPct).toBe(0);
    expect(s?.hueHistogram.every((v) => v === 0)).toBe(true);
    expect(s?.clipLow).toBe(0);
    expect(s?.clipHigh).toBe(0);
    expect(s?.lumaHistogram[8]).toBe(1);
    expect(s?.shadowRGB).toEqual([0, 0, 0]);
  });

  it("puts a saturated red frame in hue bin 0 with warm bias", () => {
    const s = measureScopes(grid(8, () => [255, 0, 0]), 8);
    expect(s?.hueHistogram[0]).toBe(1);
    expect(s?.colorfulPct).toBe(1);
    expect(s?.warmCoolBias).toBe(1);
    expect(s?.greenMagentaBias).toBeCloseTo(-0.5, 5);
  });

  it("counts clipped pixels and percentiles", () => {
    const s = measureScopes(grid(10, (i) => (i < 50 ? [0, 0, 0] : [255, 255, 255])), 10);
    expect(s?.clipLow).toBe(0.5);
    expect(s?.clipHigh).toBe(0.5);
    expect(s?.lumaBlack).toBe(0);
    expect(s?.lumaWhite).toBe(1);
  });

  it("returns undefined for empty or short grids", () => {
    expect(measureScopes(new Uint8ClampedArray(0), 0)).toBeUndefined();
    expect(measureScopes(new Uint8ClampedArray(8), 4)).toBeUndefined();
  });

  it("reads out 3-decimal numbers and maps the gap onto knob hints", () => {
    const warm = measureScopes(grid(4, () => [200, 128, 60]), 4);
    const cool = measureScopes(grid(4, () => [60, 128, 200]), 4);
    if (!warm || !cool) throw new Error("no scopes");
    const readout = scopesReadout(warm) as { balance: { warmCool: number }; meanRGB: number[]; luma: { histogram16: number[] } };
    expect(readout.balance.warmCool).toBe(0.549);
    expect(readout.meanRGB).toEqual([0.784, 0.502, 0.235]);
    expect(readout.luma.histogram16.length).toBe(16);
    const gap = scopesGap(warm, cool) as { warmCool: number; hints: string[] };
    expect(gap.warmCool).toBe(1.098);
    expect(gap.hints).toContain("warmer than ref → cooler 'temperature'");
  });
});
