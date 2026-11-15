import { fragmentShader } from "./common";

// Approximation of CISRGBToneCurveToLinear -> CIExposureAdjust (rgb * 2^ev) -> CILinearToSRGBToneCurve on display-encoded straight-alpha values.
export const exposureFrag = fragmentShader(`
uniform float uEv;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 lin = srgbToLinear(s.rgb) * exp2(uEv);
  outColor = vec4(linearToSrgb(lin), s.a);
}
`);
