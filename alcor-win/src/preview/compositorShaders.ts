import { blendModes, type BlendMode } from "../model/blendMode";

/** `uMode` index of a blend mode (0 = normal / source-over). */
export function blendModeIndex(mode: BlendMode): number {
  return blendModes.indexOf(mode);
}

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/**
 * Places one layer: dest pixel → layer pixel through `uInv` (projective), coverage-antialiased against the visible rect
 * like bilinear sampling over a transparent border. Straight or premultiplied input; premultiplied output.
 * Non-normal modes read the destination copy and fade the blend result by opacity (FrameRenderer.blend).
 */
export const compositeFrag = `${header}
uniform sampler2D uSrc;
uniform sampler2D uDst;
uniform mat3 uInv;
uniform vec4 uRegion;
uniform vec4 uVisible;
uniform float uOpacity;
uniform int uMode;
uniform int uSrcPremul;
uniform int uForceWhite;
uniform sampler2D uMask;
uniform vec4 uMaskRect;
uniform int uMaskOn;
out vec4 outColor;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float range = mx - mn;
  if (range <= 1e-6) return vec3(0.0);
  return (c - mn) * s / range;
}
float dodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float burn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float hardLight(float b, float s) {
  return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0);
}
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 blendFn(int m, vec3 b, vec3 s) {
  if (m == 1) return min(b, s);
  if (m == 2) return b * s;
  if (m == 3) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (m == 4) return max(b, s);
  if (m == 5) return b + s - b * s;
  if (m == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (m == 7) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (m == 8) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (m == 9) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  if (m == 12) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 13) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 14) return setLum(s, lum(b));
  return setLum(b, lum(s));
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 h = uInv * vec3(p, 1.0);
  vec2 lp = h.xy / h.z;
  vec2 fw = max(fwidth(lp), vec2(1.0));
  vec2 lo = (lp - uVisible.xy) / fw;
  vec2 hi = (uVisible.xy + uVisible.zw - lp) / fw;
  vec2 c = clamp(min(lo, hi) + 0.5, 0.0, 1.0);
  float cov = h.z > 0.0 ? c.x * c.y : 0.0;
  vec4 s = texture(uSrc, (lp - uRegion.xy) / uRegion.zw);
  if (uSrcPremul == 0) s.rgb *= s.a;
  if (uForceWhite == 1) s.rgb = vec3(s.a);
  s *= cov;
  if (uMaskOn == 1) s *= texture(uMask, (lp - uMaskRect.xy) / uMaskRect.zw).a;
  if (uMode == 0) {
    outColor = s * uOpacity;
    return;
  }
  vec4 d = texelFetch(uDst, ivec2(p), 0);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 res = (1.0 - s.a) * d.rgb + s.a * blendFn(uMode, d.rgb, cs);
  outColor = vec4(mix(d.rgb, res, uOpacity), d.a);
}
`;

/** Copies a sub-rectangle of a source texture into an effect target, unpremultiplying if needed. */
export const prepFrag = `${header}
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec4 uUvRect;
uniform int uSrcPremul;
out vec4 outColor;
void main() {
  vec4 s = texture(uSrc, uUvRect.xy + vUv * uUvRect.zw);
  if (uSrcPremul == 1) s.rgb = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  outColor = s;
}
`;

/** Accumulator → canvas (flipped: the default framebuffer's first row is the bottom) or readback (unflipped). */
export const presentFrag = `${header}
in vec2 vUv;
uniform sampler2D uSrc;
uniform int uFlip;
out vec4 outColor;
void main() {
  vec2 uv = uFlip == 1 ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  outColor = vec4(texture(uSrc, uv).rgb, 1.0);
}
`;

/** Footage fill (CIBlendWithMask): footage inside the glyph mask, the matte colour over footage outside. */
export const stencilFrag = `${header}
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec4 acc = texture(uSrc, vUv);
  vec4 mask = texture(uMask, vUv);
  vec3 matte = mix(acc.rgb, uColor.rgb, uColor.a);
  float m = clamp(dot(mask.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  outColor = vec4(mix(matte, acc.rgb, m), 1.0);
}
`;
