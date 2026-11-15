import { describe, expect, it } from "vitest";
import {
  RotationSnap, arrowStep, clampToRange, committedValue, formatFixed, scrubbedValue, sharedValue,
} from "./numberField";

describe("Scrubbable number field", () => {
  it.each(["nan", "NaN", "inf", "-inf", "", "abc", "1e999"])("rejectsNonFiniteValues %s", (text) => {
    expect(committedValue(text, "°", 1, { min: -360, max: 360 })).toBeUndefined();
  });

  it("parsesSuffixDecimalCommaAndClamps", () => {
    expect(committedValue("125,5%", "%", 100, { min: 0, max: 1 })).toBe(1);
  });

  it("parsesPlainAndScaledValues", () => {
    expect(committedValue(" 50 % ", "%", 100, { min: 0, max: 1 })).toBe(0.5);
    expect(committedValue("-3.5 dB", " dB", 1, { min: -60, max: 15 })).toBe(-3.5);
    expect(committedValue("7", "", 0, { min: 0, max: 10 })).toBe(7);
  });

  it("formatsLikePrintf", () => {
    expect(formatFixed("%.0f", 0.5)).toBe("0");
    expect(formatFixed("%.0f", 1.5)).toBe("2");
    expect(formatFixed("%.0f", 2.5)).toBe("2");
    expect(formatFixed("%.1f", -0.04)).toBe("-0.0");
    expect(formatFixed("%.2f", 1)).toBe("1.00");
    expect(formatFixed("%.0f", 1920)).toBe("1920");
  });

  it("scrubUsesSensitivityAndModifiers", () => {
    const range = { min: 0, max: 1 };
    const none = { shift: false, fine: false };
    expect(scrubbedValue(0.5, 10, 1, 100, range, none)).toBeCloseTo(0.6);
    expect(scrubbedValue(0.5, 10, 1, 100, range, { shift: true, fine: false })).toBe(1);
    expect(scrubbedValue(0.5, 10, 1, 100, range, { shift: false, fine: true })).toBeCloseTo(0.51);
    expect(scrubbedValue(0.5, -100, 1, 100, range, none)).toBe(0);
  });

  it("scrubAppliesDragAdjustmentThenClamps", () => {
    const range = { min: -3600, max: 3600 };
    const none = { shift: false, fine: false };
    expect(scrubbedValue(0, 88, 1, 1, range, none, RotationSnap.adjusted)).toBe(90);
    expect(scrubbedValue(0, 40, 1, 1, range, none, RotationSnap.adjusted)).toBe(40);
  });

  it("arrowStepScalesWithModifiers", () => {
    expect(arrowStep(1, 100, { shift: false, fine: false })).toBeCloseTo(0.01);
    expect(arrowStep(1, 100, { shift: true, fine: false })).toBeCloseTo(0.1);
  });

  it("clampsAndSharesValues", () => {
    expect(clampToRange(5, { min: 0, max: 1 })).toBe(1);
    expect(sharedValue([1, 1, 1], (n) => n)).toBe(1);
    expect(sharedValue([1, 2], (n) => n)).toBeUndefined();
    expect(sharedValue([], (n: number) => n)).toBeUndefined();
  });

  it("rotationSnapMatchesSwift", () => {
    expect(RotationSnap.adjusted(93)).toBe(90);
    expect(RotationSnap.adjusted(-2)).toBe(0);
    expect(RotationSnap.adjusted(50)).toBe(50);
    expect(RotationSnap.isAxisAligned(180)).toBe(true);
    expect(RotationSnap.isAxisAligned(45)).toBe(false);
  });
});
