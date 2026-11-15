import { decodeEnum } from "../util/jsonDecode";

/** How a visual clip composites over the layers below it. `normal` = source-over. */
export const blendModes = [
  "normal", "darken", "multiply", "colorBurn", "lighten", "screen", "colorDodge",
  "overlay", "softLight", "hardLight", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
] as const;

export type BlendMode = (typeof blendModes)[number];

const displayNames: Record<BlendMode, string> = {
  normal: "Normal",
  darken: "Darken",
  multiply: "Multiply",
  colorBurn: "Color Burn",
  lighten: "Lighten",
  screen: "Screen",
  colorDodge: "Color Dodge",
  overlay: "Overlay",
  softLight: "Soft Light",
  hardLight: "Hard Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

// L10n.key(...) returns the English key itself; localization is applied by the UI layer.
export function blendModeDisplayName(mode: BlendMode): string {
  return displayNames[mode];
}

const ciFilterNames: Record<BlendMode, string | undefined> = {
  normal: undefined,
  darken: "CIDarkenBlendMode",
  multiply: "CIMultiplyBlendMode",
  colorBurn: "CIColorBurnBlendMode",
  lighten: "CILightenBlendMode",
  screen: "CIScreenBlendMode",
  colorDodge: "CIColorDodgeBlendMode",
  overlay: "CIOverlayBlendMode",
  softLight: "CISoftLightBlendMode",
  hardLight: "CIHardLightBlendMode",
  difference: "CIDifferenceBlendMode",
  exclusion: "CIExclusionBlendMode",
  hue: "CIHueBlendMode",
  saturation: "CISaturationBlendMode",
  color: "CIColorBlendMode",
  luminosity: "CILuminosityBlendMode",
};

/** Core Image blend-filter name; undefined for `normal`. Kept for reference parity (e.g. mapping to WebGL blend shaders). */
export function blendModeCiFilterName(mode: BlendMode): string | undefined {
  return ciFilterNames[mode];
}

export function decodeBlendMode(json: unknown): BlendMode {
  return decodeEnum(json, blendModes, "BlendMode");
}
