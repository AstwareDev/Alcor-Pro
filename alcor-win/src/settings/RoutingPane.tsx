import { createSignal, For, onMount, Show } from "solid-js";
import { httpFetch, secretHas } from "../platform/backend";
import { routePrompt } from "../routing/promptRouter";
import { askWhenUnsure, routingModel, routingModels, setAskWhenUnsure, setRoutingModel } from "../routing/routingSettings";
import { CapsuleButton } from "../ui/CapsuleButton";
import { SettingsSection, SettingsToggleRow } from "./SettingsParts";

const kindLabel = { video: "Video", image: "Image", speech: "Speech", sfx: "Sound effect", music: "Music" } as const;

/** Chooses the decision model that turns a free-form prompt into "what to make" and "where it goes". */
export function RoutingPane(props: { goToKeys: () => void }) {
  const [keys, setKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [sample, setSample] = createSignal("Generate a lovely, chill lofi track for my 2x speed video");
  const [result, setResult] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  onMount(async () => {
    const secrets = [...new Set(routingModels.flatMap((m) => (m.secret ? [m.secret] : [])))];
    const present = await Promise.all(secrets.map((s) => secretHas(s).catch(() => false)));
    setKeys(new Set(secrets.filter((_, i) => present[i])));
  });

  const ready = (secret: string | undefined): boolean => secret === undefined || keys().has(secret);

  const test = async (): Promise<void> => {
    setBusy(true);
    setResult(undefined);
    const started = performance.now();
    const r = await routePrompt(sample(), { available: ["video", "image", "speech", "sfx", "music"], hasSelection: false }, routingModel(), httpFetch);
    const ms = Math.round(performance.now() - started);
    const where = r.placement === "timeline" ? "timeline at the playhead" : "media library";
    setResult(
      `${kindLabel[r.kind]} → ${where} · ${Math.round(r.confidence * 100)}% · ${ms} ms` +
        (r.fallbackReason ? ` · used built-in rules (${r.fallbackReason})` : ""),
    );
    setBusy(false);
  };

  return (
    <>
      <SettingsSection title="Routing model">
        <div class="settings-row-subtitle">
          When the prompt bar is on Auto, this model decides whether a request is video, image, speech, a sound effect or music, and
          whether the result goes on the timeline or only into the library. Decision models answer in one fast call and charge only
          for input tokens.
        </div>
        <div class="routing-list" role="radiogroup" aria-label="Routing model">
          <For each={routingModels}>
            {(m) => (
              <label class="routing-row" classList={{ on: routingModel() === m.id }}>
                <input type="radio" name="routing-model" checked={routingModel() === m.id} onChange={() => setRoutingModel(m.id)} />
                <span class="settings-row-text">
                  <span class="settings-row-title">{m.displayName} <span class="routing-vendor">{m.vendor}</span></span>
                  <span class="settings-row-subtitle">{m.description}</span>
                </span>
                <Show when={!ready(m.secret)}>
                  <button type="button" class="link-button" onClick={() => props.goToKeys()}>Add {m.keyLabel} key</button>
                </Show>
              </label>
            )}
          </For>
        </div>
      </SettingsSection>
      <SettingsSection title="Behaviour">
        <SettingsToggleRow
          title="Ask when unsure"
          subtitle="If the model isn't confident, show a quick choice instead of guessing."
          checked={askWhenUnsure()}
          onChange={setAskWhenUnsure}
        />
      </SettingsSection>
      <SettingsSection title="Try it">
        <div class="key-row-controls">
          <input class="settings-input" value={sample()} aria-label="Sample prompt" onInput={(e) => setSample(e.currentTarget.value)} />
          <CapsuleButton disabled={busy() || !sample().trim()} onClick={() => void test()}>Route</CapsuleButton>
        </div>
        <Show when={result()}>{(r) => <div class="key-result" role="status">{r()}</div>}</Show>
      </SettingsSection>
    </>
  );
}
