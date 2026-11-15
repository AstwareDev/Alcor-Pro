/** Structural equality (Swift `==` on Codable value types). `undefined` properties count as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** Writes `obj[key]`: deletes the key for `undefined`, skips the write when already equal (keeps Immer drafts unmodified). */
export function setOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) {
    if (key in obj) delete obj[key];
    return;
  }
  if (!deepEqual(obj[key], value)) obj[key] = value;
}
