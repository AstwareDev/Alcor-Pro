import Search from "lucide-solid/icons/search";
import { createMemo, createSignal, For, Show } from "solid-js";
import "../generation/providers";
import { fullCatalog, providersWithKeys } from "../generation/providers/registry";
import type { CatalogEntry, ModelKind } from "../generation/providers/types";
import { CapsuleButton } from "../ui/CapsuleButton";
import { ProviderLogo } from "../ui/ProviderLogo";
import { Toggle } from "../ui/Toggle";
import { sharedModelPreferences } from "./modelPreferences";
import { SettingsSection } from "./SettingsParts";

const sections: { kind: ModelKind; title: string }[] = [
  { kind: "image", title: "Image" },
  { kind: "video", title: "Video" },
  { kind: "audio", title: "Audio" },
  { kind: "upscale", title: "Upscale" },
];

function DefaultModelPicker(props: { kind: ModelKind; title: string; models: CatalogEntry[] }) {
  const prefs = sharedModelPreferences();
  const usable = (): CatalogEntry[] => props.models.filter((m) => providersWithKeys().has(m.providerId) && prefs.isEnabled(m.id));
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title">{props.title}</div>
        <div class="settings-row-subtitle">Preselected in the generation panel.</div>
      </div>
      <select
        class="settings-select"
        aria-label={`Default ${props.title.toLowerCase()} model`}
        value={prefs.defaultModel(props.kind) ?? ""}
        onChange={(e) => prefs.setDefaultModel(props.kind, e.currentTarget.value || undefined)}
      >
        <option value="">First available</option>
        <For each={usable()}>{(m) => <option value={m.id}>{m.displayName}</option>}</For>
      </select>
    </div>
  );
}

export function ModelsPane(props: { goToKeys: () => void }) {
  const prefs = sharedModelPreferences();
  const [query, setQuery] = createSignal("");
  const catalog = createMemo(() => fullCatalog());

  const rows = (kind: ModelKind): CatalogEntry[] => {
    const q = query().trim().toLowerCase();
    const matched = catalog().filter((m) => m.kind === kind && (!q || `${m.displayName} ${m.providerName ?? ""}`.toLowerCase().includes(q)));
    const keyed = providersWithKeys();
    return [...matched.filter((m) => keyed.has(m.providerId)), ...matched.filter((m) => !keyed.has(m.providerId))];
  };
  const visible = (): { kind: ModelKind; title: string; rows: CatalogEntry[] }[] =>
    sections.map((s) => ({ ...s, rows: rows(s.kind) })).filter((s) => s.rows.length > 0);

  return (
    <>
      <SettingsSection title="Default models">
        <For each={sections.filter((s) => s.kind !== "upscale")}>
          {(s) => <DefaultModelPicker kind={s.kind} title={s.title} models={catalog().filter((m) => m.kind === s.kind)} />}
        </For>
      </SettingsSection>

      <label class="settings-search">
        <Search size={13} />
        <input placeholder="Search models" aria-label="Search models" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>

      <Show when={visible().length > 0} fallback={<div class="settings-row-subtitle">No models match "{query()}".</div>}>
        <For each={visible()}>
          {(s) => (
            <SettingsSection title={s.title}>
              <For each={s.rows}>
                {(m) => {
                  const locked = (): boolean => !providersWithKeys().has(m.providerId);
                  return (
                    <div class="settings-row model-row" classList={{ locked: locked() }}>
                      <Show when={m.providerIconKey}>{(k) => <ProviderLogo iconKey={k()} size={18} opacity={locked() ? 0.5 : 1} />}</Show>
                      <div class="settings-row-text">
                        <div class="settings-row-title">{m.displayName}</div>
                        <div class="settings-row-subtitle">{m.providerId}{m.description ? ` - ${m.description}` : ""}</div>
                      </div>
                      <Show
                        when={!locked()}
                        fallback={<CapsuleButton onClick={props.goToKeys}>Add API key</CapsuleButton>}
                      >
                        <Toggle checked={prefs.isEnabled(m.id)} onChange={(v) => prefs.setEnabled(m.id, v)} label={m.displayName} />
                      </Show>
                    </div>
                  );
                }}
              </For>
            </SettingsSection>
          )}
        </For>
      </Show>
    </>
  );
}
