import type { TextAnimationPreset, TextStylePreset } from "../presetFormat";
import { animation, textStyle, ts, withAlpha } from "./helpers";

// Windows system fonts only (the compositor draws with Canvas 2D).
export const builtinTextStyles: readonly TextStylePreset[] = [
  textStyle("text.classic", "Classic White", "Basic", ts({ font: "Arial", bold: true, shadow: { alpha: 0.55, y: -3, blur: 8 } })),
  textStyle("text.minimal", "Minimal Light", "Basic", ts({ font: "Segoe UI Light", size: 84, tracking: 2 })),
  textStyle("text.soft-shadow", "Soft Shadow", "Basic", ts({ font: "Segoe UI", bold: true, shadow: { alpha: 0.7, y: -6, blur: 18 } })),
  textStyle("text.black", "Bold Black", "Basic", ts({ font: "Arial Black", color: "#111111", shadow: { color: "#FFFFFF", alpha: 0.5, y: -2, blur: 6 } })),
  textStyle("text.impact", "Impact", "Bold", ts({ font: "Impact", size: 120, caps: true, outline: { color: "#000000", width: 8 } })),
  textStyle("text.sticker", "Sticker", "Bold", ts({ font: "Arial Black", size: 110, outline: { color: "#000000", width: 12 }, shadow: { alpha: 0.6, y: -8, blur: 0 } })),
  textStyle("text.yellow-sub", "Yellow Subtitle", "Bold", ts({ font: "Arial", bold: true, size: 72, color: "#FFE600", outline: { color: "#000000", width: 7 } })),
  textStyle("text.hot-red", "Hot Red", "Bold", ts({ font: "Impact", size: 120, color: "#FF2D2D", caps: true, outline: { color: "#FFFFFF", width: 8 }, shadow: { alpha: 0.5, y: -6, blur: 10 } })),
  textStyle("text.comic-pop", "Comic Pop", "Fun", ts({ font: "Comic Sans MS", bold: true, size: 100, color: "#FFD60A", outline: { color: "#1B1B1B", width: 10 }, shadow: { color: "#FF3B30", alpha: 1, y: -8, blur: 0 } })),
  textStyle("text.bubble", "Bubble Pink", "Fun", ts({ font: "Trebuchet MS", bold: true, size: 104, color: "#FF7AC8", outline: { color: "#FFFFFF", width: 10 }, shadow: { color: "#B0237A", alpha: 0.8, y: -6, blur: 0 } })),
  textStyle("text.glitch", "Glitch", "Fun", ts({ font: "Bahnschrift", bold: true, size: 104, caps: true, color: "#FFFFFF", shadow: { color: "#00F0FF", alpha: 0.9, x: -6, y: 0, blur: 0 } })),
  textStyle("text.neon-pink", "Neon Pink", "Neon", ts({ font: "Segoe UI", bold: true, color: "#FFE3F4", shadow: { color: "#FF2EA6", alpha: 1, y: 0, blur: 26 } })),
  textStyle("text.neon-cyan", "Neon Cyan", "Neon", ts({ font: "Segoe UI", bold: true, color: "#E0FFFF", shadow: { color: "#00E5FF", alpha: 1, y: 0, blur: 26 } })),
  textStyle("text.neon-green", "Neon Green", "Neon", ts({ font: "Consolas", bold: true, color: "#EAFFE0", shadow: { color: "#39FF14", alpha: 1, y: 0, blur: 24 } })),
  textStyle("text.gold", "Gold Luxury", "Elegant", ts({ font: "Georgia", bold: true, size: 100, color: "#E6C15A", tracking: 3, shadow: { color: "#3A2A00", alpha: 0.8, y: -4, blur: 6 } })),
  textStyle("text.serif-italic", "Serif Italic", "Elegant", ts({ font: "Georgia", italic: true, size: 96, color: "#F4EFE6", shadow: { alpha: 0.4, y: -3, blur: 10 } })),
  textStyle("text.cinematic", "Cinematic Caps", "Elegant", ts({ font: "Times New Roman", size: 80, caps: true, tracking: 14, color: "#F2F2F2" })),
  textStyle("text.script", "Handwritten", "Elegant", ts({ font: "Segoe Script", size: 100, color: "#FFFFFF", shadow: { alpha: 0.5, y: -3, blur: 8 } })),
  textStyle("text.typewriter", "Typewriter", "Retro", ts({ font: "Courier New", bold: true, size: 76, color: "#F5F0DC", align: "left" })),
  textStyle("text.retro-orange", "Retro Orange", "Retro", ts({ font: "Arial Black", size: 110, color: "#FF9F0A", caps: true, shadow: { color: "#7A1F00", alpha: 1, y: -9, blur: 0 } })),
  textStyle("text.box-black", "Black Box", "Boxed", ts({ font: "Segoe UI", bold: true, size: 72, box: { color: "#000000", alpha: 0.78, px: 28, py: 14, radius: 10 } })),
  textStyle("text.box-white", "White Box", "Boxed", ts({ font: "Segoe UI", bold: true, size: 72, color: "#111111", box: { color: "#FFFFFF", alpha: 1, px: 28, py: 14, radius: 10 } })),
  textStyle("text.pill-accent", "Accent Pill", "Boxed", ts({ font: "Segoe UI", bold: true, size: 68, box: { color: "#0A84FF", alpha: 1, px: 40, py: 16, radius: 60 } })),
  textStyle("text.highlighter", "Highlighter", "Boxed", ts({ font: "Arial", bold: true, size: 76, color: "#111111", box: { color: "#FFE600", alpha: 1, px: 18, py: 8, radius: 4 } })),
  textStyle("text.footage-fill", "Footage Fill", "Special", ts({ font: "Impact", size: 220, caps: true }), "footage", ["matte", "mask"]),
  textStyle("text.inverted", "Knockout", "Special", ts({ font: "Arial Black", size: 200, caps: true }), "inverted", ["matte", "mask"]),
];

export const textStyleCategories: readonly string[] = ["Basic", "Bold", "Fun", "Neon", "Elegant", "Retro", "Boxed", "Special"];

const yellow = withAlpha("#FFE600", 1);
const pink = withAlpha("#FF4FA3", 1);
const cyan = withAlpha("#22D3EE", 1);
const green = withAlpha("#4ADE80", 1);

export const builtinAnimations: readonly TextAnimationPreset[] = [
  animation("anim.off", "None", "Whole text", { preset: "none" }),
  animation("anim.pop-in", "Pop In", "Whole text", { preset: "popIn" }, ["scale"]),
  animation("anim.slide-up", "Slide Up", "Whole text", { preset: "slideUp" }, ["rise"]),
  animation("anim.typewriter", "Typewriter", "Whole text", { preset: "typewriter" }, ["type"]),
  animation("anim.word-reveal", "Word Reveal", "Per word", { preset: "wordReveal", perWordFrames: 6 }),
  animation("anim.word-reveal-fast", "Word Reveal Fast", "Per word", { preset: "wordReveal", perWordFrames: 3 }, ["quick"]),
  animation("anim.word-slide", "Word Slide", "Per word", { preset: "wordSlide", perWordFrames: 6 }),
  animation("anim.word-slide-slow", "Word Slide Slow", "Per word", { preset: "wordSlide", perWordFrames: 10 }, ["calm"]),
  animation("anim.highlight-yellow", "Highlight Yellow", "Karaoke", { preset: "highlightPop", highlight: yellow }, ["captions"]),
  animation("anim.highlight-pink", "Highlight Pink", "Karaoke", { preset: "highlightPop", highlight: pink }, ["captions"]),
  animation("anim.highlight-green", "Highlight Green", "Karaoke", { preset: "highlightPop", highlight: green, perWordFrames: 5 }, ["captions"]),
  animation("anim.block-yellow", "Block Yellow", "Karaoke", { preset: "highlightBlock", highlight: yellow }, ["captions"]),
  animation("anim.block-cyan", "Block Cyan", "Karaoke", { preset: "highlightBlock", highlight: cyan }, ["captions"]),
];

export const animationCategories: readonly string[] = ["Whole text", "Per word", "Karaoke"];
