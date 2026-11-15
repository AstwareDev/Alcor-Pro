// Argument helpers shared by every tool: ports of the `Dictionary<String, Any>` extensions and `decodeToolArgs`
// in ToolExecutor.swift. Tool arguments are untrusted JSON; nothing here throws anything but `ToolError`.
import { rgbaFromHex, textAlignments, type RGBA, type TextAlignment } from "../../model";
import { swiftRound } from "../../util/math";
import type { ToolArgs } from "./toolRegistry";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws if `entry` carries any keys outside `allowed`. `path` prefixes the error (e.g. "entries[3]"). */
export function validateUnknownKeys(entry: Record<string, unknown>, allowed: Iterable<string>, path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(entry).filter((k) => !allowedSet.has(k)).sort();
  if (unknown.length === 0) return;
  const allowedFields = allowedSet.size === 0 ? "none" : [...allowedSet].sort().join(", ");
  throw new ToolError(`${path}: unknown field(s) '${unknown.join("', '")}'. Allowed: ${allowedFields}.`);
}

const int64Limit = 2 ** 63;

/** Untrusted Double→Int: undefined on NaN/Inf/overflow instead of trapping; truncates toward zero. */
export function safeInt(d: number): number | undefined {
  if (!Number.isFinite(d)) return undefined;
  const t = Math.trunc(d);
  if (Math.abs(t) >= int64Limit) return undefined;
  return t === 0 ? 0 : t;
}

/** Strict JSON integer parsing for identifiers and indexes: rejects fractions and numeric strings. */
export function exactJSONInt(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) return undefined;
  return Math.abs(raw) >= int64Limit ? undefined : raw;
}

/** Clamp before converting so the Int(...) can't overflow; rounds half away from zero. */
export function clampInt(d: number, min: number, max: number): number {
  if (Number.isNaN(d) || d <= min) return min;
  if (d >= max) return max;
  const r = swiftRound(d);
  return r === 0 ? 0 : r;
}

/** `ToolExecutor.droppingAutofilledBlanks`: models fill omitted optional params with "" or null. */
export function droppingAutofilledBlanks(args: ToolArgs): ToolArgs {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== ""));
}

export function argString(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function argInt(args: ToolArgs, key: string): number | undefined {
  const raw = args[key];
  if (typeof raw === "number") return safeInt(raw);
  if (typeof raw === "string") return /^[+-]?\d+$/.test(raw) ? safeInt(Number(raw)) : undefined;
  return undefined;
}

export function argDouble(args: ToolArgs, key: string): number | undefined {
  const raw = args[key];
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t !== "" && t === raw && Number.isFinite(Number(t)) ? Number(t) : undefined;
  }
  return undefined;
}

export function argBool(args: ToolArgs, key: string): boolean | undefined {
  const raw = args[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export function argStringArray(args: ToolArgs, key: string): string[] {
  const raw = args[key];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

export function requireString(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ToolError(`Missing required argument: ${key}`);
  return v;
}

export function requireInt(args: ToolArgs, key: string): number {
  const v = argInt(args, key);
  if (v === undefined) throw new ToolError(`Missing required argument: ${key}`);
  return v;
}

// MARK: - Codable-style decoding

export type DecodeSpec =
  | "any"
  | "int"
  | "double"
  | "string"
  | "bool"
  | { array: DecodeSpec }
  | { object: Record<string, DecodeField>; typeName: string };

export interface DecodeField {
  spec: DecodeSpec;
  required?: boolean;
}

function specName(spec: DecodeSpec): string {
  if (typeof spec === "string") return { any: "Any", int: "Int", double: "Double", string: "String", bool: "Bool" }[spec];
  if ("array" in spec) return `Array<${specName(spec.array)}>`;
  return spec.typeName;
}

function mismatch(path: string, spec: DecodeSpec): ToolError {
  return new ToolError(`${path}: expected ${specName(spec)}, got something else`);
}

function decodeValue(value: unknown, spec: DecodeSpec, path: string): unknown {
  if (spec === "any") return value;
  if (spec === "string") {
    if (typeof value !== "string") throw mismatch(path, spec);
    return value;
  }
  if (spec === "bool") {
    if (typeof value !== "boolean") throw mismatch(path, spec);
    return value;
  }
  if (spec === "double") {
    if (typeof value !== "number") throw mismatch(path, spec);
    return value;
  }
  if (spec === "int") {
    if (typeof value !== "number") throw mismatch(path, spec);
    if (!Number.isInteger(value) || Math.abs(value) >= int64Limit) {
      throw new ToolError(`${path}: Parsed JSON number <${value}> does not fit in Int.`);
    }
    return value;
  }
  if ("array" in spec) {
    if (!Array.isArray(value)) throw new ToolError(`${path}: expected Array<Any>, got something else`);
    return value.map((item, i) => decodeValue(item, spec.array, `${path}[${i}]`));
  }
  if (!isRecord(value)) throw new ToolError(`${path}: expected Dictionary<String, Any>, got something else`);
  return decodeObject(value, spec.object, path);
}

function decodeObject(dict: Record<string, unknown>, fields: Record<string, DecodeField>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = dict[key];
    if (value === undefined || value === null) {
      if (field.required === true) throw new ToolError(`${path}: missing required field '${key}'`);
      continue;
    }
    out[key] = decodeValue(value, field.spec, `${path}.${key}`);
  }
  return out;
}

function firstNonFiniteNumberPath(value: unknown, path: string): string | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) return path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = firstNonFiniteNumberPath(value[i], `${path}[${i}]`);
      if (p) return p;
    }
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = firstNonFiniteNumberPath(v, `${path}.${k}`);
      if (p) return p;
    }
  }
  return undefined;
}

/** Collects every nested object spec's keys so unknown nested keys are reported like Swift's per-entry checks. */
function validateNestedKeys(value: unknown, spec: DecodeSpec, path: string): void {
  if (typeof spec === "string") return;
  if ("array" in spec) {
    if (Array.isArray(value)) value.forEach((item, i) => validateNestedKeys(item, spec.array, `${path}[${i}]`));
    return;
  }
  if (!isRecord(value)) return;
  validateUnknownKeys(value, Object.keys(spec.object), path);
  for (const [key, field] of Object.entries(spec.object)) validateNestedKeys(value[key], field.spec, `${path}.${key}`);
}

/**
 * Port of `decodeToolArgs`: unknown top-level keys, non-finite numbers, then type decoding with Codable-style
 * messages, then unknown keys inside nested entries. `T` is the decoded shape the caller declares.
 */
export function decodeToolArgs<T>(args: ToolArgs, path: string, fields: Record<string, DecodeField>): T {
  validateUnknownKeys(args, Object.keys(fields), path);
  const bad = firstNonFiniteNumberPath(args, path);
  if (bad) throw new ToolError(`${bad}: value must be finite`);
  const decoded = decodeObject(args, fields, path);
  for (const [key, field] of Object.entries(fields)) validateNestedKeys(args[key], field.spec, key);
  return decoded as T;
}

// MARK: - Shared value parsers

export function parseColorHex(hex: string | undefined, path: string): RGBA | undefined {
  if (hex === undefined) return undefined;
  const c = rgbaFromHex(hex);
  if (!c) throw new ToolError(`${path}: invalid color '${hex}'. Expected '#RGB', '#RRGGBB', or '#RRGGBBAA'.`);
  return c;
}

export function parseAlignment(raw: string | undefined, path: string): TextAlignment | undefined {
  if (raw === undefined) return undefined;
  if (!(textAlignments as readonly string[]).includes(raw)) {
    throw new ToolError(`${path}: invalid alignment '${raw}'. Expected 'left', 'center', or 'right'.`);
  }
  return raw as TextAlignment;
}
