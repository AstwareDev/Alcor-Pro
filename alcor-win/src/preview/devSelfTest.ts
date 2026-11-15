// GPU self-test for the dev page (?dev=preview&test=1): renders known frame graphs and checks readback pixels.
import type { BlendMode } from "../model/blendMode";
import { blendModes } from "../model/blendMode";
import { makeStaticEffect, makeEffect, makeEffectParam, type Effect } from "../model/effect";
import { gradeCurveEncoded, makeGradeCurve } from "../model/gradeCurve";
import { hueCurvesEncoded, makeHueCurves } from "../model/hueCurves";
import { makeKeyframe, makeKeyframeTrack, makeAnimPair } from "../model/keyframe";
import { makeRGBA, makeTextStyle } from "../model/textStyle";
import {
  makeClip, makeCrop, makeTimeline, makeTrack, makeTransform, timelineTotalFrames, type Clip, type Timeline, type Track,
} from "../model/timeline";
import { effectRegistryAll } from "./effects/effectRegistry";
import type { CubeLUT } from "./effects/lutLoader";
import { buildFrameGraph } from "./frameGraph";
import { Compositor, type SourceFrame, type TextureProvider } from "./renderer";

export interface SelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

type RGB = { r: number; g: number; b: number };

const W = 320, H = 180;

const isRed = (p: RGB): boolean => p.r > 140 && p.g < 100 && p.b < 100;
const isGreen = (p: RGB): boolean => p.g > 140 && p.r < 110 && p.b < 110;
const isBlue = (p: RGB): boolean => p.b > 140 && p.r < 100 && p.g < 100;
const isWhite = (p: RGB): boolean => p.r > 170 && p.g > 170 && p.b > 170;
const isBlack = (p: RGB): boolean => p.r < 45 && p.g < 45 && p.b < 45;

class Frame {
  constructor(readonly px: Uint8Array, readonly w: number, readonly h: number) {}
  at(x: number, y: number): RGB {
    const i = (y * this.w + x) * 4;
    return { r: this.px[i] as number, g: this.px[i + 1] as number, b: this.px[i + 2] as number };
  }
  get tl(): RGB { return this.at(80, 45); }
  get tr(): RGB { return this.at(240, 45); }
  get bl(): RGB { return this.at(80, 135); }
  get br(): RGB { return this.at(240, 135); }
  get center(): RGB { return this.at(this.w / 2, this.h / 2); }
}

function quadrantCanvas(colors: [string, string, string, string], clearRect?: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, W / 2, H / 2);
  ctx.fillStyle = colors[1]; ctx.fillRect(W / 2, 0, W / 2, H / 2);
  ctx.fillStyle = colors[2]; ctx.fillRect(0, H / 2, W / 2, H / 2);
  ctx.fillStyle = colors[3]; ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
  if (clearRect) ctx.clearRect(W / 2, 0, W / 2, H);
  return c;
}

function solidCanvas(r: number, g: number, b: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, W, H);
  return c;
}

function frameOf(canvas: HTMLCanvasElement): SourceFrame {
  return { source: canvas, width: canvas.width, height: canvas.height, version: 1, premultiplied: false };
}

function identityCube(n: number): CubeLUT {
  const data = new Float32Array(n * n * n * 4);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const i = ((b * n + g) * n + r) * 4;
    data[i] = r / (n - 1); data[i + 1] = g / (n - 1); data[i + 2] = b / (n - 1); data[i + 3] = 1;
  }
  return { dimension: n, data };
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** W3C compositing formulas (what the CI blend filters implement) for an opaque backdrop. */
function blendRef(mode: BlendMode, b: number[], s: number[]): number[] {
  const sep = (f: (b: number, s: number) => number): number[] => b.map((bv, i) => f(bv, s[i] as number));
  const hard = (bv: number, sv: number): number => (sv <= 0.5 ? bv * 2 * sv : bv + (2 * sv - 1) - bv * (2 * sv - 1));
  const lum = (c: number[]): number => 0.3 * (c[0] as number) + 0.59 * (c[1] as number) + 0.11 * (c[2] as number);
  const clip = (c: number[]): number[] => {
    const l = lum(c), n = Math.min(...c), x = Math.max(...c);
    let out = c;
    if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
    if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
    return out;
  };
  const setLum = (c: number[], l: number): number[] => clip(c.map((v) => v + (l - lum(c))));
  const sat = (c: number[]): number => Math.max(...c) - Math.min(...c);
  const setSat = (c: number[], sv: number): number[] => {
    const mx = Math.max(...c), mn = Math.min(...c);
    return mx - mn <= 1e-6 ? [0, 0, 0] : c.map((v) => ((v - mn) * sv) / (mx - mn));
  };
  switch (mode) {
    case "normal": return s;
    case "darken": return sep(Math.min);
    case "multiply": return sep((x, y) => x * y);
    case "colorBurn": return sep((x, y) => (x >= 1 ? 1 : y <= 0 ? 0 : 1 - Math.min(1, (1 - x) / y)));
    case "lighten": return sep(Math.max);
    case "screen": return sep((x, y) => x + y - x * y);
    case "colorDodge": return sep((x, y) => (x <= 0 ? 0 : y >= 1 ? 1 : Math.min(1, x / (1 - y))));
    case "overlay": return sep((x, y) => hard(y, x));
    case "softLight": return sep((x, y) => {
      if (y <= 0.5) return x - (1 - 2 * y) * x * (1 - x);
      const d = x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x);
      return x + (2 * y - 1) * (d - x);
    });
    case "hardLight": return sep(hard);
    case "difference": return sep((x, y) => Math.abs(x - y));
    case "exclusion": return sep((x, y) => x + y - 2 * x * y);
    case "hue": return setLum(setSat(s, sat(b)), lum(b));
    case "saturation": return setLum(setSat(b, sat(s)), lum(b));
    case "color": return setLum(s, lum(b));
    case "luminosity": return setLum(b, lum(s));
  }
}

export function runGpuSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = [];
  const canvas = document.createElement("canvas");
  const comp = new Compositor(canvas, { loadLut: () => identityCube(17) });
  const sources = new Map<string, SourceFrame>([
    ["pattern", frameOf(quadrantCanvas(["#ff0000", "#00ff00", "#0000ff", "#ffffff"]))],
    ["midtone", frameOf(quadrantCanvas(["rgb(179,110,89)", "rgb(69,150,99)", "rgb(89,110,191)", "rgb(140,140,140)"]))],
    ["alpha", frameOf(quadrantCanvas(["#ff0000", "#ff0000", "#ff0000", "#ff0000"], true))],
    ["white", frameOf(solidCanvas(255, 255, 255))],
    ["colorA", frameOf(solidCanvas(51, 128, 204))],
    ["colorB", frameOf(solidCanvas(179, 77, 153))],
  ]);
  const provider: TextureProvider = { media: (l) => sources.get(l.mediaRef) ?? null };
  const size = { width: W, height: H };

  const check = (name: string, fn: () => [boolean, string]): void => {
    try {
      const [ok, detail] = fn();
      results.push({ name, ok, detail });
    } catch (e) {
      results.push({ name, ok: false, detail: `threw ${String(e)}` });
    }
  };
  const clip = (p: Partial<Clip> & { mediaRef?: string } = {}): Clip =>
    makeClip({ mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: 60, ...p, mediaRef: p.mediaRef ?? "pattern" });
  const vt = (...clips: Clip[]): Track => makeTrack({ type: "video", clips });
  const tl = (...tracks: Track[]): Timeline => makeTimeline({ width: W, height: H, fps: 30, tracks });
  const render = (timeline: Timeline, frame: number, extra: Timeline[] = [], scale = 1): Frame => {
    comp.setScale(scale);
    const graph = buildFrameGraph({ timelines: [timeline, ...extra] }, timeline.id, frame, { resolveSourceSize: () => size });
    comp.render(graph, provider);
    const out = comp.outputSize(W, H);
    return new Frame(comp.readPixels(0, 0, out.width, out.height), out.width, out.height);
  };
  const fmt = (p: RGB): string => `(${p.r},${p.g},${p.b})`;

  const failures = comp.compileAll();
  check("compile all programs", () => [failures.length === 0, failures.join("; ") || "ok"]);

  // Port of CompositorRenderTests.
  check("identityQuadrants", () => {
    const f = render(tl(vt(clip())), 15);
    return [isRed(f.tl) && isGreen(f.tr) && isBlue(f.bl) && isWhite(f.br), `${fmt(f.tl)} ${fmt(f.tr)} ${fmt(f.bl)} ${fmt(f.br)}`];
  });
  check("flipHorizontalSwapsLeftRight", () => {
    const f = render(tl(vt(clip({ transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isGreen(f.tl) && isRed(f.tr), `${fmt(f.tl)} ${fmt(f.tr)}`];
  });
  check("flipVerticalSwapsTopBottom", () => {
    const f = render(tl(vt(clip({ transform: makeTransform({ flipVertical: true }) }))), 15);
    return [isBlue(f.tl) && isRed(f.bl), `${fmt(f.tl)} ${fmt(f.bl)}`];
  });
  check("rotationLeavesCornersBlack", () => {
    const f = render(tl(vt(clip({ transform: makeTransform({ width: 0.6, height: 0.6, rotation: 45 }) }))), 15);
    return [isBlack(f.at(5, 5)) && !isBlack(f.at(160, 90)), `${fmt(f.at(5, 5))} ${fmt(f.at(160, 90))}`];
  });
  check("rotation90MapsTopLeftToTopRight", () => {
    // Positive rotation is clockwise on screen: the red TL quadrant of a centred square-ish clip moves to the right.
    const f = render(tl(vt(clip({ transform: makeTransform({ width: 0.5, height: 0.5, rotation: 90 }) }))), 15);
    return [isRed(f.at(185, 50)) && isBlue(f.at(135, 50)), `${fmt(f.at(185, 50))} ${fmt(f.at(135, 50))}`];
  });
  check("pipOverBackground", () => {
    const f = render(tl(vt(clip({ id: "pip", transform: makeTransform({ centerX: 0.3, centerY: 0.35, width: 0.5, height: 0.5 }) })), vt(clip({ id: "bg" }))), 15);
    return [isWhite(f.at(300, 170)) && isRed(f.at(60, 30)), `${fmt(f.at(300, 170))} ${fmt(f.at(60, 30))}`];
  });
  check("transformPlacementPixelExact", () => {
    // Half-size clip centred at (0.25, 0.25): occupies x∈[0,160), y∈[0,90); its BR (white) quadrant is x∈[80,160), y∈[45,90).
    const f = render(tl(vt(clip({ transform: makeTransform({ centerX: 0.25, centerY: 0.25, width: 0.5, height: 0.5 }) }))), 15);
    return [isWhite(f.at(150, 80)) && isBlack(f.at(165, 80)) && isBlack(f.at(150, 95)) && isRed(f.at(10, 10)),
      `${fmt(f.at(150, 80))} ${fmt(f.at(165, 80))} ${fmt(f.at(150, 95))}`];
  });
  check("cropLeftRevealsBlack", () => {
    const f = render(tl(vt(clip({ crop: makeCrop({ left: 0.4 }) }))), 15);
    return [isBlack(f.at(10, 90)) && !isBlack(f.at(300, 45)) && isBlack(f.at(126, 45)) && isRed(f.at(130, 45)),
      `${fmt(f.at(10, 90))} ${fmt(f.at(126, 45))} ${fmt(f.at(130, 45))}`];
  });
  check("edgeRoundingRevealsBackgroundAndPreservesInterior", () => {
    const f = render(tl(vt(clip({ id: "fg", edgeRounding: 1 })), vt(clip({ id: "bg", transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isGreen(f.at(5, 5)) && isRed(f.tl), `${fmt(f.at(5, 5))} ${fmt(f.tl)}`];
  });
  check("edgeRoundingUsesVisibleCropBounds", () => {
    const f = render(tl(vt(clip({ id: "fg", crop: makeCrop({ left: 0.25 }), edgeRounding: 1 })), vt(clip({ id: "bg", transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isGreen(f.at(82, 5)) && isRed(f.at(100, 45)), `${fmt(f.at(82, 5))} ${fmt(f.at(100, 45))}`];
  });
  check("edgeSoftnessFeathersAlphaAndPreservesInterior", () => {
    const f = render(tl(vt(clip({ id: "fg", edgeSoftness: 0.25 })), vt(clip({ id: "bg", transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isGreen(f.at(2, 45)) && isRed(f.tl), `${fmt(f.at(2, 45))} ${fmt(f.tl)}`];
  });
  check("edgeRoundingAlphaMatchesSdf", () => {
    const f = render(tl(vt(clip({ mediaRef: "white", edgeRounding: 0.5 }))), 15);
    const radius = 0.5 * Math.min(W, H) * 0.5;
    const cov = (x: number, y: number): number => {
      const qx = Math.abs(x + 0.5 - W / 2) - (W / 2 - radius), qy = Math.abs(y + 0.5 - H / 2) - (H / 2 - radius);
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const t = Math.min(1, Math.max(0, (dist + 0.5) / 1));
      return 1 - t * t * (3 - 2 * t);
    };
    let worst = 0;
    for (const [x, y] of [[3, 3], [13, 13], [10, 30], [30, 10], [45, 45], [160, 90], [2, 90]] as const) {
      worst = Math.max(worst, Math.abs(f.at(x, y).r - 255 * cov(x, y)));
    }
    return [worst <= 6, `max |Δ| = ${worst.toFixed(1)}`];
  });
  check("cropKeyframedMidway", () => {
    const c = clip({
      cropTrack: makeKeyframeTrack([makeKeyframe(0, makeCrop(), "linear"), makeKeyframe(60, makeCrop({ left: 0.6 }), "linear")]),
    });
    const f = render(tl(vt(c)), 30);
    return [isBlack(f.at(10, 90)) && !isBlack(f.at(300, 90)), `${fmt(f.at(10, 90))}`];
  });
  check("opacityHalfOverBlack", () => {
    const f = render(tl(vt(clip({ opacity: 0.5 }))), 15);
    return [Math.abs(f.tl.r - 127.5) <= 2 && f.tl.g < 3, fmt(f.tl)];
  });
  check("opacityKeyframedDims", () => {
    const c = clip({ opacityTrack: makeKeyframeTrack([makeKeyframe(0, 1.0, "smooth"), makeKeyframe(60, 0.0, "smooth")]) });
    const f = render(tl(vt(c)), 30);
    return [f.tl.r > 60 && f.tl.r < 210, fmt(f.tl)];
  });
  check("fadeInMidwayDims", () => {
    const f = render(tl(vt(clip({ fadeInFrames: 30 }))), 15);
    return [Math.abs(f.tl.r - 127.5) <= 2, fmt(f.tl)];
  });
  check("transformKeyframedPlacesClip", () => {
    const c = clip({
      scaleTrack: makeKeyframeTrack([makeKeyframe(0, makeAnimPair(1, 1), "linear"), makeKeyframe(60, makeAnimPair(0.5, 0.5), "linear")]),
      positionTrack: makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0, 0), "linear"), makeKeyframe(60, makeAnimPair(0.5, 0.5), "linear")]),
    });
    const f = render(tl(vt(c)), 59);
    return [isBlack(f.at(10, 10)) && !isBlack(f.at(280, 160)), `${fmt(f.at(10, 10))} ${fmt(f.at(280, 160))}`];
  });
  check("gapIsBlack", () => {
    const f = render(tl(vt(clip({ startFrame: 30, durationFrames: 30 }))), 10);
    return [isBlack(f.tl) && isBlack(f.center), fmt(f.tl)];
  });
  check("hiddenTrackSkipped", () => {
    const hidden = vt(clip({ id: "hid" }));
    hidden.hidden = true;
    const f = render(tl(hidden, vt(clip({ id: "bg", transform: makeTransform({ flipVertical: true }) }))), 15);
    return [isBlue(f.tl), fmt(f.tl)];
  });
  check("topLayerWinsInStack", () => {
    const f = render(tl(vt(clip({ id: "top" })), vt(clip({ id: "bg", transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isRed(f.tl), fmt(f.tl)];
  });
  check("layerOrderSolids", () => {
    const f = render(tl(vt(clip({ id: "b", mediaRef: "colorB", transform: makeTransform({ width: 0.5, height: 0.5 }) })), vt(clip({ id: "a", mediaRef: "colorA" }))), 15);
    const inner = f.center, outer = f.at(5, 5);
    return [Math.abs(inner.r - 179) <= 2 && Math.abs(outer.r - 51) <= 2, `${fmt(inner)} ${fmt(outer)}`];
  });
  check("alphaMediaShowsBackgroundThrough", () => {
    const f = render(tl(vt(clip({ id: "ov", mediaRef: "alpha" })), vt(clip({ id: "bg" }))), 15);
    return [isRed(f.tl) && isWhite(f.br) && isGreen(f.tr), `${fmt(f.tl)} ${fmt(f.br)} ${fmt(f.tr)}`];
  });
  check("chromaKeyRevealsBackground", () => {
    const keyed = clip({ id: "keyed", effects: [makeStaticEffect("key.chroma", { keyHue: 0.333, tolerance: 0.5, softness: 0.3, spill: 0 })] });
    const f = render(tl(vt(keyed), vt(clip({ id: "bg", transform: makeTransform({ flipHorizontal: true }) }))), 15);
    return [isRed(f.tr), fmt(f.tr)];
  });
  check("adjacentClipsBothRender", () => {
    const t = tl(vt(clip({ id: "c1", durationFrames: 30 }), clip({ id: "c2", startFrame: 30, durationFrames: 30, transform: makeTransform({ flipHorizontal: true }) })));
    const a = render(t, 29), b = render(t, 31);
    return [isRed(a.tl) && isGreen(b.tl), `${fmt(a.tl)} ${fmt(b.tl)}`];
  });
  check("halfQualityQuadrants", () => {
    const f = render(tl(vt(clip())), 15, [], 0.5);
    return [f.w === 160 && isRed(f.at(40, 22)) && isWhite(f.at(120, 67)), `${f.w}x${f.h} ${fmt(f.at(40, 22))}`];
  });

  // Port of NestRenderTests.
  const child = (): Timeline => tl(vt(clip()));
  const nest = (c: Timeline, p: Partial<Clip> = {}): Clip =>
    makeClip({ mediaRef: c.id, mediaType: "sequence", sourceClipType: "sequence", startFrame: 0, durationFrames: timelineTotalFrames(c), ...p });
  check("nestedPatternMatchesDirectRender", () => {
    const c = child();
    const f = render(tl(vt(nest(c))), 15, [c]);
    return [isRed(f.tl) && isWhite(f.br), `${fmt(f.tl)} ${fmt(f.br)}`];
  });
  check("nestOpacityDimsWholeGroup", () => {
    const c = child();
    const f = render(tl(vt(nest(c, { opacity: 0.5 }))), 15, [c]);
    return [f.br.r > 80 && f.br.r < 170, fmt(f.br)];
  });
  check("nestTransformScalesGroupAsUnit", () => {
    const c = child();
    const f = render(tl(vt(nest(c, { transform: makeTransform({ centerX: 0.25, centerY: 0.25, width: 0.5, height: 0.5 }) }))), 15, [c]);
    return [isBlack(f.at(300, 170)) && isRed(f.at(20, 10)), `${fmt(f.at(300, 170))} ${fmt(f.at(20, 10))}`];
  });
  check("nestOffsetInTimeShowsBlackBeforeStart", () => {
    const c = child();
    const t = tl(vt(nest(c, { startFrame: 30 })));
    const before = render(t, 15, [c]), during = render(t, 45, [c]);
    return [isBlack(before.center) && isRed(during.tl), `${fmt(before.center)} ${fmt(during.tl)}`];
  });
  check("twoLevelNestRendersThrough", () => {
    const g = child();
    const middle = tl(vt(nest(g)));
    const f = render(tl(vt(nest(middle))), 15, [g, middle]);
    return [isRed(f.tl) && isWhite(f.br), `${fmt(f.tl)} ${fmt(f.br)}`];
  });

  // Blend modes against the W3C reference at 0.75 opacity (fade of the blend result).
  const A = [51 / 255, 128 / 255, 204 / 255], B = [179 / 255, 77 / 255, 153 / 255];
  for (const mode of blendModes) {
    check(`blend ${mode}`, () => {
      const f = render(tl(vt(clip({ id: "top", mediaRef: "colorB", blendMode: mode, opacity: 0.75 })), vt(clip({ id: "bot", mediaRef: "colorA" }))), 15);
      const blended = blendRef(mode, A, B);
      const exp = A.map((a, i) => (a + ((blended[i] as number) - a) * 0.75) * 255);
      const got = f.center;
      const d = Math.max(Math.abs(got.r - (exp[0] as number)), Math.abs(got.g - (exp[1] as number)), Math.abs(got.b - (exp[2] as number)));
      return [d <= 2.5, `got ${fmt(got)} expected (${exp.map((v) => v.toFixed(1)).join(",")})`];
    });
  }

  // Effects at neutral parameters are identities (guarded effects use an epsilon so their shader actually runs).
  const neutral: Record<string, Effect | null> = {
    "color.exposure": makeStaticEffect("color.exposure", { ev: 0 }),
    "color.contrast": makeStaticEffect("color.contrast", { amount: 1 }),
    "color.saturation": makeStaticEffect("color.saturation", { amount: 1 }),
    "color.temperature": makeStaticEffect("color.temperature", { temperature: 6500, tint: 0 }),
    "color.highlightsShadows": makeStaticEffect("color.highlightsShadows", { highlights: 1e-4, shadows: 0 }),
    "color.blacksWhites": makeStaticEffect("color.blacksWhites", { blacks: 1e-4, whites: 0 }),
    "color.vibrance": makeStaticEffect("color.vibrance", { amount: 0 }),
    "color.wheels": makeStaticEffect("color.wheels", { lift_m: 1e-4, gamma_m: 1, gain_m: 1 }),
    "color.hueCurves": makeEffect({
      type: "color.hueCurves",
      params: { curves: makeEffectParam({ string: hueCurvesEncoded(makeHueCurves({ hueVsSat: [{ x: 0, y: 0.5002 }, { x: 0.5, y: 0.5002 }] })) }) },
    }),
    "color.lut": makeEffect({ type: "color.lut", params: { path: makeEffectParam({ string: "identity.cube" }), intensity: makeEffectParam({ value: 1 }) } }),
    "color.curves": makeEffect({
      type: "color.curves",
      params: { curve: makeEffectParam({ string: gradeCurveEncoded(makeGradeCurve({ master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] })) }) },
    }),
    "detail.clarity": makeStaticEffect("detail.clarity", { clarity: 1e-4, dehaze: 0 }),
    "key.chroma": makeStaticEffect("key.chroma", { keyHue: 0.333, tolerance: 1e-4, softness: 0, spill: 0 }),
    "blur.gaussian": makeStaticEffect("blur.gaussian", { radius: 1e-3 }),
    "blur.sharpen": makeStaticEffect("blur.sharpen", { amount: 0 }),
    "blur.noiseReduction": makeStaticEffect("blur.noiseReduction", { amount: 1e-4 }),
    "blur.motion": makeStaticEffect("blur.motion", { radius: 1e-3, angle: 0 }),
    "stylize.invert": null,
    "stylize.grain": makeStaticEffect("stylize.grain", { amount: 1e-4, size: 1.5 }),
    "stylize.vignette": makeStaticEffect("stylize.vignette", { amount: 1e-4, midpoint: 0.5, roundness: 0, feather: 0.5 }),
    "stylize.glow": makeStaticEffect("stylize.glow", { intensity: 1e-4, radius: 20, threshold: 0.6, warmth: 0 }),
  };
  const reference = render(tl(vt(clip({ mediaRef: "midtone" }))), 15);
  const probes: [number, number][] = [[80, 45], [240, 45], [80, 135], [240, 135]];
  for (const d of effectRegistryAll) {
    const effect = neutral[d.id];
    if (effect === undefined) {
      results.push({ name: `identity ${d.id}`, ok: false, detail: "no neutral parameters defined" });
      continue;
    }
    if (effect === null) continue;
    check(`identity ${d.id}`, () => {
      const f = render(tl(vt(clip({ mediaRef: "midtone", effects: [effect] }))), 15);
      const passes = comp.stats.passes;
      let worst = 0;
      for (const [x, y] of probes) {
        const a = f.at(x, y), b = reference.at(x, y);
        worst = Math.max(worst, Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
      }
      return [worst <= 3 && passes > 1, `max |Δ| = ${worst}, passes ${passes}`];
    });
  }

  // Effects at known parameters against the same formula in JS.
  const mid = [179 / 255, 110 / 255, 89 / 255];
  const known: [string, Effect, (c: number[]) => number[]][] = [
    ["invert", makeStaticEffect("stylize.invert"), (c) => c.map((v) => 1 - v)],
    ["exposure +1", makeStaticEffect("color.exposure", { ev: 1 }), (c) => c.map((v) => linearToSrgb(srgbToLinear(v) * 2))],
    ["saturation 0", makeStaticEffect("color.saturation", { amount: 0 }), (c) => {
      const l = 0.2125 * (c[0] as number) + 0.7154 * (c[1] as number) + 0.0721 * (c[2] as number);
      return [l, l, l];
    }],
    ["contrast 1.5", makeStaticEffect("color.contrast", { amount: 1.5 }), (c) => c.map((v) => (v - 0.5) * 1.5 + 0.5)],
  ];
  for (const [name, effect, fn] of known) {
    check(`effect ${name}`, () => {
      const f = render(tl(vt(clip({ mediaRef: "midtone", effects: [effect] }))), 15);
      const exp = fn(mid).map((v) => Math.min(1, Math.max(0, v)) * 255);
      const got = f.tl;
      const d = Math.max(Math.abs(got.r - (exp[0] as number)), Math.abs(got.g - (exp[1] as number)), Math.abs(got.b - (exp[2] as number)));
      return [d <= 2.5, `got ${fmt(got)} expected (${exp.map((v) => v.toFixed(1)).join(",")})`];
    });
  }

  // Text.
  const textClip = (p: Partial<Clip> = {}): Clip => makeClip({
    mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 60, textContent: "HELLO",
    textStyle: makeTextStyle({ fontSize: 300, isBold: true, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }) }),
    transform: makeTransform({ width: 0.9, height: 0.6 }), ...p,
  });
  const brightCount = (f: Frame): number => {
    let n = 0;
    for (let i = 0; i < f.px.length; i += 4) if ((f.px[i] as number) > 200 && (f.px[i + 1] as number) > 200 && (f.px[i + 2] as number) > 200) n += 1;
    return n;
  };
  check("text renders non-empty", () => {
    const n = brightCount(render(tl(vt(textClip())), 10));
    return [n > 500, `${n} bright pixels`];
  });
  check("text obeys track z-order", () => {
    const over = brightCount(render(tl(vt(textClip()), vt(clip({ mediaRef: "colorA" }))), 10));
    const under = brightCount(render(tl(vt(clip({ mediaRef: "colorA" })), vt(textClip())), 10));
    return [over > 500 && under === 0, `over ${over}, under ${under}`];
  });
  check("text rotation keeps glyphs", () => {
    const n = brightCount(render(tl(vt(textClip({ transform: makeTransform({ width: 0.9, height: 0.6, rotation: 30 }) }))), 10));
    return [n > 500, `${n}`];
  });
  check("text tilt keeps glyphs", () => {
    const n = brightCount(render(tl(vt(textClip({ transform: makeTransform({ width: 0.9, height: 0.6, rotationY: 40 }) }))), 10));
    return [n > 300, `${n}`];
  });
  check("text inverted fill is a white difference", () => {
    const f = render(tl(vt(textClip({ textFillMode: "inverted" })), vt(clip({ mediaRef: "colorA" }))), 10);
    let inverted = 0;
    for (let i = 0; i < f.px.length; i += 4) {
      if (Math.abs((f.px[i] as number) - 204) <= 3 && Math.abs((f.px[i + 1] as number) - 127) <= 3 && Math.abs((f.px[i + 2] as number) - 51) <= 3) inverted += 1;
    }
    return [inverted > 300, `${inverted} inverted pixels`];
  });
  check("text footage fill stencils footage through glyphs", () => {
    const f = render(tl(vt(textClip({ textFillMode: "footage", textStyle: makeTextStyle({ fontSize: 300, isBold: true, color: makeRGBA({ r: 0, g: 0, b: 0, a: 1 }) }) })), vt(clip({ mediaRef: "colorA" }))), 10);
    let footage = 0, matte = 0;
    for (let i = 0; i < f.px.length; i += 4) {
      const r = f.px[i] as number, g = f.px[i + 1] as number;
      if (Math.abs(r - 51) <= 3 && Math.abs(g - 128) <= 3) footage += 1;
      if (r < 5 && g < 5) matte += 1;
    }
    return [footage > 300 && matte > W * H * 0.4, `footage ${footage}, matte ${matte}`];
  });
  check("text gaussian blur softens", () => {
    const sharp = brightCount(render(tl(vt(textClip())), 10));
    const blurred = brightCount(render(tl(vt(textClip({ textStyle: makeTextStyle({ fontSize: 300, isBold: true, blur: 6, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }) }) }))), 10));
    return [blurred < sharp * 0.8, `sharp ${sharp}, blurred ${blurred}`];
  });

  comp.dispose();
  return results;
}
