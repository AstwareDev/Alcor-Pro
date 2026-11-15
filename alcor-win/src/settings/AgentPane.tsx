import ExternalLink from "lucide-solid/icons/external-link";
import { createSignal, onMount, Show } from "solid-js";
import { mcpStatus, type McpStatus } from "../platform/backend";
import { McpInstructions } from "../help/McpInstructions";
import { SettingsSection } from "./SettingsParts";

// MCP connection instructions. API keys live in "Models / API Keys".

function McpSection() {
  const [status, setStatus] = createSignal<McpStatus | undefined>();
  const [instructions, setInstructions] = createSignal(false);
  onMount(() => void mcpStatus().then(setStatus).catch(() => undefined));
  return (
    <SettingsSection title="Integrations">
      <div class="settings-row-title">MCP Server</div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-subtitle">
            Lets external clients like Cursor, Claude Desktop, Claude Code, and Codex edit your timeline.
          </div>
        </div>
        <button type="button" class="link-button" onClick={() => setInstructions(true)}>
          Setup instructions <ExternalLink size={11} />
        </button>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-subtitle">
            <span class="key-status" classList={{ on: status()?.running === true }}>
              {status()?.running ? `Running on 127.0.0.1:${status()?.port}` : status()?.error ? `Stopped: ${status()?.error}` : "Stopped"}
            </span>
          </div>
        </div>
      </div>
      <Show when={instructions()}><McpInstructions port={status()?.port} onClose={() => setInstructions(false)} /></Show>
    </SettingsSection>
  );
}

export function AgentPane() {
  return <McpSection />;
}
