import { fragmentShader } from "./common";

// Approximation of CIGaussianBlur (radius == sigma) as one separable pass with edge clamping (clampedToExtent). Run twice (H then V); optional premultiply on read / unpremultiply on write.
export const gaussianBlurFrag = fragmentShader(`
uniform float uSigma;
uniform vec2 uDirection;
uniform float uPremultiplyIn;
uniform float uUnpremultiplyOut;

vec4 fetchTap(vec2 uv) {
  vec4 c = texture(uImage, clampUv(uv));
  if (uPremultiplyIn > 0.5) c.rgb *= c.a;
  return c;
}

void main() {
  float radius = ceil(uSigma * 3.0);
  float stride = max(1.0, radius / 32.0);
  vec2 stepUv = uDirection / uResolution;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -32; i <= 32; i++) {
    float o = float(i) * stride;
    if (abs(o) > radius) continue;
    float w = exp(-0.5 * (o * o) / (uSigma * uSigma));
    acc += fetchTap(vUv + stepUv * o) * w;
    wsum += w;
  }
  vec4 c = acc / wsum;
  if (uUnpremultiplyOut > 0.5) c.rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  outColor = c;
}
`);
