import { describe, expect, it } from "vitest";
import { colorWheelsChromaOffset, colorWheelsCoefficients, colorWheelsIsNeutral } from "./colorWheels";
import { makeResolvedEffectParams } from "./effectRegistry";

const neutral = {
  lift_x: 0, lift_y: 0, lift_m: 0, gamma_x: 0, gamma_y: 0, gamma_m: 1, gain_x: 0, gain_y: 0, gain_m: 1,
};

describe("ColorWheels", () => {
  it("neutral params are detected and produce identity coefficients", () => {
    const p = makeResolvedEffectParams({ values: neutral });
    expect(colorWheelsIsNeutral(p)).toBe(true);
    const c = colorWheelsCoefficients(p);
    expect(c.lift).toEqual([0, 0, 0]);
    expect(c.gain).toEqual([1, 1, 1]);
    expect(c.invGamma).toEqual([1, 1, 1]);
  });

  it("colorWheelGainMasterScalesAllChannels", () => {
    const p = makeResolvedEffectParams({ values: { ...neutral, gain_m: 0.5 } });
    const c = colorWheelsCoefficients(p);
    expect(colorWheelsIsNeutral(p)).toBe(false);
    const out = [0.8, 0.6, 0.4].map((v, i) => Math.pow(Math.max(v * (1 - c.lift[i]!) + c.lift[i]!, 0) * c.gain[i]!, c.invGamma[i]!));
    expect(out[0]).toBeCloseTo(0.4, 3);
    expect(out[1]).toBeCloseTo(0.3, 3);
    expect(out[2]).toBeCloseTo(0.2, 3);
  });

  it("chroma offset is luma neutral and zero at the centre", () => {
    expect(colorWheelsChromaOffset(0, 0)).toEqual([0, 0, 0]);
    const [r, g, b] = colorWheelsChromaOffset(0.5, 0.3);
    expect(r + g + b).toBeCloseTo(0, 9);
  });
});
