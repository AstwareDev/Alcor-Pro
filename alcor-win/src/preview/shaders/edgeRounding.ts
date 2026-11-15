import { fragmentShader } from "./common";

// Port of Metal/EdgeRounding.metal. Rect is the whole target (origin-independent); straight alpha, only alpha changes.
export const edgeRoundingFrag = fragmentShader(`
uniform float uEdgeRounding;
uniform float uEdgeSoftness;

void main() {
  vec4 s = texture(uImage, vUv);
  float m = min(uResolution.x, uResolution.y);
  float radius = saturate(uEdgeRounding) * m * 0.5;
  float feather = saturate(uEdgeSoftness) * m * 0.5;
  vec2 center = uResolution * 0.5;
  vec2 insetHalfSize = uResolution * 0.5 - radius;
  vec2 q = abs(vUv * uResolution - center) - insetHalfSize;
  float dist = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  float coverage = 1.0 - smoothstep(-0.5 - feather, 0.5, dist);
  outColor = vec4(s.rgb, s.a * coverage);
}
`);
