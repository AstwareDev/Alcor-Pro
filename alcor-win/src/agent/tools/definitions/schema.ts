import type { JsonObject } from "../toolRegistry";

/** `ToolDefinitions.objectSchema`: `properties` and `required` appear only when non-empty. */
export function objectSchema({
  properties = {},
  required = [],
}: { properties?: Record<string, JsonObject>; required?: string[] } = {}): JsonObject {
  const dict: JsonObject = { type: "object" };
  if (Object.keys(properties).length > 0) dict.properties = properties;
  if (required.length > 0) dict.required = required;
  return dict;
}
