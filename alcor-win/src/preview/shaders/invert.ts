import { fragmentShader } from "./common";

// CIColorMatrix with rgb = 1 - rgb, alpha kept; straight-alpha display-encoded values.
export const invertFrag = fragmentShader(`
void main() {
  vec4 s = texture(uImage, vUv);
  outColor = vec4(1.0 - s.rgb, s.a);
}
`);
