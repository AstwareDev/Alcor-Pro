import { current, isDraft } from "immer";

/** Swift `let copy = value` semantics: a detached copy that later mutations of the source cannot change. */
export function snapshot<T>(value: T): T {
  return isDraft(value) ? (current(value as object) as T) : value;
}
