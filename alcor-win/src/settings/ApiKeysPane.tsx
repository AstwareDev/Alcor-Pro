import { openUrl } from "@tauri-apps/plugin-opener";
import ExternalLink from "lucide-solid/icons/external-link";
import { createSignal, For, onMount, Show } from "solid-js";
import { httpFetch, secretDelete, secretHas, secretSet } from "../platform/backend";
import "../generation/providers";
import { allProviders, providersWithKeys } from "../generation/providers/registry";
import type { Provider } from "../generation/providers/types";
import { CapsuleButton } from "../ui/CapsuleButton";
import { ProviderLogo } from "../ui/ProviderLogo";
import { removeProviderKey, saveProviderKey, testProviderKey } from "./keys";
import { SettingsSection } from "./SettingsParts";

const iconKeyByProvider: Record<string, string> = { elevenlabs: "elevenlabs", openai: "openai", google: "google" };

type Result = { ok: boolean; message: string };

function KeyRow(props: { provider: Provider }) {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<Result | undefined>();
  const has = (): boolean => providersWithKeys().has(props.provider.id);

  const run = async (work: () => Promise<Result | void>): Promise<void> => {
    setBusy(true);
    setResult(undefined);
    try {
      setResult((await work()) ?? undefined);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      await saveProviderKey(props.provider, draft());
      setDraft("");
      return { ok: true, message: "Saved." };
    });
  const test = (): Promise<void> =>
    run(async () => {
      const r = await testProviderKey(props.provider);
      return r.ok ? { ok: true, message: "Key works." } : { ok: false, message: r.message };
    });
  const remove = (): Promise<void> =>
    run(async () => {
      await removeProviderKey(props.provider);
      return { ok: true, message: "Removed." };
    });

  return (
    <div class="key-row">
      <div class="key-row-head">
        <ProviderLogo iconKey={iconKeyByProvider[props.provider.id] ?? ""} size={20} />
        <span class="settings-row-title">{props.provider.displayName}</span>
        <span class="key-status" classList={{ on: has() }}>{has() ? "Key stored" : "No key"}</span>
        <span class="settings-spacer" />
        <button type="button" class="link-button" onClick={() => void openUrl(props.provider.keyUrl)}>
          Get key <ExternalLink size={11} />
        </button>
      </div>
      <div class="key-row-controls">
        <input
          class="settings-input"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={has() ? "Enter a new key to replace the stored one" : "Paste API key"}
          aria-label={`${props.provider.displayName} API key`}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft().trim()) void save(); }}
        />
        <CapsuleButton variant="prominent" disabled={busy() || !draft().trim()} onClick={() => void save()}>Save</CapsuleButton>
        <CapsuleButton disabled={busy() || !has()} onClick={() => void test()}>Test</CapsuleButton>
        <CapsuleButton disabled={busy() || !has()} onClick={() => void remove()}>Remove</CapsuleButton>
      </div>
      <Show when={result()}>
        {(r) => <div class="key-result" classList={{ error: !r().ok }} role="status">{r().message}</div>}
      </Show>
    </div>
  );
}

interface AgentKeyProvider {
  secret: "freesound";
  displayName: string;
  keyUrl: string;
  placeholder: string;
  check: () => Promise<{ status: number }>;
}

const agentKeyProviders: AgentKeyProvider[] = [
  {
    // https://freesound.org/docs/api/authentication.html : token auth via the `token` query parameter.
    secret: "freesound", displayName: "Freesound (Library sounds)", keyUrl: "https://freesound.org/apiv2/apply", placeholder: "Freesound API key",
    check: () => httpFetch({ url: "https://freesound.org/apiv2/search/?query=test&page_size=1&fields=id", auth: { secret: "freesound", query: "token" } }),
  },
];

/** Key row for a non-generation service key (Freesound). */
function AgentKeyRow(props: { provider: AgentKeyProvider }) {
  const [draft, setDraft] = createSignal("");
  const [has, setHas] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<Result | undefined>();
  const reload = async (): Promise<void> => {
    setHas(await secretHas(props.provider.secret).catch(() => false));
  };
  onMount(() => void reload());

  const run = async (work: () => Promise<Result>): Promise<void> => {
    setBusy(true);
    setResult(undefined);
    try {
      setResult(await work());
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };
  const save = (): Promise<void> =>
    run(async () => {
      const key = draft().trim();
      if (!key) return { ok: false, message: "Enter an API key." };
      await secretSet(props.provider.secret, key);
      setDraft("");
      await reload();
      return { ok: true, message: "Saved." };
    });
  const test = (): Promise<void> =>
    run(async () => {
      const r = await props.provider.check();
      return r.status >= 200 && r.status < 300 ? { ok: true, message: "Key works." } : { ok: false, message: `The provider rejected the key (HTTP ${r.status}).` };
    });
  const remove = (): Promise<void> =>
    run(async () => {
      await secretDelete(props.provider.secret);
      await reload();
      return { ok: true, message: "Removed." };
    });

  return (
    <div class="key-row">
      <div class="key-row-head">
        <span class="settings-row-title">{props.provider.displayName}</span>
        <span class="key-status" classList={{ on: has() }}>{has() ? "Key stored" : "No key"}</span>
        <span class="settings-spacer" />
        <button type="button" class="link-button" onClick={() => void openUrl(props.provider.keyUrl)}>
          Get key <ExternalLink size={11} />
        </button>
      </div>
      <div class="key-row-controls">
        <input
          class="settings-input" type="password" autocomplete="off" spellcheck={false}
          placeholder={has() ? "Enter a new key to replace the stored one" : props.provider.placeholder}
          aria-label={`${props.provider.displayName} API key`} value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft().trim()) void save(); }}
        />
        <CapsuleButton variant="prominent" disabled={busy() || !draft().trim()} onClick={() => void save()}>Save</CapsuleButton>
        <CapsuleButton disabled={busy() || !has()} onClick={() => void test()}>Test</CapsuleButton>
        <CapsuleButton disabled={busy() || !has()} onClick={() => void remove()}>Remove</CapsuleButton>
      </div>
      <Show when={result()}>
        {(r) => <div class="key-result" classList={{ error: !r().ok }} role="status">{r().message}</div>}
      </Show>
    </div>
  );
}

export function ApiKeysPane() {
  return (
    <>
      <SettingsSection title="Provider API keys">
        <div class="settings-row-subtitle">
          Alcor Pro calls each provider directly with your own key. Keys are stored in the Windows Credential Manager and are never shown again.
        </div>
        <For each={allProviders()}>{(p) => <KeyRow provider={p} />}</For>
      </SettingsSection>
      <SettingsSection title="Library sounds">
        <div class="settings-row-subtitle">
          A free Freesound key lets the Library search sounds. Only high-quality MP3 previews are downloaded (full-quality downloads need OAuth).
        </div>
        <For each={agentKeyProviders}>{(p) => <AgentKeyRow provider={p} />}</For>
      </SettingsSection>
    </>
  );
}
