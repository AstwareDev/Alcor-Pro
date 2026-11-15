import { fragmentShader } from "./common";

// Port of Metal/Glow.metal. Straight alpha, display-encoded values; the blur between the two passes is gaussianBlur (no premultiply).
export const glowBrightFrag = fragmentShader(`
uniform float uThreshold;
uniform float uWarmth;

void main() {
  vec4 s = texture(uImage, vUv);
  float y = dot(s.rgb, LUMA709);
  vec3 hi = s.rgb * smoothstep(uThreshold, 1.0, y);
  vec3 warm = hi * vec3(1.0, 0.7, 0.45);
  outColor = vec4(mix(hi, warm, uWarmth), s.a);
}
`);

export const glowCompositeFrag = fragmentShader(`
uniform sampler2D uGlow;
uniform float uIntensity;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 g = saturate(texture(uGlow, vUv).rgb * uIntensity);
  outColor = vec4(1.0 - (1.0 - s.rgb) * (1.0 - g), s.a);
}
`);
