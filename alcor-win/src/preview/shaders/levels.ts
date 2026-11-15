import { fragmentShader } from "./common";

// Port of Metal/Levels.metal. Display-encoded values, straight alpha.
export const levelsFrag = fragmentShader(`
uniform float uBlacks;
uniform float uWhites;

void main() {
  vec4 s = texture(uImage, vUv);
  float bp = -uBlacks * 0.4;
  float wp = 1.0 - uWhites * 0.4;
  outColor = vec4(saturate((s.rgb - bp) / max(0.05, wp - bp)), s.a);
}
`);
