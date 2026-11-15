import { fragmentShader } from "./common";

// Port of Metal/HighlightsShadows.metal. Display-encoded values, straight alpha.
export const highlightsShadowsFrag = fragmentShader(`
uniform float uHighlights;
uniform float uShadows;

void main() {
  vec4 s = texture(uImage, vUv);
  float y = dot(saturate(s.rgb), LUMA709);
  float hi = y * y * y;
  float lo = (1.0 - y) * (1.0 - y) * (1.0 - y);
  float dY = (uHighlights * hi + uShadows * lo) * 0.5;
  outColor = vec4(saturate(s.rgb + dY), s.a);
}
`);
