import { notifyCacheCleared } from "./storage";
import { createSignal, onMount } from "solid-js";
import { appPaths, fsList, fsRemove } from "../platform/backend";
import { CapsuleButton } from "../ui/CapsuleButton";
import { SettingsSection } from "./SettingsParts";

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await fsList(path).catch(() => [])) {
    total += entry.isDir ? await directorySize(entry.path) : entry.size;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Port of the Cache section of `StoragePane` (the media-indexing section has no counterpart yet). */
export function StoragePane() {
  const [path, setPath] = createSignal("");
  const [bytes, setBytes] = createSignal(0);
  const [clearing, setClearing] = createSignal(false);

  const refresh = async (): Promise<void> => {
    const p = (await appPaths()).cache;
    setPath(p);
    setBytes(await directorySize(p));
  };
  onMount(() => void refresh().catch(() => undefined));

  const clear = async (): Promise<void> => {
    setClearing(true);
    try {
      for (const entry of await fsList(path()).catch(() => [])) await fsRemove(entry.path).catch(() => undefined);
      notifyCacheCleared();
      await refresh();
    } finally {
      setClearing(false);
    }
  };

  return (
    <SettingsSection title="Cache">
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Temporary files</div>
          <div class="settings-row-subtitle">Playback previews, waveforms, filmstrip thumbnails, and transcripts. Safe to clear; files rebuild as needed.</div>
          <div class="settings-row-subtitle mono">{path()} - {formatBytes(bytes())}</div>
        </div>
        <CapsuleButton disabled={clearing() || bytes() === 0} onClick={() => void clear()}>Clear cache</CapsuleButton>
      </div>
    </SettingsSection>
  );
}
