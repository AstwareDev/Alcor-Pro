import { describe, expect, it } from "vitest";
import { decodeEffect, effectParamResolved, makeEffectParam, makeStaticEffect } from "./effect";
import { decodeClip } from "./timeline";
import { clipSetBlurKeyframeTrack, clipSetStaticBlurRadius, gaussianBlurRadiusKey, gaussianBlurType } from "./clipEffectKeyframes";
import { makeKeyframe, makeKeyframeTrack } from "./keyframe";
import { decodeHueCurves, hueCurvesEval, hueCurvesIsIdentity, hueCurvesRead, hueCurvesUpsert, makeHueCurves } from "./hueCurves";
import { gradeCurveEval, gradeCurveFromJson, gradeCurveEncoded, gradeCurveIsIdentity, makeGradeCurve } from "./gradeCurve";
import { fixtureClip, roundTrip } from "./fixtures";

describe("Effects — model", () => {
  it("clipEffectsRoundTripThroughCodable", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "m", start: 0, duration: 30 });
    clip.effects = [makeStaticEffect("color.exposure", { ev: 1.5 })];
    const decoded = roundTrip(clip, decodeClip);
    expect(decoded.effects?.length).toBe(1);
    expect(decoded.effects?.[0]?.type).toBe("color.exposure");
    expect(decoded.effects?.[0]?.params["ev"]?.value).toBe(1.5);
    expect(decoded.effects?.[0]?.enabled).toBe(true);
  });

  it("clipWithoutEffectsOmitsKey", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "m", start: 0, duration: 30 });
    expect(JSON.stringify(clip)).not.toContain('"effects"');
  });

  it("unknownEffectTypeIsPreserved", () => {
    const clip = fixtureClip({ id: "c1", mediaRef: "m", start: 0, duration: 30 });
    clip.effects = [makeStaticEffect("future.hologram", { wobble: 0.7 })];
    const final = roundTrip(roundTrip(clip, decodeClip), decodeClip);
    expect(final.effects?.[0]?.type).toBe("future.hologram");
    expect(final.effects?.[0]?.params["wobble"]?.value).toBe(0.7);
  });

  it("paramResolvesKeyframeTrackWhenPresent", () => {
    const param = makeEffectParam({ value: 1.0 });
    expect(effectParamResolved(param, 10, 0)).toBe(1.0);
    param.track = makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(20, 2.0, "linear")]);
    expect(Math.abs(effectParamResolved(param, 10, 0) - 1.0)).toBeLessThan(0.001);
    expect(Math.abs(effectParamResolved(param, 20, 0) - 2.0)).toBeLessThan(0.001);
  });

  it("blurEditsPreserveDisabledState", () => {
    const clip = fixtureClip({ start: 0, duration: 30 });
    const blur = makeStaticEffect(gaussianBlurType, { [gaussianBlurRadiusKey]: 8 });
    blur.enabled = false;
    clip.effects = [blur];

    clipSetStaticBlurRadius(clip, 16);
    expect(clip.effects?.[0]?.enabled).toBe(false);

    clipSetBlurKeyframeTrack(clip, makeKeyframeTrack([makeKeyframe(0, 16)]));
    expect(clip.effects?.[0]?.enabled).toBe(false);
  });

  it("effect decode is lenient about id, enabled and params but requires type", () => {
    const e = decodeEffect({ type: "x", enabled: "yes", params: 3 });
    expect(e.id.length).toBeGreaterThan(0);
    expect(e.enabled).toBe(true);
    expect(e.params).toEqual({});
    expect(() => decodeEffect({})).toThrow();
  });
});

describe("HueCurves", () => {
  it("cyclicEvalIsSeamlessAtHueWrap", () => {
    const pts = [{ x: 0, y: 0.9 }, { x: 5 / 6, y: 0.2 }];
    expect(Math.abs(hueCurvesEval(pts, 0.999) - hueCurvesEval(pts, 0.0))).toBeLessThan(0.05);
  });

  it("identity curves are removed from the effect stack, others upserted in canonical order", () => {
    const effects = [makeStaticEffect("blur.gaussian", { radius: 1 })];
    const curves = makeHueCurves({ hueVsHue: [{ x: 0, y: 0.8 }] });
    expect(hueCurvesIsIdentity(curves)).toBe(false);
    hueCurvesUpsert(curves, effects);
    expect(effects.map((e) => e.type)).toEqual(["color.hueCurves", "blur.gaussian"]);
    expect(hueCurvesRead(effects)).toEqual(curves);
    hueCurvesUpsert(makeHueCurves(), effects);
    expect(effects.map((e) => e.type)).toEqual(["blur.gaussian"]);
  });

  it("decode requires every curve key", () => {
    expect(() => decodeHueCurves({ hueVsHue: [] })).toThrow();
  });
});

describe("GradeCurve", () => {
  it("identity and eval", () => {
    expect(gradeCurveIsIdentity(makeGradeCurve())).toBe(true);
    expect(gradeCurveIsIdentity(makeGradeCurve({ master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }))).toBe(true);
    expect(gradeCurveEval([{ x: 0, y: 0.2 }, { x: 1, y: 1 }], 0.5)).toBeCloseTo(0.6, 12);
    expect(gradeCurveEval([], 0.3)).toBeCloseTo(0.3, 12);
    expect(gradeCurveEval([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.9 }], 0.1)).toBe(0.5);
  });

  it("json round-trip", () => {
    const g = makeGradeCurve({ red: [{ x: 0, y: 0.1 }] });
    expect(gradeCurveFromJson(gradeCurveEncoded(g))).toEqual(g);
    expect(gradeCurveFromJson("{bad")).toBeUndefined();
  });
});
