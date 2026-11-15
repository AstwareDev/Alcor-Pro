import { chromaKeyFrag } from "./chromaKey";
import { clarityHazeFrag } from "./clarity";
import { colorControlsFrag } from "./colorControls";
import { edgeRoundingFrag } from "./edgeRounding";
import { exposureFrag } from "./exposure";
import { gaussianBlurFrag } from "./gaussianBlur";
import { glowBrightFrag, glowCompositeFrag } from "./glow";
import { gradeCurvesFrag } from "./gradeCurves";
import { grainFrag } from "./grain";
import { highlightsShadowsFrag } from "./highlightsShadows";
import { hueCurvesFrag } from "./hueCurves";
import { invertFrag } from "./invert";
import { levelsFrag } from "./levels";
import { lutTetraFrag } from "./lutTetra";
import { motionBlurFrag } from "./motionBlur";
import { noiseReductionFrag } from "./noiseReduction";
import { sharpenLuminanceFrag } from "./sharpenLuminance";
import { temperatureTintFrag } from "./temperatureTint";
import { vibranceFrag } from "./vibrance";
import { vignetteFrag } from "./vignette";
import { wheelsFrag } from "./wheels";

export { FULLSCREEN_VERTEX_SHADER } from "./common";

/** Shader name (RenderPass.shader) -> GLSL ES 3.00 fragment source. Names of Metal-kernel ports match the Metal function names. */
export const SHADERS: Record<string, string> = {
  chromaKey: chromaKeyFrag,
  clarityHaze: clarityHazeFrag,
  colorControls: colorControlsFrag,
  edgeRounding: edgeRoundingFrag,
  exposure: exposureFrag,
  gaussianBlur: gaussianBlurFrag,
  glowBright: glowBrightFrag,
  glowComposite: glowCompositeFrag,
  gradeCurves: gradeCurvesFrag,
  grain: grainFrag,
  highlightsShadows: highlightsShadowsFrag,
  hueCurves: hueCurvesFrag,
  invert: invertFrag,
  levels: levelsFrag,
  lutTetra: lutTetraFrag,
  motionBlur: motionBlurFrag,
  noiseReduction: noiseReductionFrag,
  sharpenLuminance: sharpenLuminanceFrag,
  temperatureTint: temperatureTintFrag,
  vibrance: vibranceFrag,
  vignette: vignetteFrag,
  wheels: wheelsFrag,
};
