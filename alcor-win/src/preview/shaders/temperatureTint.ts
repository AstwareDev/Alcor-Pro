import { fragmentShader } from "./common";

// Approximation of CITemperatureAndTint: per-channel gain (computed in effectPasses from the neutral/target white points) applied to display-encoded values.
export const temperatureTintFrag = fragmentShader(`
uniform vec3 uGain;

void main() {
  vec4 s = texture(uImage, vUv);
  outColor = vec4(s.rgb * uGain, s.a);
}
`);
