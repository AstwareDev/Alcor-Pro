import { fragmentShader } from "./common";

// Approximation of CIMotionBlur: box blur along a line of +-radius px at uAngle radians (CI convention: counter-clockwise, y up), edges clamped.
export const motionBlurFrag = fragmentShader(`
uniform float uRadius;
uniform float uAngle;

void main() {
  vec2 dir = vec2(cos(uAngle), -sin(uAngle)) / uResolution;
  float taps = clamp(ceil(uRadius * 2.0) + 1.0, 3.0, 129.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 129; i++) {
    if (float(i) >= taps) break;
    float t = taps > 1.0 ? (float(i) / (taps - 1.0)) * 2.0 - 1.0 : 0.0;
    acc += texture(uImage, clampUv(vUv + dir * (t * uRadius)));
  }
  outColor = acc / taps;
}
`);
