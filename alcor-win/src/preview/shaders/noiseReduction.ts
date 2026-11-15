import { fragmentShader } from "./common";

// Loose approximation of CINoiseReduction: 3x3 luma-thresholded (bilateral-style) smoothing below uNoiseLevel, then a small unsharp by uSharpness. Edges clamped.
export const noiseReductionFrag = fragmentShader(`
uniform float uNoiseLevel;
uniform float uSharpness;

void main() {
  vec4 s = texture(uImage, vUv);
  vec2 px = 1.0 / uResolution;
  float yc = luma(s.rgb);
  vec3 acc = s.rgb;
  float wsum = 1.0;
  vec3 mean = s.rgb;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec3 n = texture(uImage, clampUv(vUv + vec2(float(i), float(j)) * px)).rgb;
      float w = 1.0 - smoothstep(uNoiseLevel, uNoiseLevel * 2.0 + 1e-5, abs(luma(n) - yc));
      acc += n * w;
      wsum += w;
      mean += n;
    }
  }
  vec3 den = acc / wsum;
  vec3 rgb = den + uSharpness * (den - mean / 9.0);
  outColor = vec4(rgb, s.a);
}
`);
