import { fragmentShader } from "./common";

// Port of Metal/Wheels.metal. Display-encoded values, straight alpha.
export const wheelsFrag = fragmentShader(`
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uInvGamma;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 lit = max(s.rgb * (1.0 - uLift) + uLift, vec3(0.0)) * uGain;
  outColor = vec4(saturate(pow(lit, uInvGamma)), s.a);
}
`);
