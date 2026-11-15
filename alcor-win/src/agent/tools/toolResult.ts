// Port of ToolResult.swift.
export type ToolBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: string };

export interface ToolResult {
  content: ToolBlock[];
  isError: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ kind: "text", text }], isError: false };
}

export function error(message: string): ToolResult {
  return { content: [{ kind: "text", text: message }], isError: true };
}

/** MCP wire shape (`CallTool.Result`): `isError` is omitted on success, like Swift's `nil`. */
export interface McpWireResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: true;
}

export function toMcpResult(result: ToolResult): McpWireResult {
  const content = result.content.map((block) =>
    block.kind === "text"
      ? ({ type: "text", text: block.text } as const)
      : ({ type: "image", data: block.base64, mimeType: block.mediaType } as const),
  );
  return result.isError ? { content, isError: true } : { content };
}

export function resultText(result: ToolResult): string {
  return result.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
}
