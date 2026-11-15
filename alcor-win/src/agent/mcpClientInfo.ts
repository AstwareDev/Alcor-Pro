// Port of MCPClientInfo.swift: the `clientInfo` an MCP client sends with `initialize`.
export interface MCPClientInfo {
  name: string;
  title?: string;
  version: string;
  description?: string;
  websiteUrl?: string;
}

/** Parses the raw `clientInfo` object; undefined when it lacks the required `name` / `version`. */
export function parseMcpClientInfo(raw: unknown): MCPClientInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.version !== "string") return undefined;
  const info: MCPClientInfo = { name: o.name, version: o.version };
  if (typeof o.title === "string") info.title = o.title;
  if (typeof o.description === "string") info.description = o.description;
  if (typeof o.websiteUrl === "string") info.websiteUrl = o.websiteUrl;
  return info;
}

/** `MCPClientInfo.payload`: what session analytics would carry. */
export function mcpClientInfoPayload(info: MCPClientInfo): Record<string, string> {
  const payload: Record<string, string> = { name: info.name, version: info.version };
  if (info.title !== undefined) payload.title = info.title;
  if (info.description !== undefined) payload.description = info.description;
  if (info.websiteUrl !== undefined) payload.websiteUrl = info.websiteUrl;
  return payload;
}
