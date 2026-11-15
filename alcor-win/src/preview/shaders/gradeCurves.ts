import { fragmentShader } from "./common";

// Port of Metal/GradeCurves.metal. Display-encoded values. Two 256x1 RGBA float LUTs, LINEAR + CLAMP_TO_EDGE (Metal's x*256 pixel coord == u = x).
export const gradeCurvesFrag = fragmentShader(`
uniform sampler2D uLutCh;
uniform sampler2D uLutMaster;

void main() {
  vec4 s = texture(uImage, vUv);
  vec3 rgb = saturate(s.rgb);
  float y = dot(rgb, LUMA709);
  float yp = texture(uLutMaster, vec2(y, 0.5)).r;
  rgb = (y > 1e-4) ? rgb * min(yp / y, 8.0) : vec3(yp);
  float r = texture(uLutCh, vec2(rgb.r, 0.5)).r;
  float g = texture(uLutCh, vec2(rgb.g, 0.5)).g;
  float b = texture(uLutCh, vec2(rgb.b, 0.5)).b;
  outColor = vec4(r, g, b, s.a);
}
`);
