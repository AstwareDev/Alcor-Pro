import type { Preset } from "../presetFormat";
import { animationCategories, builtinAnimations, builtinTextStyles, textStyleCategories } from "./text";
import { builtinEffects, effectCategories } from "./effects";
import { builtinLooks, lookCategories } from "./looks";
import { builtinTitles, titleCategories } from "./titles";

export { builtinAnimations, builtinEffects, builtinLooks, builtinTextStyles, builtinTitles };

export const builtinPresets: readonly Preset[] = [
  ...builtinLooks, ...builtinEffects, ...builtinTextStyles, ...builtinAnimations, ...builtinTitles,
];

export const categoryOrder: Record<Preset["kind"], readonly string[]> = {
  look: lookCategories,
  effect: effectCategories,
  textStyle: textStyleCategories,
  textAnimation: animationCategories,
  title: titleCategories,
};
