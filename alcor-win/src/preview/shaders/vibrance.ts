import { fragmentShader } from "./common";

// Approximation of CIVibrance (glfx-style: pushes low-chroma pixels toward/away from their max channel) on display-encoded straight-alpha values.
export const vibranceFrag = fragmentShader(`
uniform float uAmount;

void main() {
  vec4 s = texture(uImage, vUv);
  float average = (s.r + s.g + s.b) / 3.0;
  float mx = max(s.r, max(s.g, s.b));
  float amt = (mx - average) * (-uAmount * 3.0);
  outColor = vec4(mix(s.rgb, vec3(mx), amt), s.a);
}
`);
