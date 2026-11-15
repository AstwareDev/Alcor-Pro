/** Port of the tail of `VideoEngine.sampleKeyHue`: HSB hue (0...1) of an RGB colour, nil when too grey to key. */
export const minKeySaturation = 0.12;

export function keyHueFromRGB(r: number, g: number, b: number): number | undefined {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  if (saturation < minKeySaturation) return undefined;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue /= 6;
  return hue < 0 ? hue + 1 : hue;
}
