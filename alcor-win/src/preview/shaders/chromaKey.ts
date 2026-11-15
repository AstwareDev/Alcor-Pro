import { fragmentShader } from "./common";

// Port of Metal/ChromaKey.metal. Straight (unpremultiplied) alpha in/out, display-encoded values, no colour management.
export const chromaKeyFrag = fragmentShader(`
uniform float uKeyHue;
uniform float uTolerance;
uniform float uSoftness;
uniform float uSpill;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 rgb = s.rgb;
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float dd = mx - mn;
  float sat = mx <= 1e-5 ? 0.0 : dd / mx;
  float hue = 0.0;
  if (dd > 1e-5) {
    if (mx == rgb.r) hue = (rgb.g - rgb.b) / dd;
    else if (mx == rgb.g) hue = (rgb.b - rgb.r) / dd + 2.0;
    else hue = (rgb.r - rgb.g) / dd + 4.0;
    hue = fract(hue / 6.0);
  }
  float hd = abs(hue - uKeyHue);
  hd = min(hd, 1.0 - hd);
  float inner = uTolerance * 0.25;
  float key = (1.0 - smoothstep(inner, inner + uSoftness * 0.3 + 0.02, hd))
            * smoothstep(0.12, 0.32, sat)
            * smoothstep(0.04, 0.12, dd);
  float y = dot(rgb, LUMA709);
  rgb = mix(rgb, vec3(y), uSpill * key);
  outColor = vec4(rgb, s.a * (1.0 - key));
}
`);
