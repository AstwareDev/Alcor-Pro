import { fragmentShader } from "./common";

// Approximation of CISharpenLuminance: unsharp mask of luma only (5x5 Gaussian, sigma = radius/2), chroma untouched; edges clamped.
export const sharpenLuminanceFrag = fragmentShader(`
uniform float uSharpness;
uniform float uRadius;

void main() {
  vec4 s = texture(uImage, vUv);
  float sigma = max(uRadius * 0.5, 0.01);
  vec2 px = 1.0 / uResolution;
  float acc = 0.0;
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float w = exp(-0.5 * float(i * i + j * j) / (sigma * sigma));
      acc += luma(texture(uImage, clampUv(vUv + vec2(float(i), float(j)) * px)).rgb) * w;
      wsum += w;
    }
  }
  float y = luma(s.rgb);
  float d = uSharpness * (y - acc / wsum);
  outColor = vec4(s.rgb + d, s.a);
}
`);
