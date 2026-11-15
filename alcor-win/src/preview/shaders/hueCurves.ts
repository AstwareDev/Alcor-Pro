import { fragmentShader } from "./common";

// Port of Metal/HueCurves.metal. Display-space HSV; uLut is a 256x1 RGBA float LUT (R=dHue, G=satScale, B=dLum), LINEAR + CLAMP_TO_EDGE.
export const hueCurvesFrag = fragmentShader(`
uniform sampler2D uLut;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, saturate(p - K.xxx), c.y);
}

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 hsv = rgb2hsv(saturate(s.rgb));
  vec4 L = texture(uLut, vec2(hsv.x, 0.5));
  float gate = smoothstep(0.04, 0.18, hsv.y);
  float h2 = fract(hsv.x + L.r * gate);
  float s2 = saturate(hsv.y * (1.0 + L.g * gate));
  float v2 = saturate(hsv.z + L.b * gate);
  outColor = vec4(hsv2rgb(vec3(h2, s2, v2)), s.a);
}
`);
