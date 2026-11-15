import { describe, expect, it } from "vitest";
import { claudeCodeCommand, codexCommand, cursorDeepLink, cursorJsonConfig } from "./mcpSnippets";

describe("MCP instructions", () => {
  it("buildsTheCopyableCommandsAndConfig", () => {
    expect(claudeCodeCommand()).toBe("claude mcp add --transport http alcor-pro http://127.0.0.1:19789/mcp");
    expect(codexCommand(1234)).toBe("codex mcp add alcor-pro --url http://127.0.0.1:1234/mcp");
    expect(JSON.parse(cursorJsonConfig())).toEqual({ mcpServers: { "alcor-pro": { type: "http", url: "http://127.0.0.1:19789/mcp" } } });
  });
  it("cursorDeepLinkCarriesPercentEncodedBase64Config", () => {
    const link = new URL(cursorDeepLink());
    expect(link.protocol).toBe("cursor:");
    expect(link.searchParams.get("name")).toBe("alcor-pro");
    expect(JSON.parse(atob(link.searchParams.get("config") ?? ""))).toEqual({ type: "http", url: "http://127.0.0.1:19789/mcp" });
  });
});
