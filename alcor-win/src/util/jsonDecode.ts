// Helpers that reproduce Swift `Decodable` semantics on parsed JSON.
// get*  = `decode` (key required, wrong type or null throws)
// opt*  = `decodeIfPresent` (absent or null -> undefined, wrong type throws)
// try*  = `try? decode` (any failure -> undefined)

export class DecodingError extends Error {}

export type JsonObject = Record<string, unknown>;

export function asObject(json: unknown, what = "value"): JsonObject {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new DecodingError(`${what}: expected object`);
  }
  return json as JsonObject;
}

export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DecodingError) return undefined;
    throw e;
  }
}

function fail(key: string, expected: string): never {
  throw new DecodingError(`${key}: expected ${expected}`);
}

export function decodeString(v: unknown, key = "value"): string {
  return typeof v === "string" ? v : fail(key, "string");
}
export function decodeBool(v: unknown, key = "value"): boolean {
  return typeof v === "boolean" ? v : fail(key, "bool");
}
export function decodeDouble(v: unknown, key = "value"): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fail(key, "number");
}
export function decodeInt(v: unknown, key = "value"): number {
  return typeof v === "number" && Number.isInteger(v) ? v : fail(key, "integer");
}
export function decodeEnum<T extends string>(v: unknown, values: readonly T[], key = "value"): T {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fail(key, values.join("|"));
}
export function decodeArray<T>(v: unknown, fn: (e: unknown) => T, key = "value"): T[] {
  if (!Array.isArray(v)) return fail(key, "array");
  return v.map((e) => fn(e));
}
export function decodeRecord<T>(v: unknown, fn: (e: unknown) => T, key = "value"): Record<string, T> {
  const o = asObject(v, key);
  const out: Record<string, T> = {};
  for (const k of Object.keys(o)) out[k] = fn(o[k]);
  return out;
}

function present(o: JsonObject, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return fail(key, "key present");
  return o[key];
}

export function getString(o: JsonObject, key: string): string {
  return decodeString(present(o, key), key);
}
export function getBool(o: JsonObject, key: string): boolean {
  return decodeBool(present(o, key), key);
}
export function getDouble(o: JsonObject, key: string): number {
  return decodeDouble(present(o, key), key);
}
export function getInt(o: JsonObject, key: string): number {
  return decodeInt(present(o, key), key);
}
export function getEnum<T extends string>(o: JsonObject, key: string, values: readonly T[]): T {
  return decodeEnum(present(o, key), values, key);
}
export function getWith<T>(o: JsonObject, key: string, fn: (v: unknown) => T): T {
  return fn(present(o, key));
}
export function getArray<T>(o: JsonObject, key: string, fn: (e: unknown) => T): T[] {
  return decodeArray(present(o, key), fn, key);
}

function optional<T>(o: JsonObject, key: string, fn: (v: unknown) => T): T | undefined {
  const v = o[key];
  return v === undefined || v === null ? undefined : fn(v);
}

export function optString(o: JsonObject, key: string): string | undefined {
  return optional(o, key, (v) => decodeString(v, key));
}
export function optBool(o: JsonObject, key: string): boolean | undefined {
  return optional(o, key, (v) => decodeBool(v, key));
}
export function optDouble(o: JsonObject, key: string): number | undefined {
  return optional(o, key, (v) => decodeDouble(v, key));
}
export function optInt(o: JsonObject, key: string): number | undefined {
  return optional(o, key, (v) => decodeInt(v, key));
}
export function optEnum<T extends string>(o: JsonObject, key: string, values: readonly T[]): T | undefined {
  return optional(o, key, (v) => decodeEnum(v, values, key));
}
export function optWith<T>(o: JsonObject, key: string, fn: (v: unknown) => T): T | undefined {
  return optional(o, key, fn);
}
export function optArray<T>(o: JsonObject, key: string, fn: (e: unknown) => T): T[] | undefined {
  return optional(o, key, (v) => decodeArray(v, fn, key));
}

export function tryString(o: JsonObject, key: string): string | undefined {
  return attempt(() => getString(o, key));
}
export function tryBool(o: JsonObject, key: string): boolean | undefined {
  return attempt(() => getBool(o, key));
}
export function tryDouble(o: JsonObject, key: string): number | undefined {
  return attempt(() => getDouble(o, key));
}
export function tryInt(o: JsonObject, key: string): number | undefined {
  return attempt(() => getInt(o, key));
}
export function tryEnum<T extends string>(o: JsonObject, key: string, values: readonly T[]): T | undefined {
  return attempt(() => getEnum(o, key, values));
}
export function tryWith<T>(o: JsonObject, key: string, fn: (v: unknown) => T): T | undefined {
  return attempt(() => getWith(o, key, fn));
}
export function tryArray<T>(o: JsonObject, key: string, fn: (e: unknown) => T): T[] | undefined {
  return attempt(() => getArray(o, key, fn));
}

// Drop undefined-valued keys so encoded objects match Swift's omitted-nil output.
export function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
