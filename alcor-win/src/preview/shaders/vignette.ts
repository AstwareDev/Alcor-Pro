import { fragmentShader } from "./common";

// Port of Metal/Vignette.metal. Rect is the whole target; display-encoded values, straight alpha.
export const vignetteFrag = fragmentShader(`
uniform float uAmount;
uniform float uMidpoint;
uniform float uRoundness;
uniform float uFeather;

void main() {
  vec4 s = texture(uImage, vUv);
  vec2 center = uResolution * 0.5;
  vec2 d = (vUv * uResolution - center) / max(uResolution * 0.5, vec2(1.0));
  float p = mix(6.0, 2.0, (uRoundness + 1.0) * 0.5);
  float dist = pow(pow(abs(d.x), p) + pow(abs(d.y), p), 1.0 / p);
  float v = smoothstep(uMidpoint, uMidpoint + uFeather * 1.5 + 0.05, dist);
  outColor = vec4(saturate(s.rgb * (1.0 + uAmount * v)), s.a);
}
`);
