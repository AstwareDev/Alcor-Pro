import Cog from "lucide-solid/icons/cog";
import HardDrive from "lucide-solid/icons/hard-drive";
import Bot from "lucide-solid/icons/bot";
import KeyRound from "lucide-solid/icons/key-round";
import Layers from "lucide-solid/icons/layers";
import Sun from "lucide-solid/icons/sun";
import TextCursorInput from "lucide-solid/icons/text-cursor-input";
import X from "lucide-solid/icons/x";
import { createSignal, For, Match, onCleanup, onMount, Switch, type JSX } from "solid-js";
import { SidebarRowButton } from "../ui/SidebarRowButton";
import { AgentPane } from "./AgentPane";
import { ApiKeysPane } from "./ApiKeysPane";
import { AppearancePane } from "./AppearancePane";
import { refreshProviderKeys } from "./keys";
import { ModelsPane } from "./ModelsPane";
import { RoutingPane } from "./RoutingPane";
import { sharedNotifications } from "./notifications";
import { SettingsSection, SettingsToggleRow } from "./SettingsParts";
import { StoragePane } from "./StoragePane";
import { TranscriptionSection } from "./TranscriptionSection";
import "./settings.css";

export { refreshProviderKeys } from "./keys";

// Port of Settings/SettingsView.swift. Skipped panes: Account (Palmier backend), Privacy (telemetry),
// Skills (macOS agent skill installer). MCP connection instructions live under "MCP".
const tabs = [
  { id: "keys", label: "Models / API Keys", icon: <KeyRound size={14} /> },
  { id: "agent", label: "MCP", icon: <Bot size={14} /> },
  { id: "models", label: "Models", icon: <Layers size={14} /> },
  { id: "routing", label: "Prompt bar", icon: <TextCursorInput size={14} /> },
  { id: "general", label: "General", icon: <Cog size={14} /> },
  { id: "appearance", label: "Appearance", icon: <Sun size={14} /> },
  { id: "storage", label: "Storage", icon: <HardDrive size={14} /> },
] as const;
type TabId = (typeof tabs)[number]["id"];

function GeneralPane(): JSX.Element {
  const notifications = sharedNotifications();
  return (
    <SettingsSection title="General">
      <SettingsToggleRow
        title="Show notifications"
        subtitle="Get a notification when a generation finishes while Alcor Pro is in the background."
        checked={notifications.enabled()}
        onChange={notifications.setEnabled}
      />
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Language</div>
          <div class="settings-row-subtitle">The editor UI is currently English only.</div>
        </div>
      </div>
    </SettingsSection>
  );
}

export function SettingsView(props: { onClose: () => void }) {
  const [tab, setTab] = createSignal<TabId>("keys");
  const title = (): string => tabs.find((t) => t.id === tab())?.label ?? "";
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
    void refreshProviderKeys().catch(() => undefined);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class="settings-view">
      <nav class="settings-sidebar" aria-label="Settings">
        <For each={tabs}>
          {(t) => <SidebarRowButton label={t.label} icon={t.icon} selected={tab() === t.id} onClick={() => setTab(t.id)} />}
        </For>
      </nav>
      <main class="settings-detail">
        <header class="settings-header">
          <h2 class="settings-title">{title()}</h2>
          <button type="button" class="settings-close" aria-label="Close settings" onClick={props.onClose}>
            <X size={14} />
          </button>
        </header>
        <div class="settings-scroll">
          <div class="settings-content">
            <Switch>
              <Match when={tab() === "keys"}><ApiKeysPane /><TranscriptionSection /></Match>
              <Match when={tab() === "agent"}><AgentPane /></Match>
              <Match when={tab() === "models"}><ModelsPane goToKeys={() => setTab("keys")} /></Match>
              <Match when={tab() === "routing"}><RoutingPane goToKeys={() => setTab("keys")} /></Match>
              <Match when={tab() === "general"}><GeneralPane /></Match>
              <Match when={tab() === "appearance"}><AppearancePane /></Match>
              <Match when={tab() === "storage"}><StoragePane /></Match>
            </Switch>
          </div>
        </div>
      </main>
    </div>
  );
}
