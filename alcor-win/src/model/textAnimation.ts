import { asObject, tryInt, tryEnum, tryWith, getString, getInt } from "../util/jsonDecode";
import { decodeRGBA, makeRGBA, type RGBA } from "./textStyle";

export interface WordTiming {
  text: string;
  startFrame: number;
  endFrame: number;
}

/** Synthesized Codable: every key is required. */
export function decodeWordTiming(json: unknown): WordTiming {
  const c = asObject(json, "WordTiming");
  return { text: getString(c, "text"), startFrame: getInt(c, "startFrame"), endFrame: getInt(c, "endFrame") };
}

export const textAnimationPresets = [
  "none",
  // Whole-clip / per-line.
  "popIn", "slideUp", "typewriter",
  // Per word.
  "wordReveal", "wordSlide", "highlightPop", "highlightBlock",
] as const;

export type TextAnimationPreset = (typeof textAnimationPresets)[number];

export type TextAnimationRenderMode = "entrance" | "perWord" | "typewriter";

export function presetRenderMode(preset: TextAnimationPreset): TextAnimationRenderMode {
  switch (preset) {
    case "none": case "popIn": case "slideUp": return "entrance";
    case "typewriter": return "typewriter";
    case "wordReveal": case "wordSlide": case "highlightPop": case "highlightBlock": return "perWord";
  }
}

export function presetIsPerWord(preset: TextAnimationPreset): boolean {
  return presetRenderMode(preset) === "perWord";
}

export function presetUsesHighlight(preset: TextAnimationPreset): boolean {
  return presetIsPerWord(preset);
}

const presetDisplayNames: Record<TextAnimationPreset, string> = {
  none: "Off",
  popIn: "Pop In",
  slideUp: "Slide Up",
  typewriter: "Typewriter",
  wordReveal: "Word Reveal",
  wordSlide: "Word Slide",
  highlightPop: "Highlight",
  highlightBlock: "Highlight Block",
};

export function presetDisplayName(preset: TextAnimationPreset): string {
  return presetDisplayNames[preset];
}

export const textAnimationAgentValues: readonly string[] = ["off", ...textAnimationPresets.filter((p) => p !== "none")];

export const textAnimationPerLinePresets: readonly TextAnimationPreset[] = ["popIn", "slideUp", "typewriter"];
export const textAnimationPerWordPresets: readonly TextAnimationPreset[] = ["wordReveal", "wordSlide", "highlightPop", "highlightBlock"];

export interface TextAnimation {
  preset: TextAnimationPreset;
  perWordFrames: number;
  highlight?: RGBA;
}

export function makeTextAnimation(p: Partial<TextAnimation> = {}): TextAnimation {
  const a: TextAnimation = { preset: p.preset ?? "none", perWordFrames: p.perWordFrames ?? 6 };
  if (p.highlight !== undefined) a.highlight = p.highlight;
  return a;
}

export function textAnimationIsActive(a: TextAnimation): boolean {
  return a.preset !== "none";
}

export function textAnimationDefaultHighlight(): RGBA {
  return makeRGBA({ r: 1, g: 0.85, b: 0, a: 1 });
}

export function decodeTextAnimation(json: unknown): TextAnimation {
  const c = asObject(json, "TextAnimation");
  return makeTextAnimation({
    preset: tryEnum(c, "preset", textAnimationPresets),
    perWordFrames: tryInt(c, "perWordFrames"),
    highlight: tryWith(c, "highlight", decodeRGBA),
  });
}
