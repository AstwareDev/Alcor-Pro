// Port of the snippet builders in Help/MCPInstructionsPane.swift.
export const defaultMcpPort = 19789;

export function mcpEndpoint(port: number = defaultMcpPort): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export const claudeCodeCommand = (port?: number): string => `claude mcp add --transport http alcor-pro ${mcpEndpoint(port)}`;
export const codexCommand = (port?: number): string => `codex mcp add alcor-pro --url ${mcpEndpoint(port)}`;

export function cursorJsonConfig(port?: number): string {
  return `{
  "mcpServers": {
    "alcor-pro": {
      "type": "http",
      "url": "${mcpEndpoint(port)}"
    }
  }
}`;
}

/** `cursor://` one-click install link: base64 of the sorted-key config JSON, percent-encoded. */
export function cursorDeepLink(port?: number): string {
  const config = JSON.stringify({ type: "http", url: mcpEndpoint(port) });
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=alcor-pro&config=${encodeURIComponent(btoa(config))}`;
}
