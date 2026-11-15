import type { EffectPreset } from "../presetFormat";
import { blur, clarity, contrast, effect, effectPreset, exposure, glow, grain, hiSh, motionBlur, noiseReduction, saturation, sharpen, vignette } from "./helpers";

// Adjustment-style presets: they are added on top of a clip's existing effects (same-type effects are updated).
export const builtinEffects: readonly EffectPreset[] = [
  effectPreset("fx.dreamy-glow", "Dreamy Glow", "Glow", [glow(0.55, 40, 0.5, 0.2), contrast(0.94), exposure(0.06)], ["soft", "bloom"]),
  effectPreset("fx.soft-bloom", "Soft Bloom", "Glow", [glow(0.32, 28, 0.62, 0)], ["highlights"]),
  effectPreset("fx.warm-halation", "Warm Halation", "Glow", [glow(0.45, 34, 0.58, 0.9), saturation(1.05)], ["film", "red glow"]),
  effectPreset("fx.neon-glow", "Neon Glow", "Glow", [glow(0.85, 22, 0.42, 0.1), contrast(1.18), saturation(1.25)], ["bright", "night"]),
  effectPreset("fx.film-look", "Film Vignette & Grain", "Film", [vignette(-0.35, 0.5, 0.65), grain(0.28, 2), contrast(1.04)], ["vignette", "grain"]),
  effectPreset("fx.heavy-vignette", "Heavy Vignette", "Film", [vignette(-0.75, 0.4, 0.55)], ["dark corners"]),
  effectPreset("fx.light-vignette", "Light Vignette", "Film", [vignette(-0.28, 0.55, 0.8)], ["subtle"]),
  effectPreset("fx.grungy-grain", "Grungy Grain", "Film", [grain(0.65, 3), contrast(1.1), clarity(0.2)], ["noise", "gritty"]),
  effectPreset("fx.soft-blur", "Soft Blur", "Blur", [blur(6)], ["background"]),
  effectPreset("fx.heavy-blur", "Heavy Blur", "Blur", [blur(32)], ["background", "privacy"]),
  effectPreset("fx.motion-horizontal", "Motion Streak", "Blur", [motionBlur(24, 0)], ["speed", "whip"]),
  effectPreset("fx.motion-diagonal", "Diagonal Streak", "Blur", [motionBlur(30, 35)], ["speed"]),
  effectPreset("fx.soft-focus", "Soft Focus", "Blur", [blur(2.5), glow(0.3, 24, 0.6, 0), contrast(0.96)], ["portrait", "dreamy"]),
  effectPreset("fx.crisp", "Crisp Detail", "Detail", [sharpen(0.85), clarity(0.3)], ["sharp"]),
  effectPreset("fx.clean-up", "Clean Up", "Detail", [noiseReduction(0.5), sharpen(0.35)], ["denoise"]),
  effectPreset("fx.dehaze", "Dehaze", "Detail", [clarity(0.2, 0.55), hiSh(-0.1, 0.12), contrast(1.06)], ["fog", "landscape"]),
  effectPreset("fx.invert", "Invert", "Stylize", [effect("stylize.invert")], ["negative"]),
];

export const effectCategories: readonly string[] = ["Glow", "Film", "Blur", "Detail", "Stylize"];
