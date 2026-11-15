import Check from "lucide-solid/icons/check";
import Pause from "lucide-solid/icons/pause";
import Play from "lucide-solid/icons/play";
import Plus from "lucide-solid/icons/plus";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { assetDragString } from "../mediapanel/dragPayload";
import { armMediaDrag } from "../mediapanel/dragSession";
import { CapsuleButton } from "../ui/CapsuleButton";
import type { SavedSound } from "./attribution";
import type { SoundResult } from "./freesound";
import { MissingKeyError, type LibraryController } from "./libraryController";

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Freesound search plus the sounds already downloaded. Only CC0 / CC BY sounds are requested. */
export function SoundsView(props: { editor: Editor; controller: LibraryController; onOpenSettings: () => void }) {
  const c = props.controller;
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SoundResult[]>([]);
  const [page, setPage] = createSignal(1);
  const [hasNext, setHasNext] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [needsKey, setNeedsKey] = createSignal(false);
  const [adding, setAdding] = createSignal<ReadonlySet<number>>(new Set());
  const [playing, setPlaying] = createSignal<number | undefined>();
  let audio: HTMLAudioElement | undefined;

  onMount(() => void c.hasSoundKey().then((has) => setNeedsKey(!has)));
  onCleanup(() => audio?.pause());

  const search = async (next: number): Promise<void> => {
    const q = query().trim();
    if (q === "") return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await c.searchSounds(q, next);
      setNeedsKey(false);
      setResults(next === 1 ? result.results : [...results(), ...result.results]);
      setPage(next);
      setHasNext(result.hasNext);
    } catch (e) {
      if (e instanceof MissingKeyError) setNeedsKey(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = (sound: { id: number; previewUrl?: string; path?: string }): void => {
    if (playing() === sound.id) {
      audio?.pause();
      setPlaying(undefined);
      return;
    }
    audio?.pause();
    const src = sound.previewUrl ?? sound.path;
    if (!src) return;
    audio = new Audio(src);
    audio.onended = () => setPlaying(undefined);
    audio.onerror = () => setPlaying(undefined);
    void audio.play().then(() => setPlaying(sound.id)).catch(() => setPlaying(undefined));
  };

  const add = async (sound: SoundResult): Promise<void> => {
    setAdding(new Set([...adding(), sound.id]));
    try {
      await c.addSound(props.editor, sound);
      props.editor.showToast(`Added "${sound.name}" to the project`);
    } catch (e) {
      props.editor.refuseWithToast(`Could not download the sound: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(new Set([...adding()].filter((id) => id !== sound.id)));
    }
  };

  // A saved sound is already on disk, so the empty preview URL is never fetched.
  const asResult = (s: SoundResult | SavedSound): SoundResult => ("previewUrl" in s ? s : { ...s, previewUrl: "", tags: [] });
  const savedFor = (id: number): SavedSound | undefined => c.savedSounds().find((s) => s.id === id);
  const draggableAsset = (id: number): string | undefined => {
    const assetId = savedFor(id)?.assetId;
    return assetId !== undefined && props.editor.mediaAsset(assetId) ? assetId : undefined;
  };

  const row = (sound: SoundResult | SavedSound) => {
    const id = sound.id;
    const licence = sound.licence;
    const previewUrl = "previewUrl" in sound ? sound.previewUrl : undefined;
    const asset = (): string | undefined => draggableAsset(id);
    return (
      <div
        class="lib-sound"
        classList={{ draggable: asset() !== undefined }}
        title={asset() ? "Drag onto the timeline" : sound.name}
        onPointerDown={(e) => {
          const assetId = asset();
          if (assetId === undefined || (e.target as HTMLElement).closest("button")) return;
          armMediaDrag(e, () => ({ payload: assetDragString(assetId), label: sound.name, count: 1 }));
        }}
      >
        <button
          type="button"
          class="lib-icon-btn hover-highlight"
          aria-label={playing() === id ? "Pause preview" : "Play preview"}
          onClick={() => togglePlay(previewUrl !== undefined ? { id, previewUrl } : { id, path: (sound as SavedSound).path })}
        >
          <Show when={playing() === id} fallback={<Play size={12} />}><Pause size={12} /></Show>
        </button>
        <div class="lib-sound-text">
          <span class="lib-sound-name">{sound.name}</span>
          <span class="lib-sound-meta">
            {sound.username} · {duration(sound.durationSeconds)} ·{" "}
            <a class="lib-link" href={licence.url} onClick={(e) => { e.preventDefault(); if (licence.url) void c.openUrl(licence.url); }}>{licence.name}</a>
          </span>
        </div>
        <Show
          when={asset() === undefined}
          fallback={<span class="lib-added" title="In this project"><Check size={12} /></span>}
        >
          <CapsuleButton disabled={adding().has(id)} onClick={() => void add(asResult(sound))} aria-label={`Add ${sound.name} to project`}>
            <Plus size={11} /> Add
          </CapsuleButton>
        </Show>
      </div>
    );
  };

  return (
    <div class="lib-sounds">
      <div class="lib-sound-search">
        <input
          class="lib-input"
          type="search"
          placeholder="Search Freesound (CC0 and CC BY)"
          aria-label="Search sounds"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(1); }}
        />
        <CapsuleButton variant="prominent" disabled={busy() || query().trim() === ""} onClick={() => void search(1)}>Search</CapsuleButton>
      </div>
      <Show when={needsKey()}>
        <div class="lib-note">
          Sound search needs a free Freesound API key.
          <CapsuleButton onClick={props.onOpenSettings}>Add key in Settings</CapsuleButton>
        </div>
      </Show>
      <Show when={error()}>{(message) => <div class="lib-note error" role="alert">{message()}</div>}</Show>
      <div class="lib-list">
        <Show when={results().length > 0}>
          <For each={results()}>{(s) => row(s)}</For>
          <Show when={hasNext()}>
            <CapsuleButton disabled={busy()} onClick={() => void search(page() + 1)}>Load more</CapsuleButton>
          </Show>
        </Show>
        <Show when={results().length === 0 && !busy() && !needsKey() && query().trim() !== "" && error() === undefined}>
          <div class="lib-empty">Press Enter to search.</div>
        </Show>
        <Show when={c.savedSounds().length > 0}>
          <div class="lib-list-title">In your library</div>
          <For each={c.savedSounds()}>{(s) => row(s)}</For>
        </Show>
        <Show when={results().length === 0 && c.savedSounds().length === 0 && !needsKey()}>
          <div class="lib-empty">Search for sound effects and ambience. Previews are downloaded at MP3 quality with their licence recorded for the Attribution export.</div>
        </Show>
      </div>
    </div>
  );
}
