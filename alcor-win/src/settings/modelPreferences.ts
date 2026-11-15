import { createSignal } from "solid-js";
import type { ModelKind } from "../generation/providers/types";
import { defaultStorage, type KeyValueStorage } from "./storage";

// Port of Generation/Catalog/ModelPreferences.swift (disabledModelIds), plus a preferred default model per kind.

const DISABLED_KEY = "disabledModelIds";
const defaultKey = (kind: ModelKind): string => `defaultModel.${kind}`;

function readIds(storage: KeyValueStorage): string[] {
  try {
    const raw = storage.getItem(DISABLED_KEY);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface ModelPreferences {
  /** Reactive. */
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): void;
  /** Reactive: the user's preferred model for a kind, if set. */
  defaultModel(kind: ModelKind): string | undefined;
  setDefaultModel(kind: ModelKind, id: string | undefined): void;
}

export function makeModelPreferences(storage: KeyValueStorage): ModelPreferences {
  const [disabled, setDisabled] = createSignal<ReadonlySet<string>>(new Set(readIds(storage)));
  const defaults = new Map<ModelKind, ReturnType<typeof createSignal<string | undefined>>>();
  const slot = (kind: ModelKind) => {
    let s = defaults.get(kind);
    if (!s) {
      s = createSignal<string | undefined>(storage.getItem(defaultKey(kind)) ?? undefined);
      defaults.set(kind, s);
    }
    return s;
  };
  return {
    isEnabled: (id) => !disabled().has(id),
    setEnabled(id, enabled) {
      const next = new Set(disabled());
      if (enabled) next.delete(id);
      else next.add(id);
      setDisabled(next);
      storage.setItem(DISABLED_KEY, JSON.stringify([...next]));
    },
    defaultModel: (kind) => slot(kind)[0](),
    setDefaultModel(kind, id) {
      slot(kind)[1](id);
      if (id === undefined) storage.removeItem(defaultKey(kind));
      else storage.setItem(defaultKey(kind), id);
    },
  };
}

let shared: ModelPreferences | undefined;
export function sharedModelPreferences(): ModelPreferences {
  shared ??= makeModelPreferences(defaultStorage());
  return shared;
}
