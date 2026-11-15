import { createSignal } from "solid-js";
import { defaultStorage, type KeyValueStorage } from "./storage";

// Port of AppAppearanceStore: light / dark / system, applied as `data-theme` on <html> (tokens.css has both palettes).

export const appearanceOptions = ["system", "light", "dark"] as const;
export type Appearance = (typeof appearanceOptions)[number];
const KEY = "appearance";

export function resolveTheme(selection: Appearance, systemPrefersDark: boolean): "light" | "dark" {
  return selection === "system" ? (systemPrefersDark ? "dark" : "light") : selection;
}

export function parseAppearance(raw: string | null): Appearance {
  return (appearanceOptions as readonly string[]).includes(raw ?? "") ? (raw as Appearance) : "dark";
}

export interface AppearanceStore {
  selection(): Appearance;
  set(next: Appearance): void;
}

export function makeAppearanceStore(storage: KeyValueStorage, root: { setAttribute(name: string, value: string): void }, media?: MediaQueryList): AppearanceStore {
  const [selection, setSelection] = createSignal<Appearance>(parseAppearance(storage.getItem(KEY)));
  const apply = (): void => root.setAttribute("data-theme", resolveTheme(selection(), media?.matches ?? true));
  media?.addEventListener("change", apply);
  apply();
  return {
    selection,
    set(next) {
      setSelection(next);
      storage.setItem(KEY, next);
      apply();
    },
  };
}

let shared: AppearanceStore | undefined;
export function sharedAppearance(): AppearanceStore {
  shared ??= makeAppearanceStore(defaultStorage(), document.documentElement, window.matchMedia("(prefers-color-scheme: dark)"));
  return shared;
}

/** Applies the stored theme immediately (call at startup). */
export function applyStoredAppearance(): void {
  sharedAppearance();
}
