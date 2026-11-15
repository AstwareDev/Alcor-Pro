import { transitionKinds, type TransitionKind } from "../model/transition";

/** `uKind` of a transition kind in `transitionFrag`. */
export function transitionKindIndex(kind: TransitionKind): number {
  return transitionKinds.indexOf(kind);
}

/**
 * Blends two premultiplied layer images (`uFrom` outgoing, `uTo` incoming, both full-canvas, top-left origin like every
 * accumulator) at `uProgress` 0…1. Output is premultiplied; the compositor draws it source-over onto the track below.
 * Kind order = `transitionKinds`: 0 crossDissolve, 1 dipToBlack, 2 dipToWhite, 3-6 wipe L/R/U/D, 7-10 push L/R/U/D,
 * 11 zoomIn, 12 blurDissolve, 13 irisCircle.
 */
export const transitionFrag = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform int uKind;
uniform vec2 uResolution;
out vec4 outColor;

const float soft = 0.01;

float ease(float t) { return t * t * (3.0 - 2.0 * t); }

vec4 wipe(vec4 a, vec4 b, float pos, float coord, bool towardsHigh) {
  // The edge travels from one side to the other; the incoming clip is on the side it has passed.
  float m = smoothstep(pos - soft, pos + soft, coord);
  return mix(a, b, towardsHigh ? 1.0 - m : m);
}

vec4 push(vec2 uv, vec2 dir, float p) {
  vec2 q = uv + dir * p;
  bool inFrom = q.x >= 0.0 && q.x < 1.0 && q.y >= 0.0 && q.y < 1.0;
  return inFrom ? texture(uFrom, q) : texture(uTo, q - dir);
}

vec4 zoomFrom(vec2 uv, float s) { return texture(uFrom, (uv - 0.5) / s + 0.5); }
vec4 zoomTo(vec2 uv, float s) { return texture(uTo, (uv - 0.5) / s + 0.5); }

vec4 blurred(sampler2D tex, vec2 uv, float radius) {
  vec2 px = radius * vec2(uResolution.y / uResolution.x, 1.0);
  vec4 sum = texture(tex, uv) * 2.0;
  sum += texture(tex, uv + px * vec2(1.0, 0.0));
  sum += texture(tex, uv + px * vec2(-1.0, 0.0));
  sum += texture(tex, uv + px * vec2(0.0, 1.0));
  sum += texture(tex, uv + px * vec2(0.0, -1.0));
  sum += texture(tex, uv + px * vec2(0.7071, 0.7071));
  sum += texture(tex, uv + px * vec2(-0.7071, 0.7071));
  sum += texture(tex, uv + px * vec2(0.7071, -0.7071));
  sum += texture(tex, uv + px * vec2(-0.7071, -0.7071));
  sum += texture(tex, uv + px * vec2(2.0, 0.0)) * 0.5;
  sum += texture(tex, uv + px * vec2(-2.0, 0.0)) * 0.5;
  sum += texture(tex, uv + px * vec2(0.0, 2.0)) * 0.5;
  sum += texture(tex, uv + px * vec2(0.0, -2.0)) * 0.5;
  return sum / 12.0;
}

void main() {
  vec2 uv = vUv;
  float p = clamp(uProgress, 0.0, 1.0);
  if (uKind == 0) {
    outColor = mix(texture(uFrom, uv), texture(uTo, uv), p);
  } else if (uKind == 1 || uKind == 2) {
    vec4 dip = uKind == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    outColor = p < 0.5 ? mix(texture(uFrom, uv), dip, p * 2.0) : mix(dip, texture(uTo, uv), p * 2.0 - 1.0);
  } else if (uKind <= 6) {
    vec4 a = texture(uFrom, uv);
    vec4 b = texture(uTo, uv);
    float travel = mix(-soft, 1.0 + soft, p);
    if (uKind == 3) outColor = wipe(a, b, 1.0 - travel, uv.x, false);
    else if (uKind == 4) outColor = wipe(a, b, travel, uv.x, true);
    else if (uKind == 5) outColor = wipe(a, b, 1.0 - travel, uv.y, false);
    else outColor = wipe(a, b, travel, uv.y, true);
  } else if (uKind <= 10) {
    float e = ease(p);
    vec2 dir = uKind == 7 ? vec2(1.0, 0.0) : uKind == 8 ? vec2(-1.0, 0.0) : uKind == 9 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
    outColor = push(uv, dir, e);
  } else if (uKind == 11) {
    float e = ease(p);
    outColor = mix(zoomFrom(uv, 1.0 + e * 0.6), zoomTo(uv, 1.6 - e * 0.6), e);
  } else if (uKind == 12) {
    float r = sin(p * 3.14159265) * 0.02;
    outColor = mix(blurred(uFrom, uv, r), blurred(uTo, uv, r), ease(p));
  } else {
    float aspect = uResolution.x / uResolution.y;
    float d = length((uv - 0.5) * vec2(aspect, 1.0));
    float maxR = 0.5 * length(vec2(aspect, 1.0));
    float r = mix(-soft, maxR + soft, ease(p));
    float m = 1.0 - smoothstep(r - soft, r + soft, d);
    outColor = mix(texture(uFrom, uv), texture(uTo, uv), m);
  }
}
`;
