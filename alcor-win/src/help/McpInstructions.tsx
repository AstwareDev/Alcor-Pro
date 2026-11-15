import { openUrl } from "@tauri-apps/plugin-opener";
import ArrowUpRight from "lucide-solid/icons/arrow-up-right";
import Check from "lucide-solid/icons/check";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Copy from "lucide-solid/icons/copy";
import X from "lucide-solid/icons/x";
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ExternalAgentLogo, type ExternalAgent } from "./ExternalAgentLogo";
import { claudeCodeCommand, codexCommand, cursorDeepLink, cursorJsonConfig, mcpEndpoint } from "./mcpSnippets";
import "./help.css";

function CodeBlock(props: { content: string; large?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(props.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div class="mcp-code" classList={{ large: props.large }}>
      <pre>{props.content}</pre>
      <button type="button" class="mcp-copy" title={copied() ? "Copied" : "Copy"} aria-label={copied() ? "Copied" : "Copy"} onClick={copy}>
        <Show when={copied()} fallback={<Copy size={13} />}><Check size={13} /></Show>
      </button>
    </div>
  );
}

function ManualFallback(props: { intro: string; code: string }) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <div class="mcp-manual">
      <button type="button" class="mcp-manual-toggle" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
        <ChevronRight size={9} class="mcp-chevron" classList={{ open: expanded() }} /> Manual setup
      </button>
      <Show when={expanded()}>
        <div class="mcp-manual-body">
          <div class="mcp-desc">{props.intro}</div>
          <CodeBlock content={props.code} />
        </div>
      </Show>
    </div>
  );
}

function AgentSection(props: {
  agent: ExternalAgent; name: string; description: string; action?: { label: string; run: () => void }; children?: JSX.Element;
}) {
  return (
    <div class="mcp-agent">
      <div class="mcp-agent-head">
        <ExternalAgentLogo agent={props.agent} />
        <div class="mcp-agent-text">
          <div class="mcp-agent-name">{props.name}</div>
          <div class="mcp-desc">{props.description}</div>
        </div>
        <Show when={props.action}>
          {(a) => <button type="button" class="link-button" onClick={a().run}>{a().label} <ArrowUpRight size={11} /></button>}
        </Show>
      </div>
      {props.children}
    </div>
  );
}

/** Port of Help/MCPInstructionsPane: connect Cursor, Claude Code and Codex to the local MCP server. */
export function McpInstructions(props: { port?: number; onClose: () => void }) {
  const [error, setError] = createSignal<string | undefined>();
  const openCursor = (): void => {
    setError(undefined);
    void openUrl(cursorDeepLink(props.port)).catch(() => setError("Cursor could not be opened. Use the manual setup below."));
  };
  onMount(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", key);
    onCleanup(() => document.removeEventListener("keydown", key));
  });

  return (
    <Portal>
      <div class="mcp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
        <div class="mcp-dialog" role="dialog" aria-modal="true" aria-label="MCP Instructions">
          <header class="mcp-header">
            <h2>MCP Instructions</h2>
            <button type="button" class="mcp-close" aria-label="Close" onClick={props.onClose}><X size={14} /></button>
          </header>
          <div class="mcp-scroll">
            <p class="mcp-intro">Connect an external agent to inspect and edit the open Alcor Pro project.</p>
            <h3 class="mcp-group-title">Server URL</h3>
            <CodeBlock content={mcpEndpoint(props.port)} large />
            <h3 class="mcp-group-title">Connect an agent</h3>
            <AgentSection agent="cursor" name="Cursor" description="Install the Alcor Pro MCP server in Cursor." action={{ label: "Install in Cursor", run: openCursor }}>
              <Show when={error()}>{(m) => <div class="mcp-error" role="alert">{m()}</div>}</Show>
              <ManualFallback intro="Add this configuration to ~/.cursor/mcp.json." code={cursorJsonConfig(props.port)} />
            </AgentSection>
            <AgentSection agent="claude" name="Claude Code" description="Run this command once in a terminal.">
              <CodeBlock content={claudeCodeCommand(props.port)} />
            </AgentSection>
            <AgentSection agent="codex" name="Codex" description="Run this command once in a terminal.">
              <CodeBlock content={codexCommand(props.port)} />
            </AgentSection>
            <AgentSection
              agent="claude" name="Claude Desktop"
              description="Add the server under mcpServers in claude_desktop_config.json (the one-click .mcpb bundle is macOS-only)."
            >
              <ManualFallback intro="Claude Desktop launches stdio servers, so bridge the HTTP endpoint with mcp-remote." code={`{
  "mcpServers": {
    "alcor-pro": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${mcpEndpoint(props.port)}"]
    }
  }
}`} />
            </AgentSection>
          </div>
        </div>
      </div>
    </Portal>
  );
}
