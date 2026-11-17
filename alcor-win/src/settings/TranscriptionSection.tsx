import { createSignal, For, onMount, Show } from "solid-js";
import { providersWithKeys } from "../generation/providers/registry";
import { formatBytes } from "../library/catalog";
import { whisperModel } from "../ml/modelCatalog";
import { ensureModel, isModelInstalled, modelStatus, modelTotalBytes } from "../ml/modelStore";
import {
  cloudBackendIds, setTranscriptionPreference, transcriptionBackendIds, transcriptionBackendLabel, transcriptionPreference,
  type TranscriptionPreference,
} from "../transcription/transcriptionBackend";
import { CapsuleButton } from "../ui/CapsuleButton";
import { SettingsSection } from "./SettingsParts";

const preferences: readonly TranscriptionPreference[] = ["auto", ...transcriptionBackendIds];

function LocalModelRow() {
  const status = modelStatus(whisperModel);
  const [installed, setInstalled] = createSignal(false);
  onMount(() => void isModelInstalled(whisperModel).then(setInstalled, () => undefined));
  const size = formatBytes(modelTotalBytes(whisperModel));
  const busy = (): boolean => status().phase === "downloading" || status().phase === "verifying";
  const ready = (): boolean => installed() || status().phase === "ready";
  const download = (): void => void ensureModel(whisperModel).then(() => setInstalled(true), () => undefined);

  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title">On this PC</div>
        <div class="settings-row-subtitle">
          Whisper (tiny, multilingual) runs offline on your processor; nothing is uploaded. It is slower than the cloud services
          and less accurate on noisy audio. The model is a one-time {size} download, fetched automatically on first use.
        </div>
        <Show when={status().phase === "error"}>
          <div class="key-result error" role="status">{status().message ?? "Download failed."}</div>
        </Show>
      </div>
      <Show
        when={!ready()}
        fallback={<span class="key-status on">Downloaded</span>}
      >
        <Show
          when={busy()}
          fallback={<CapsuleButton onClick={download}>Download {size}</CapsuleButton>}
        >
          <span class="key-status" role="status">
            {status().phase === "verifying" ? "Verifying…" : `${formatBytes(status().receivedBytes)} of ${formatBytes(status().totalBytes)}`}
          </span>
        </Show>
      </Show>
    </div>
  );
}

export function TranscriptionSection() {
  const keyed = providersWithKeys;
  const label = (p: TranscriptionPreference): string => {
    if (p === "auto") return "Auto";
    const missing = (cloudBackendIds as readonly string[]).includes(p) && !keyed().has(p as (typeof cloudBackendIds)[number]);
    return missing ? `${transcriptionBackendLabel(p)} (no API key)` : transcriptionBackendLabel(p);
  };
  return (
    <SettingsSection title="Transcription">
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Service</div>
          <div class="settings-row-subtitle">
            For captions, transcript search, word cuts and silence tools. Auto uses ElevenLabs Scribe, then OpenAI Whisper when a key is set, and On this PC otherwise.
          </div>
        </div>
        <select
          class="settings-select"
          aria-label="Transcription service"
          value={transcriptionPreference()}
          onChange={(e) => setTranscriptionPreference(e.currentTarget.value as TranscriptionPreference)}
        >
          <For each={preferences}>{(p) => <option value={p}>{label(p)}</option>}</For>
        </select>
      </div>
      <LocalModelRow />
    </SettingsSection>
  );
}
