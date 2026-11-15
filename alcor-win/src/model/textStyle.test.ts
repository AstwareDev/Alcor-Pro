import { describe, expect, it } from "vitest";
import {
  decodeTextStyle, makeRGBA, makeTextBackground, makeTextOutline, makeTextShadow, makeTextStyle, rgbaFromHex,
  rgbaHexString, textStyleScaledVisualStyle,
} from "./textStyle";

describe("RGBA hex parsing", () => {
  it("threeDigitExpandsEachChannel", () => {
    const c = rgbaFromHex("F0A");
    expect(c?.r).toBe(1.0);
    expect(c?.g).toBe(0);
    expect(Math.abs((c?.b ?? -1) - 170.0 / 255.0)).toBeLessThan(1e-9);
    expect(c?.a).toBe(1);
  });

  it("threeDigitWhiteIsAllOnes", () => {
    expect(rgbaFromHex("fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("sixDigitParsesEachChannelAsByte", () => {
    const c = rgbaFromHex("FF8800");
    expect(c?.r).toBe(1);
    expect(Math.abs((c?.g ?? -1) - 136.0 / 255.0)).toBeLessThan(1e-9);
    expect(c?.b).toBe(0);
    expect(c?.a).toBe(1);
  });

  it("eightDigitIncludesAlphaChannel", () => {
    const c = rgbaFromHex("FF880080");
    expect(c?.r).toBe(1);
    expect(Math.abs((c?.a ?? -1) - 128.0 / 255.0)).toBeLessThan(1e-9);
  });

  it("eightDigitFullAlphaMatchesSixDigit", () => {
    const six = rgbaFromHex("112233");
    const eight = rgbaFromHex("112233FF");
    expect(six?.r).toBe(eight?.r);
    expect(six?.g).toBe(eight?.g);
    expect(six?.b).toBe(eight?.b);
    expect(eight?.a).toBe(1);
  });

  it("leadingHashIsOptional", () => {
    expect(rgbaFromHex("#FF0000")).toEqual(rgbaFromHex("FF0000"));
  });

  it("surroundingWhitespaceIsTrimmed", () => {
    expect(rgbaFromHex("   #00FF00  ")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  it("surroundingNewlinesAreTrimmed", () => {
    expect(rgbaFromHex("#00FF00\n")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(rgbaFromHex("\r\n  #00FF00  \n")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  it("emptyStringReturnsNil", () => {
    expect(rgbaFromHex("")).toBeUndefined();
    expect(rgbaFromHex("#")).toBeUndefined();
  });

  it("wrongLengthReturnsNil", () => {
    for (const s of ["FF", "FFFF", "FFFFF", "FFFFFFF", "FFFFFFFFF"]) expect(rgbaFromHex(s)).toBeUndefined();
  });

  it("nonHexCharactersReturnNil", () => {
    for (const s of ["GG0000", "ZZZ", "QWERTYUI"]) expect(rgbaFromHex(s)).toBeUndefined();
  });

  it("acceptsLowercaseAndMixedCase", () => {
    expect(rgbaFromHex("ff8800")).toEqual(rgbaFromHex("FF8800"));
    expect(rgbaFromHex("Ff8800")).toEqual(rgbaFromHex("FF8800"));
  });

  it("rejectsZeroXPrefix", () => {
    expect(rgbaFromHex("0xFF8800")).toBeUndefined();
  });

  it("rejectsEmbeddedWhitespace", () => {
    expect(rgbaFromHex("FF 00 00")).toBeUndefined();
  });

  it("hexString round-trips", () => {
    expect(rgbaHexString(makeRGBA({ r: 1, g: 0, b: 0.5, a: 1 }))).toBe("#FF0080FF");
  });
});

describe("TextStyle decoding", () => {
  it("textStyleMissingScaleFieldsDecodesAsOne", () => {
    const style = decodeTextStyle({
      fontName: "Helvetica-Bold", fontSize: 96, color: { r: 1, g: 1, b: 1, a: 1 }, alignment: "center",
      shadow: { enabled: true, color: { r: 0, g: 0, b: 0, a: 0.6 }, offsetX: 0, offsetY: -2, blur: 6 },
    });
    expect(style.fontScale).toBe(1.0);
    expect(style.widthScale).toBe(1.0);
    expect(style.heightScale).toBe(1.0);
    expect(style.tracking).toBe(0);
    expect(style.lineSpacing).toBe(0);
    expect(style.blur).toBe(0);
    expect(style.fontCase).toBe("mixed");
    expect(!style.isUnderlined && !style.isStruckThrough && !style.isOverlined).toBe(true);
  });

  it("textStyleLegacyDecorationsPickUpAdjustableDefaults", () => {
    const style = decodeTextStyle({
      border: { enabled: true, color: { r: 0, g: 0, b: 0, a: 1 } },
      background: { enabled: true, color: { r: 0.1, g: 0.2, b: 0.3, a: 0.5 } },
    });
    expect(style.border.enabled).toBe(true);
    expect(style.border.width).toBe(4);
    expect(style.background.enabled).toBe(true);
    expect(style.background.paddingX).toBe(0);
    expect(style.background.paddingY).toBe(0);
    expect(style.background.cornerRadius).toBe(0);
    expect(style.background.outlineWidth).toBe(0);
  });

  it("textStyleDecorationAdjustmentsRoundTrip", () => {
    const style = makeTextStyle({
      widthScale: 1.4, heightScale: 0.75, blur: 24, tracking: 8, lineSpacing: 18, fontCase: "uppercase",
      isUnderlined: true, isStruckThrough: true, isOverlined: true,
      border: makeTextOutline({ enabled: true, color: { r: 1, g: 0, b: 0, a: 1 }, width: 9 }),
      shadow: makeTextShadow({ enabled: true, color: { r: 0, g: 0, b: 0, a: 0.35 }, offsetX: 12, offsetY: 18, blur: 24 }),
      background: makeTextBackground({
        enabled: true, color: { r: 0, g: 0, b: 1, a: 0.7 }, paddingX: 32, paddingY: 16, cornerRadius: 20,
        offsetX: 4, offsetY: -6, outlineColor: { r: 1, g: 1, b: 1, a: 1 }, outlineWidth: 3,
      }),
    });
    expect(decodeTextStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
  });

  it("scaledVisualStyle multiplies sizes and resets fontScale", () => {
    const s = makeTextStyle({ fontSize: 10, fontScale: 2, tracking: 1 });
    const scaled = textStyleScaledVisualStyle(s);
    expect(scaled.fontSize).toBe(20);
    expect(scaled.tracking).toBe(2);
    expect(scaled.fontScale).toBe(1);
    expect(s.fontScale).toBe(2);
  });
});
