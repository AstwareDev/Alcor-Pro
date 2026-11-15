import { createSignal } from "solid-js";

/**
 * Reactive object whose top-level fields are signals. Values are stored as-is (never proxied),
 * so frozen document objects are safe to hold. Replace values to notify; in-place edits do not.
 */
export function shallowMutable<T extends object>(initial: T): T {
  const out = {} as T;
  for (const key of Object.keys(initial) as (keyof T)[]) {
    const [get, set] = createSignal(initial[key]);
    Object.defineProperty(out, key, {
      enumerable: true,
      get,
      set: (value: T[keyof T]) => void set(() => value),
    });
  }
  return out;
}
