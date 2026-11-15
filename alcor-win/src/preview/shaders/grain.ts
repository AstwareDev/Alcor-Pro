import { fragmentShader } from "./common";

// Port of Metal/Grain.metal. Display-encoded values; noise coords use Core Image's bottom-up pixel-centre space so the pattern matches.
export const grainFrag = fragmentShader(`
uniform float uAmount;
uniform float uSize;
uniform float uFrame;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 s = texture(uImage, vUv);
  vec2 px = vUv * uResolution;
  vec2 dest = vec2(px.x, uResolution.y - px.y);
  vec2 co = dest / max(uSize, 0.5);
  float n = hash13(vec3(co, uFrame)) - 0.5;
  float y = dot(s.rgb, LUMA709);
  float lumaMask = 4.0 * y * (1.0 - y);
  outColor = vec4(saturate(s.rgb + n * uAmount * 0.35 * lumaMask), s.a);
}
`);
