import { fragmentShader } from "./common";

// Approximation of CIColorControls (saturation, brightness, contrast in that order; CI luma weights) on display-encoded straight-alpha values, unclamped like CI.
export const colorControlsFrag = fragmentShader(`
uniform float uSaturation;
uniform float uBrightness;
uniform float uContrast;

void main() {
  vec4 s = texture(uImage, vUv);
  float lum = dot(s.rgb, vec3(0.2125, 0.7154, 0.0721));
  vec3 rgb = mix(vec3(lum), s.rgb, uSaturation);
  rgb += uBrightness;
  rgb = (rgb - 0.5) * uContrast + 0.5;
  outColor = vec4(rgb, s.a);
}
`);
