import type { Effect } from "../../model/effect";
import { gradeCurveFromJson, gradeCurveIsIdentity } from "../../model/gradeCurve";
import { hueCurvesFromJson, hueCurvesIsIdentity } from "../../model/hueCurves";
import { colorWheelsCoefficients, colorWheelsIsNeutral } from "./colorWheels";
import { buildGradeCurveLUTs, buildHueCurveLUT, gradeCurveLutWidth, hueCurveLutWidth } from "./curveLuts";
import {
  effectDescriptor, effectDescriptorResolve, resolvedValue, type ResolvedEffectParams,
} from "./effectRegistry";
import type { CubeLUT } from "./lutLoader";

/** Where a sampler reads from: the effect's input, the previous pass's output, or pass N's output. */
export type PassInput = "source" | "previous" | { pass: number };

export interface PassTexture {
  kind: "curveLUT" | "lut3d" | "hueCurveLUT";
  data: Float32Array | Uint8Array;
  width: number;
  height: number;
  /** lut3d only: cube size n; data is n x n^2 strip == n^3 3D layout (r fastest). */
  depth?: number;
  /** Stable key so the renderer can cache the GPU upload. */
  cacheKey?: string;
}

/**
 * One fullscreen draw. `uImage` defaults to "previous" (pass 0: the source); `inputs` overrides it or binds extra
 * samplers by uniform name. The renderer supplies `uResolution` (target size in px) itself. Clamp-to-edge sampling.
 */
export interface RenderPass {
  shader: string;
  uniforms: Record<string, number | number[]>;
  textures?: Record<string, PassTexture>;
  inputs?: Record<string, PassInput>;
}

export interface EffectPassContext {
  /** Size in px of the image the effect runs on (CIImage extent). */
  width: number;
  height: number;
  /** Clip-relative frame offset (frame - clip.startFrame). */
  offset: number;
  spatialScale?: number;
  /**
   * Render resolution relative to Full (1, 0.5, 0.25): pixel-sized params that are not already tied to the image
   * size (sharpen/motion/glow radii, grain size) are multiplied by it so Half/Quarter look like Full.
   */
  pixelScale?: number;
  /** Resolves a .cube path to a parsed LUT (file I/O and caching live outside this module). */
  loadLut?: (path: string) => CubeLUT | undefined;
}

function blurPasses(sigma: number, premultiplied: boolean): RenderPass[] {
  const flag = (b: boolean): number => (b ? 1 : 0);
  return [
    { shader: "gaussianBlur", uniforms: { uSigma: sigma, uDirection: [1, 0], uPremultiplyIn: flag(premultiplied), uUnpremultiplyOut: 0 } },
    { shader: "gaussianBlur", uniforms: { uSigma: sigma, uDirection: [0, 1], uPremultiplyIn: 0, uUnpremultiplyOut: flag(premultiplied) } },
  ];
}

// --- CITemperatureAndTint approximation: white points on the Planckian locus (Kim et al.) shifted in CIE 1960 v by tint.
function whiteXY(kelvin: number): [number, number] {
  const T = kelvin;
  const x = T <= 4000
    ? -0.2661239e9 / (T * T * T) - 0.2343589e6 / (T * T) + 0.8776956e3 / T + 0.179910
    : -3.0258469e9 / (T * T * T) + 2.1070379e6 / (T * T) + 0.2226347e3 / T + 0.240390;
  let y: number;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear-sRGB white of (temperature K, tint), normalised to max channel 1. */
export function temperatureTintWhite(kelvin: number, tint: number): [number, number, number] {
  const [x, y] = whiteXY(Math.max(1667, kelvin));
  const d = -2 * x + 12 * y + 3;
  const u = (4 * x) / d;
  const v = (6 * y) / d + (tint / 100) * 0.02;
  const e = 2 * u - 8 * v + 4;
  const x2 = (3 * u) / e;
  const y2 = (2 * v) / e;
  const X = x2 / y2, Y = 1, Z = (1 - x2 - y2) / y2;
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
}

/** Per-channel gain mapping the `temperature`/`tint` neutral onto the (6500, 0) target neutral. */
export function temperatureTintGain(kelvin: number, tint: number): [number, number, number] {
  const n = temperatureTintWhite(kelvin, tint);
  const t = temperatureTintWhite(6500, 0);
  return [t[0] / n[0], t[1] / n[1], t[2] / n[2]];
}

function passesFor(
  id: string, p: ResolvedEffectParams, ctx: EffectPassContext,
): RenderPass[] {
  const v = (k: string): number => resolvedValue(p, k);
  const px = ctx.pixelScale ?? 1;
  switch (id) {
    case "color.exposure":
      return [{ shader: "exposure", uniforms: { uEv: v("ev") } }];
    case "color.contrast":
      return [{ shader: "colorControls", uniforms: { uSaturation: 1, uBrightness: 0, uContrast: v("amount") } }];
    case "color.saturation":
      return [{ shader: "colorControls", uniforms: { uSaturation: v("amount"), uBrightness: 0, uContrast: 1 } }];
    case "color.temperature":
      return [{ shader: "temperatureTint", uniforms: { uGain: temperatureTintGain(v("temperature"), v("tint")) } }];
    case "color.highlightsShadows": {
      if (v("highlights") === 0 && v("shadows") === 0) return [];
      return [{ shader: "highlightsShadows", uniforms: { uHighlights: v("highlights"), uShadows: v("shadows") } }];
    }
    case "color.blacksWhites": {
      if (v("blacks") === 0 && v("whites") === 0) return [];
      return [{ shader: "levels", uniforms: { uBlacks: v("blacks"), uWhites: v("whites") } }];
    }
    case "color.vibrance":
      return [{ shader: "vibrance", uniforms: { uAmount: v("amount") } }];
    case "color.wheels": {
      if (colorWheelsIsNeutral(p)) return [];
      const c = colorWheelsCoefficients(p);
      return [{ shader: "wheels", uniforms: { uLift: c.lift, uGain: c.gain, uInvGamma: c.invGamma } }];
    }
    case "color.hueCurves": {
      const json = p.strings["curves"];
      const curves = json === undefined ? undefined : hueCurvesFromJson(json);
      if (!curves || hueCurvesIsIdentity(curves)) return [];
      return [{
        shader: "hueCurves", uniforms: {},
        textures: {
          uLut: { kind: "hueCurveLUT", data: buildHueCurveLUT(curves), width: hueCurveLutWidth, height: 1, cacheKey: json },
        },
      }];
    }
    case "color.lut": {
      const path = p.strings["path"];
      const cube = path === undefined ? undefined : ctx.loadLut?.(path);
      if (path === undefined || !cube) return [];
      const n = cube.dimension;
      return [{
        shader: "lutTetra", uniforms: { uSize: n, uIntensity: v("intensity") },
        textures: { uLut: { kind: "lut3d", data: cube.data, width: n, height: n * n, depth: n, cacheKey: path } },
      }];
    }
    case "color.curves": {
      const json = p.strings["curve"];
      const curve = json === undefined ? undefined : gradeCurveFromJson(json);
      if (!curve || gradeCurveIsIdentity(curve)) return [];
      const luts = buildGradeCurveLUTs(curve);
      return [{
        shader: "gradeCurves", uniforms: {},
        textures: {
          uLutCh: { kind: "curveLUT", data: luts.channels, width: gradeCurveLutWidth, height: 1, cacheKey: `${json}#ch` },
          uLutMaster: { kind: "curveLUT", data: luts.master, width: gradeCurveLutWidth, height: 1, cacheKey: `${json}#master` },
        },
      }];
    }
    case "detail.clarity": {
      if (!(v("clarity") !== 0 || v("dehaze") !== 0) || !(ctx.width > 0 && ctx.height > 0)) return [];
      const radius = Math.max(ctx.width, ctx.height) / 40;
      return [
        ...blurPasses(radius, false),
        {
          shader: "clarityHaze", uniforms: { uClarity: v("clarity"), uDehaze: v("dehaze") },
          inputs: { uImage: "source", uBlurred: "previous" },
        },
      ];
    }
    case "key.chroma": {
      if (!(v("tolerance") > 0)) return [];
      return [{
        shader: "chromaKey",
        uniforms: { uKeyHue: v("keyHue"), uTolerance: v("tolerance"), uSoftness: v("softness"), uSpill: v("spill") },
      }];
    }
    case "blur.gaussian": {
      const radius = v("radius") * p.spatialScale;
      if (!(radius > 0)) return [];
      return blurPasses(radius, true);
    }
    case "blur.sharpen":
      return [{ shader: "sharpenLuminance", uniforms: { uSharpness: v("amount"), uRadius: 1.69 * px } }];
    case "blur.noiseReduction": {
      const amount = v("amount");
      if (!(amount > 0)) return [];
      return [{ shader: "noiseReduction", uniforms: { uNoiseLevel: amount * 0.1, uSharpness: 0.4 } }];
    }
    case "blur.motion": {
      const radius = v("radius");
      if (!(radius > 0)) return [];
      return [{ shader: "motionBlur", uniforms: { uRadius: radius * px, uAngle: (v("angle") * Math.PI) / 180 } }];
    }
    case "stylize.invert":
      return [{ shader: "invert", uniforms: {} }];
    case "stylize.grain": {
      if (!(v("amount") > 0)) return [];
      return [{ shader: "grain", uniforms: { uAmount: v("amount"), uSize: v("size") * px, uFrame: p.frame } }];
    }
    case "stylize.vignette": {
      if (v("amount") === 0 || !(ctx.width > 0 && ctx.height > 0)) return [];
      return [{
        shader: "vignette",
        uniforms: { uAmount: v("amount"), uMidpoint: v("midpoint"), uRoundness: v("roundness"), uFeather: v("feather") },
      }];
    }
    case "stylize.glow": {
      if (!(v("intensity") > 0)) return [];
      const radius = v("radius") * px;
      return [
        { shader: "glowBright", uniforms: { uThreshold: v("threshold"), uWarmth: v("warmth") } },
        ...(radius > 0 ? blurPasses(radius, false) : []),
        { shader: "glowComposite", uniforms: { uIntensity: v("intensity") }, inputs: { uImage: "source", uGlow: "previous" } },
      ];
    }
    default:
      return [];
  }
}

/** Passes for one clip effect; [] = passthrough (disabled, unknown type, neutral/guarded params, missing LUT). */
export function effectPasses(effect: Effect, ctx: EffectPassContext): RenderPass[] {
  if (!effect.enabled) return [];
  const d = effectDescriptor(effect.type);
  if (!d) return [];
  const p = effectDescriptorResolve(d, effect, ctx.offset, ctx.spatialScale ?? 1);
  return passesFor(d.id, p, ctx);
}

/** `EdgeRoundingKernel.apply`: clip-level rounding/softness applied after the effect stack. */
export function edgeRoundingPasses(edgeRounding: number, edgeSoftness: number, width: number, height: number): RenderPass[] {
  const norm = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  const r = norm(edgeRounding);
  const s = norm(edgeSoftness);
  if (!(r > 0 || s > 0) || !(width > 0 && height > 0)) return [];
  return [{ shader: "edgeRounding", uniforms: { uEdgeRounding: r, uEdgeSoftness: s } }];
}
