// Port of Catalog/ModelPreferences.swift (UserDefaults "disabledModelIds" -> localStorage).
import { createSignal } from "solid-js";

const defaultsKey = "disabledModelIds";

function load(): ReadonlySet<string> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(defaultsKey);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const [disabled, setDisabled] = createSignal<ReadonlySet<string>>(load());

/** Reactive. */
export function disabledModelIds(): ReadonlySet<string> {
  return disabled();
}

export function isModelEnabled(id: string): boolean {
  return !disabled().has(id);
}

export function setModelEnabled(id: string, enabled: boolean): void {
  const next = new Set(disabled());
  if (enabled) next.delete(id);
  else next.add(id);
  setDisabled(next);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(defaultsKey, JSON.stringify([...next]));
  } catch {
    // preference stays in memory
  }
}
