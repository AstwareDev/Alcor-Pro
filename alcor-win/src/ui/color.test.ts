import { describe, expect, it } from "vitest";
import { makeRGBA } from "../model";
import { hexText, hsvToRgb, parseHexInput, rgbToHsv, rgbaCss } from "./color";

describe("color conversions", () => {
  it("roundTripsRgbThroughHsv", () => {
    for (const c of [makeRGBA({ r: 1, g: 0, b: 0 }), makeRGBA({ r: 0.2, g: 0.6, b: 0.9 }), makeRGBA({ r: 0.5, g: 0.5, b: 0.5 }), makeRGBA({ r: 0, g: 0, b: 0 })]) {
      const back = hsvToRgb(rgbToHsv(c), c.a);
      expect(back.r).toBeCloseTo(c.r, 6);
      expect(back.g).toBeCloseTo(c.g, 6);
      expect(back.b).toBeCloseTo(c.b, 6);
    }
  });

  it("knownHues", () => {
    expect(rgbToHsv(makeRGBA({ r: 0, g: 1, b: 0 })).h).toBeCloseTo(1 / 3, 6);
    expect(rgbToHsv(makeRGBA({ r: 0, g: 0, b: 1 })).h).toBeCloseTo(2 / 3, 6);
    expect(hsvToRgb({ h: 0.5, s: 1, v: 1 })).toEqual(makeRGBA({ r: 0, g: 1, b: 1 }));
  });

  it("formatsHexWithAndWithoutAlpha", () => {
    const c = makeRGBA({ r: 1, g: 0.5, b: 0, a: 0.6 });
    expect(hexText(c, false)).toBe("#FF8000");
    expect(hexText(c, true)).toBe("#FF800099");
  });

  it("parsesHexKeepingBaseAlphaUnlessProvided", () => {
    const base = makeRGBA({ a: 0.25 });
    expect(parseHexInput("#00FF00", base, true)?.a).toBe(0.25);
    expect(parseHexInput("00FF0080", base, true)?.a).toBeCloseTo(128 / 255);
    expect(parseHexInput("00FF0080", base, false)?.a).toBe(0.25);
    expect(parseHexInput("nope", base, true)).toBeUndefined();
  });

  it("buildsCssColor", () => {
    expect(rgbaCss(makeRGBA({ r: 1, g: 0, b: 0, a: 0.5 }))).toBe("rgb(255 0 0 / 0.5)");
  });
});
