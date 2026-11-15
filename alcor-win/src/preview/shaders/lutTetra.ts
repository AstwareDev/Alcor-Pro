import { fragmentShader } from "./common";

// Port of Metal/LUTTetra.metal. Display-encoded values. uLut = n x n^2 RGBA float strip, node (r,g,b) at texel (r, b*n+g), data row 0 = texel row 0 (UNPACK_FLIP_Y off), fetched with texelFetch.
export const lutTetraFrag = fragmentShader(`
uniform sampler2D uLut;
uniform float uSize;
uniform float uIntensity;

vec3 fetchNode(vec3 idx) {
  float row = idx.z * uSize + idx.y;
  return texelFetch(uLut, ivec2(int(idx.x + 0.5), int(row + 0.5)), 0).rgb;
}

void main() {
  vec4 s = texture(uImage, vUv);
  float n = uSize;
  vec3 rgb = saturate(s.rgb);
  vec3 p = rgb * (n - 1.0);
  vec3 b0 = clamp(floor(p), 0.0, n - 2.0);
  vec3 f = p - b0;

  vec3 c000 = fetchNode(b0);
  vec3 c111 = fetchNode(b0 + 1.0);
  vec3 o;
  if (f.r >= f.g) {
    if (f.g >= f.b) {
      o = (1.0 - f.r) * c000 + (f.r - f.g) * fetchNode(b0 + vec3(1.0, 0.0, 0.0))
        + (f.g - f.b) * fetchNode(b0 + vec3(1.0, 1.0, 0.0)) + f.b * c111;
    } else if (f.r >= f.b) {
      o = (1.0 - f.r) * c000 + (f.r - f.b) * fetchNode(b0 + vec3(1.0, 0.0, 0.0))
        + (f.b - f.g) * fetchNode(b0 + vec3(1.0, 0.0, 1.0)) + f.g * c111;
    } else {
      o = (1.0 - f.b) * c000 + (f.b - f.r) * fetchNode(b0 + vec3(0.0, 0.0, 1.0))
        + (f.r - f.g) * fetchNode(b0 + vec3(1.0, 0.0, 1.0)) + f.g * c111;
    }
  } else {
    if (f.b >= f.g) {
      o = (1.0 - f.b) * c000 + (f.b - f.g) * fetchNode(b0 + vec3(0.0, 0.0, 1.0))
        + (f.g - f.r) * fetchNode(b0 + vec3(0.0, 1.0, 1.0)) + f.r * c111;
    } else if (f.b >= f.r) {
      o = (1.0 - f.g) * c000 + (f.g - f.b) * fetchNode(b0 + vec3(0.0, 1.0, 0.0))
        + (f.b - f.r) * fetchNode(b0 + vec3(0.0, 1.0, 1.0)) + f.r * c111;
    } else {
      o = (1.0 - f.g) * c000 + (f.g - f.r) * fetchNode(b0 + vec3(0.0, 1.0, 0.0))
        + (f.r - f.b) * fetchNode(b0 + vec3(1.0, 1.0, 0.0)) + f.b * c111;
    }
  }
  outColor = vec4(mix(s.rgb, o, uIntensity), s.a);
}
`);
