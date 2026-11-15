import { fragmentShader } from "./common";

// Port of Metal/Clarity.metal (clarityHaze). Straight alpha, display-encoded values. uBlurred = Gaussian blur of uImage (see effectPasses).
export const clarityHazeFrag = fragmentShader(`
uniform sampler2D uBlurred;
uniform float uClarity;
uniform float uDehaze;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 b = texture(uBlurred, vUv).rgb;
  vec3 rgb = s.rgb + (s.rgb - b) * uClarity;
  if (uDehaze != 0.0) {
    float dark = min(s.rgb.r, min(s.rgb.g, s.rgb.b));
    float w = uDehaze * (0.5 + 0.5 * smoothstep(0.05, 0.5, dark));
    rgb += (s.rgb - b) * (w * 0.6);
    rgb = mix(vec3(0.45), rgb, 1.0 + w * 0.45);
    float yy = dot(rgb, LUMA709);
    rgb = mix(vec3(yy), rgb, 1.0 + w * 0.5);
  }
  outColor = vec4(saturate(rgb), s.a);
}
`);
