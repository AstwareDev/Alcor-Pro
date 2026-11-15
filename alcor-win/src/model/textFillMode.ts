import { setOptional } from "./equality";
import { decodeEnum } from "../util/jsonDecode";
import type { Clip } from "./timeline";
import { makeRGBA, makeTextStyle, type RGBA } from "./textStyle";

export const textFillModes = ["color", "footage", "inverted"] as const;
export type TextFillMode = (typeof textFillModes)[number];

export function defaultFootageMatteColor(): RGBA {
  return makeRGBA({ r: 0, g: 0, b: 0, a: 1 });
}

const displayNames: Record<TextFillMode, string> = { color: "Color", footage: "Footage", inverted: "Inverted" };

export function textFillModeDisplayName(mode: TextFillMode): string {
  return displayNames[mode];
}

export function decodeTextFillMode(json: unknown): TextFillMode {
  return decodeEnum(json, textFillModes, "TextFillMode");
}

export function clipSetTextFillMode(clip: Clip, mode: TextFillMode, footageMatteColor?: RGBA): void {
  if (mode === "footage" && clip.textFillMode !== "footage") {
    const style = clip.textStyle ?? makeTextStyle();
    style.color = footageMatteColor ?? defaultFootageMatteColor();
    setOptional(clip, "textStyle", style);
  }
  setOptional(clip, "textFillMode", mode === "color" ? undefined : mode);
}
