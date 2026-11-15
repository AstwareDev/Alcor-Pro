// vUv is texture-memory space: (0,0) = first row of the uploaded image (its top); FBO passes use the same space, so only the final present flips Y.
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uResolution;
out vec4 outColor;
`;

/** Rec.709 luma weights (the Metal kernels' float3(0.2126, 0.7152, 0.0722)), saturate(), and the extended-range sRGB transfer. */
export const GLSL_COMMON = `
const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA709); }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float srgbToLinear(float c) {
  float a = abs(c);
  return sign(c) * (a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4));
}
float linearToSrgb(float c) {
  float a = abs(c);
  return sign(c) * (a <= 0.0031308 ? a * 12.92 : 1.055 * pow(a, 1.0 / 2.4) - 0.055);
}
vec3 srgbToLinear(vec3 c) { return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)); }
vec3 linearToSrgb(vec3 c) { return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b)); }
vec2 clampUv(vec2 uv) { vec2 h = 0.5 / uResolution; return clamp(uv, h, 1.0 - h); }
`;

export function fragmentShader(body: string): string {
  return FRAGMENT_HEADER + GLSL_COMMON + body;
}
