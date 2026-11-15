import { describe, expect, it } from "vitest";
import { makeKeyframe, makeKeyframeTrack } from "../../model/keyframe";
import { makeEffect, makeEffectParam, makeStaticEffect } from "../../model/effect";
import { gradeCurveEncoded, makeGradeCurve } from "../../model/gradeCurve";
import { hueCurvesEncoded, makeHueCurves } from "../../model/hueCurves";
import { SHADERS } from "../shaders";
import { buildGradeCurveLUTs, buildHueCurveLUT } from "./curveLuts";
import {
  edgeRoundingPasses, effectPasses, temperatureTintGain, type EffectPassContext, type RenderPass,
} from "./effectPasses";
import { effectRegistryAll, effectDescriptorMakeEffect } from "./effectRegistry";
import { parseCubeLUT } from "./lutLoader";

const ctx: EffectPassContext = { width: 1920, height: 1080, offset: 0 };
const run = (type: string, values: Record<string, number> = {}, c = ctx): RenderPass[] =>
  effectPasses(makeStaticEffect(type, values), c);

describe("effectPasses", () => {
  it("guards: neutral/zero params are passthrough", () => {
    expect(run("color.highlightsShadows")).toEqual([]);
    expect(run("color.blacksWhites")).toEqual([]);
    expect(run("color.wheels")).toEqual([]);
    expect(run("key.chroma", { tolerance: 0 })).toEqual([]);
    expect(run("blur.gaussian", { radius: 0 })).toEqual([]);
    expect(run("blur.noiseReduction")).toEqual([]);
    expect(run("blur.motion")).toEqual([]);
    expect(run("stylize.grain")).toEqual([]);
    expect(run("stylize.vignette")).toEqual([]);
    expect(run("stylize.glow")).toEqual([]);
    expect(run("detail.clarity")).toEqual([]);
    expect(run("color.curves")).toEqual([]);
    expect(run("future.hologram")).toEqual([]);
    expect(effectPasses({ ...makeStaticEffect("color.exposure", { ev: 1 }), enabled: false }, ctx)).toEqual([]);
  });

  it("gaussian blur scales with spatialScale and premultiplies around the pair", () => {
    const p1 = run("blur.gaussian", { radius: 8 });
    const p2 = run("blur.gaussian", { radius: 8 }, { ...ctx, spatialScale: 2 });
    expect(p1.map((p) => p.shader)).toEqual(["gaussianBlur", "gaussianBlur"]);
    expect(p1[0]!.uniforms).toMatchObject({ uSigma: 8, uDirection: [1, 0], uPremultiplyIn: 1, uUnpremultiplyOut: 0 });
    expect(p1[1]!.uniforms).toMatchObject({ uDirection: [0, 1], uPremultiplyIn: 0, uUnpremultiplyOut: 1 });
    expect(p2[0]!.uniforms["uSigma"]).toBe(16);
  });

  it("clarity blurs at max(w,h)/40 then combines against the source", () => {
    const p = run("detail.clarity", { clarity: 0.5, dehaze: 0.25 });
    expect(p.map((x) => x.shader)).toEqual(["gaussianBlur", "gaussianBlur", "clarityHaze"]);
    expect(p[0]!.uniforms["uSigma"]).toBe(1920 / 40);
    expect(p[0]!.uniforms["uPremultiplyIn"]).toBe(0);
    expect(p[2]!.inputs).toEqual({ uImage: "source", uBlurred: "previous" });
    expect(p[2]!.uniforms).toEqual({ uClarity: 0.5, uDehaze: 0.25 });
  });

  it("glow chains bright -> blur -> composite; radius 0 skips the blur", () => {
    const p = run("stylize.glow", { intensity: 0.8, radius: 20, threshold: 0.3, warmth: 1 });
    expect(p.map((x) => x.shader)).toEqual(["glowBright", "gaussianBlur", "gaussianBlur", "glowComposite"]);
    expect(p[0]!.uniforms).toEqual({ uThreshold: 0.3, uWarmth: 1 });
    expect(p[1]!.uniforms["uSigma"]).toBe(20);
    expect(p[3]!.inputs).toEqual({ uImage: "source", uGlow: "previous" });
    const noBlur = run("stylize.glow", { intensity: 1, radius: 0 });
    expect(noBlur.map((x) => x.shader)).toEqual(["glowBright", "glowComposite"]);
  });

  it("grain passes the clip offset as the frame and keeps the grain size", () => {
    const p = run("stylize.grain", { amount: 1, size: 1.5 }, { ...ctx, offset: 12 });
    expect(p[0]!.uniforms).toEqual({ uAmount: 1, uSize: 1.5, uFrame: 12 });
  });

  it("pixel-sized params scale with the preview render resolution", () => {
    const half = { ...ctx, pixelScale: 0.5 };
    expect(run("blur.motion", { radius: 20, angle: 0 }, half)[0]!.uniforms["uRadius"]).toBe(10);
    expect(run("blur.sharpen", { amount: 1 }, half)[0]!.uniforms["uRadius"]).toBeCloseTo(0.845);
    expect(run("stylize.grain", { amount: 1, size: 2 }, half)[0]!.uniforms["uSize"]).toBe(1);
    expect(run("stylize.glow", { intensity: 1, radius: 20 }, half)[1]!.uniforms["uSigma"]).toBe(10);
    // Full quality (and an unset scale) leaves them untouched.
    expect(run("blur.motion", { radius: 20, angle: 0 })[0]!.uniforms["uRadius"]).toBe(20);
    expect(run("stylize.glow", { intensity: 1, radius: 20 }, { ...ctx, pixelScale: 1 })[1]!.uniforms["uSigma"]).toBe(20);
  });

  it("wheels uniforms follow ColorWheels.coefficients", () => {
    const p = run("color.wheels", { gain_m: 0.5 });
    expect(p[0]!.shader).toBe("wheels");
    expect(p[0]!.uniforms["uGain"]).toEqual([0.5, 0.5, 0.5]);
    expect(p[0]!.uniforms["uLift"]).toEqual([0, 0, 0]);
  });

  it("keyframed params resolve at the offset", () => {
    const e = makeEffect({
      type: "color.exposure",
      params: {
        ev: makeEffectParam({ value: 0, track: makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(10, 2, "linear")]) }),
      },
    });
    const ev = effectPasses(e, { ...ctx, offset: 5 })[0]!.uniforms["uEv"] as number;
    expect(ev).toBeCloseTo(1, 6);
  });

  it("temperature/tint gain is identity at the target and warms/cools in the right direction", () => {
    for (const g of temperatureTintGain(6500, 0)) expect(g).toBeCloseTo(1, 9);
    const warmSource = temperatureTintGain(3000, 0);
    expect(warmSource[2]).toBeGreaterThan(warmSource[0]);
  });

  it("curves: identity skipped, otherwise two 256x1 LUT textures", () => {
    const id = makeEffect({ type: "color.curves", params: { curve: makeEffectParam({ string: gradeCurveEncoded(makeGradeCurve()) }) } });
    expect(effectPasses(id, ctx)).toEqual([]);
    const curve = makeGradeCurve({ red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] });
    const e = makeEffect({ type: "color.curves", params: { curve: makeEffectParam({ string: gradeCurveEncoded(curve) }) } });
    const t = effectPasses(e, ctx)[0]!.textures!;
    expect(t["uLutCh"]).toMatchObject({ kind: "curveLUT", width: 256, height: 1 });
    expect(t["uLutMaster"]).toMatchObject({ kind: "curveLUT", width: 256, height: 1 });
  });

  it("hue curves: identity skipped, otherwise a 256x1 LUT", () => {
    const flat = makeHueCurves({ hueVsHue: Array.from({ length: 6 }, (_, i) => ({ x: i / 6, y: 0.5 })) });
    const mk = (h: ReturnType<typeof makeHueCurves>) =>
      makeEffect({ type: "color.hueCurves", params: { curves: makeEffectParam({ string: hueCurvesEncoded(h) }) } });
    expect(effectPasses(mk(flat), ctx)).toEqual([]);
    const pushed = makeHueCurves({ hueVsSat: Array.from({ length: 6 }, (_, i) => ({ x: i / 6, y: 1 })) });
    expect(effectPasses(mk(pushed), ctx)[0]!.textures!["uLut"]).toMatchObject({ kind: "hueCurveLUT", width: 256, height: 1 });
  });

  it("lut: needs a loadable cube; emits strip texture and size/intensity", () => {
    const text = ["LUT_3D_SIZE 2", ...Array.from({ length: 8 }, () => "0 0 0")].join("\n");
    const e = makeEffect({
      type: "color.lut",
      params: { path: makeEffectParam({ string: "/x.cube" }), intensity: makeEffectParam({ value: 0.5 }) },
    });
    expect(effectPasses(e, ctx)).toEqual([]);
    const p = effectPasses(e, { ...ctx, loadLut: () => parseCubeLUT(text) })[0]!;
    expect(p.uniforms).toEqual({ uSize: 2, uIntensity: 0.5 });
    expect(p.textures!["uLut"]).toMatchObject({ kind: "lut3d", width: 2, height: 4, depth: 2, cacheKey: "/x.cube" });
  });

  it("edge rounding normalises, and is skipped when both are 0", () => {
    expect(edgeRoundingPasses(0, 0, 100, 100)).toEqual([]);
    expect(edgeRoundingPasses(2, NaN, 100, 100)[0]!.uniforms).toEqual({ uEdgeRounding: 1, uEdgeSoftness: 0 });
  });

  it("every pass of every default-ish effect references real shaders, uniforms and samplers", () => {
    const text = ["LUT_3D_SIZE 2", ...Array.from({ length: 8 }, () => "0 0 0")].join("\n");
    const nonDefault: Record<string, Record<string, number>> = {
      "color.highlightsShadows": { highlights: 0.5 }, "color.blacksWhites": { blacks: 0.5 },
      "color.wheels": { gain_m: 0.8, lift_x: 0.4 }, "key.chroma": { tolerance: 0.5 },
      "blur.noiseReduction": { amount: 0.5 }, "blur.motion": { radius: 10 }, "stylize.grain": { amount: 0.5 },
      "stylize.vignette": { amount: -0.5 }, "stylize.glow": { intensity: 0.5 }, "detail.clarity": { clarity: 0.5 },
    };
    const extra: Record<string, ReturnType<typeof makeEffect>> = {
      "color.lut": makeEffect({ type: "color.lut", params: { path: makeEffectParam({ string: "p" }) } }),
      "color.curves": makeEffect({ type: "color.curves", params: { curve: makeEffectParam({ string: gradeCurveEncoded(makeGradeCurve({ master: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }] })) }) } }),
      "color.hueCurves": makeEffect({ type: "color.hueCurves", params: { curves: makeEffectParam({ string: hueCurvesEncoded(makeHueCurves({ hueVsSat: [{ x: 0, y: 1 }, { x: 0.5, y: 1 }] })) }) } }),
    };
    for (const d of effectRegistryAll) {
      let effect = extra[d.id] ?? effectDescriptorMakeEffect(d);
      const nd = nonDefault[d.id];
      if (nd) for (const [k, v] of Object.entries(nd)) effect.params[k] = makeEffectParam({ value: v });
      effect = { ...effect };
      const passes = effectPasses(effect, { ...ctx, loadLut: () => parseCubeLUT(text) });
      expect(passes.length, d.id).toBeGreaterThan(0);
      for (const p of passes) {
        const src = SHADERS[p.shader];
        expect(src, `${d.id}: shader ${p.shader}`).toBeDefined();
        for (const u of Object.keys(p.uniforms)) expect(src, `${d.id}: ${u}`).toMatch(new RegExp(`uniform\\s+\\w+\\s+${u}\\b`));
        for (const s of [...Object.keys(p.textures ?? {}), ...Object.keys(p.inputs ?? {})]) {
          expect(src, `${d.id}: ${s}`).toMatch(new RegExp(`uniform\\s+sampler2D\\s+${s}\\b`));
        }
      }
    }
  });
});

describe("curve LUT textures", () => {
  it("identity grade curve builds an identity ramp (Swift t = x/255)", () => {
    const { channels, master } = buildGradeCurveLUTs(makeGradeCurve());
    expect(channels.length).toBe(256 * 4);
    for (const x of [0, 17, 128, 255]) {
      expect(channels[x * 4]).toBeCloseTo(x / 255, 6);
      expect(channels[x * 4 + 1]).toBeCloseTo(x / 255, 6);
      expect(channels[x * 4 + 3]).toBe(1);
      expect(master[x * 4]).toBeCloseTo(x / 255, 6);
    }
  });

  it("channel curve only touches its channel; values clamped to 0…1", () => {
    const { channels } = buildGradeCurveLUTs(makeGradeCurve({ red: [{ x: 0, y: -1 }, { x: 1, y: 2 }] }));
    expect(channels[0]).toBe(0);
    expect(channels[255 * 4]).toBe(1);
    expect(channels[128 * 4 + 1]).toBeCloseTo(128 / 255, 6);
  });

  it("hue LUT: neutral is zero, extremes map to ±30° / ±1 / ±0.5", () => {
    const flat = (y: number) => Array.from({ length: 6 }, (_, i) => ({ x: i / 6, y }));
    const neutral = buildHueCurveLUT(makeHueCurves());
    expect(Array.from(neutral.slice(0, 4))).toEqual([0, 0, 0, 1]);
    const hi = buildHueCurveLUT(makeHueCurves({ hueVsHue: flat(1), hueVsSat: flat(1), hueVsLum: flat(1) }));
    expect(hi[100 * 4]).toBeCloseTo(1 / 12, 6);
    expect(hi[100 * 4 + 1]).toBeCloseTo(1, 6);
    expect(hi[100 * 4 + 2]).toBeCloseTo(0.5, 6);
  });
});

describe("shaders table", () => {
  it("every shader is a GLSL ES 3.00 fragment shader with a main and outColor", () => {
    for (const [name, src] of Object.entries(SHADERS)) {
      expect(src.startsWith("#version 300 es\n"), name).toBe(true);
      expect(src, name).toContain("precision highp float;");
      expect(src, name).toContain("out vec4 outColor;");
      expect(src, name).toContain("in vec2 vUv;");
      expect(src, name).toMatch(/void main\(\)/);
    }
  });
});
