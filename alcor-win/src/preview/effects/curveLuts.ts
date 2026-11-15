import { gradeCurveEval, type GradeCurve } from "../../model/gradeCurve";
import { hueCurvesEval, type HueCurves } from "../../model/hueCurves";

export const gradeCurveLutWidth = 256;
export const hueCurveLutWidth = 256;
const maxHueShift = 1 / 12; // ±30° at a full push
const maxLumShift = 0.5;

const cl = (v: number): number => Math.fround(Math.min(1, Math.max(0, v)));

/** `GradeCurveKernel.buildLUTs`: two 256x1 RGBA float rows. channels = R/G/B curves, master = luma curve replicated to RGB. */
export function buildGradeCurveLUTs(c: GradeCurve): { channels: Float32Array; master: Float32Array } {
  const w = gradeCurveLutWidth;
  const channels = new Float32Array(w * 4);
  const master = new Float32Array(w * 4);
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    channels[x * 4] = cl(gradeCurveEval(c.red, t));
    channels[x * 4 + 1] = cl(gradeCurveEval(c.green, t));
    channels[x * 4 + 2] = cl(gradeCurveEval(c.blue, t));
    channels[x * 4 + 3] = 1;
    const m = cl(gradeCurveEval(c.master, t));
    master[x * 4] = m;
    master[x * 4 + 1] = m;
    master[x * 4 + 2] = m;
    master[x * 4 + 3] = 1;
  }
  return { channels, master };
}

/** `HueCurveKernel.buildLUT`: 256x1 RGBA float (R=Δhue, G=satScale, B=Δlum). */
export function buildHueCurveLUT(curves: HueCurves): Float32Array {
  const w = hueCurveLutWidth;
  const px = new Float32Array(w * 4);
  for (let i = 0; i < w; i++) {
    const hue = (i + 0.5) / w;
    px[i * 4] = (hueCurvesEval(curves.hueVsHue, hue) - 0.5) * 2 * maxHueShift;
    px[i * 4 + 1] = (hueCurvesEval(curves.hueVsSat, hue) - 0.5) * 2;
    px[i * 4 + 2] = (hueCurvesEval(curves.hueVsLum, hue) - 0.5) * 2 * maxLumShift;
    px[i * 4 + 3] = 1;
  }
  return px;
}
