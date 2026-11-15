// Port of ToolExecutor.jsonString (sorted keys) and roundJSONFloatingPointNumbers.

/** Decimal rounding half away from zero on the shortest decimal representation, like NSDecimalNumber `.plain`. */
export function jsonRounded(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0;
  const text = Math.abs(value).toString();
  if (text.includes("e")) return Number(value.toFixed(places));
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length <= places) return value;
  const kept = BigInt(whole + fraction.slice(0, places));
  const roundUp = fraction.charCodeAt(places) >= 53; // '5'
  const scaled = roundUp ? kept + 1n : kept;
  const result = Number(scaled) / 10 ** places;
  return negative ? -result : result;
}

export function roundJSONFloatingPointNumbers(value: unknown, places: number): unknown {
  if (Array.isArray(value)) return value.map((v) => roundJSONFloatingPointNumbers(v, places));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundJSONFloatingPointNumbers(v, places)]));
  }
  if (typeof value === "number") return Number.isFinite(value) ? jsonRounded(value, places) : null;
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** `JSONSerialization.data(withJSONObject:options: [.sortedKeys])`. */
export function jsonString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
