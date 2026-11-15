// Compact generation bar docked under the preview. Submits through `submitQuickGeneration`, the same
// `generationService.generate` path `GenerationPanel` uses.
import ArrowUp from "lucide-solid/icons/arrow-up";
import ChevronDown from "lucide-solid/icons/chevron-down";
import X from "lucide-solid/icons/x";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { existingTrack, placeDroppedAssets } from "../editor/mutations/linking";
import { captureFrameToMedia } from "../agent/tools/captureTools";
import { cancelGeneration, canCancelGeneration } from "../generation/cancelGeneration";
import { fullCatalog, providersWithKeys } from "../generation/providers/registry";
import { formatUsd } from "../generation/costEstimator";
import { getGenerationService, type GenerationService } from "../generation/generationService";
import { generationProgress } from "../generation/generationState";
import { submitQuickGeneration, validateQuickGeneration } from "../generation/quickGeneration";
import { isModelEnabled } from "../generation/modelPreferences";
import { RefCard, RefDropZone } from "../generation/RefControls";
import { mediaAssetGeneratingLabel, mediaAssetIsGenerating, type ClipType, type MediaAsset } from "../model";
import {
  availableModes, estimateCost, loadHistory, modeClipType, modelsForMode, normalizeOptions, optionDefs, pickModel,
  promptModes, pushHistory, saveHistory, stepHistory, toSettings, validateOptions,
  type PromptMode, type PromptOptions,
} from "./promptModel";
import "./PromptBar.css";

const storage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);
const read = (key: string): string | undefined => {
  try { return storage()?.getItem(key) ?? undefined; } catch { return undefined; }
};
const write = (key: string, value: string): void => {
  try { storage()?.setItem(key, value); } catch { /* preference only */ }
};
const readModels = (): Record<string, string> => {
  try { return JSON.parse(read("promptbar.models") ?? "{}") as Record<string, string>; } catch { return {}; }
};

const maxLines = 6;
const referenceTypes: ReadonlySet<ClipType> = new Set<ClipType>(["image", "video", "audio"]);

export function PromptBar(props: {
  editor: Editor;
  /** Opens Settings (the "Add key" action). */
  onOpenSettings: () => void;
  service?: GenerationService;
}) {
  const editor = props.editor;
  const service = (): GenerationService => props.service ?? getGenerationService();

  const [mode, setMode] = createSignal<PromptMode>((read("promptbar.mode") as PromptMode | undefined) ?? "video");
  const [prompt, setPrompt] = createSignal("");
  const [options, setOptions] = createSignal<Partial<PromptOptions>>({});
  const [refs, setRefs] = createSignal<MediaAsset[]>([]);
  const [insert, setInsert] = createSignal(read("promptbar.insert") === "1");
  const [error, setError] = createSignal<string>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [capturing, setCapturing] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [history, setHistory] = createSignal(loadHistory(storage()));
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [modelIds, setModelIds] = createSignal<Record<string, string>>(readModels());
  let input!: HTMLTextAreaElement;
  let root!: HTMLDivElement;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let draft = "";
  onCleanup(() => clearTimeout(errorTimer));

  const flash = (message: string): void => {
    clearTimeout(errorTimer);
    setError(message);
    errorTimer = setTimeout(() => setError(undefined), 4000);
  };

  // MARK: modes and models

  const modes = createMemo(() => availableModes(fullCatalog(), isModelEnabled));
  const activeMode = (): PromptMode => (modes().includes(mode()) ? mode() : modes()[0] ?? "video");
  const models = createMemo(() => modelsForMode(activeMode(), fullCatalog(), isModelEnabled, (e) => providersWithKeys().has(e.providerId)));
  const model = createMemo(() => pickModel(models(), modelIds()[activeMode()]));
  const entry = () => model()?.entry;
  const opts = createMemo<PromptOptions | undefined>(() => {
    const e = entry();
    return e ? normalizeOptions(e, options()) : undefined;
  });
  const defs = createMemo(() => { const e = entry(); return e ? optionDefs(e) : []; });
  const cost = createMemo(() => { const e = entry(), o = opts(); return e && o ? estimateCost(e, prompt(), o) : undefined; });

  const chooseMode = (next: PromptMode): void => {
    setMode(next);
    write("promptbar.mode", next);
    setMenuOpen(false);
    setRefs([]);
    setError(undefined);
  };
  const chooseModel = (id: string): void => {
    const next = { ...modelIds(), [activeMode()]: id };
    setModelIds(next);
    write("promptbar.models", JSON.stringify(next));
    setMenuOpen(false);
  };
  const setOption = (key: keyof PromptOptions, raw: string): void => {
    const current = opts();
    if (!current) return;
    const value = key === "duration" || key === "numImages" ? Number(raw) : raw;
    setOptions({ ...current, [key]: value });
  };

  // MARK: references

  const addRef = (asset: MediaAsset): void => {
    if (refs().some((r) => r.id === asset.id)) return;
    if (!referenceTypes.has(asset.type)) return flash(`${asset.name} cannot be used as a reference.`);
    setRefs([...refs(), asset]);
  };
  const selectedClipAsset = (): MediaAsset | undefined => {
    const ids = editor.ui.selectedClipIds;
    for (const track of editor.timeline.tracks) {
      for (const clip of track.clips) {
        if (!ids.has(clip.id)) continue;
        const asset = editor.mediaAsset(clip.mediaRef);
        if (asset && referenceTypes.has(asset.type)) return asset;
      }
    }
    return undefined;
  };
  const addCurrentFrame = async (): Promise<void> => {
    if (capturing()) return;
    setCapturing(true);
    try {
      const receipt = await captureFrameToMedia(editor, { kind: "timeline", frame: editor.ui.currentFrame });
      addRef(receipt.asset);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  };

  // MARK: input

  const fit = (): void => {
    input.style.height = "auto";
    const line = parseFloat(getComputedStyle(input).lineHeight) || 18;
    const max = line * maxLines;
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  };
  createEffect(on(prompt, () => queueMicrotask(() => input && fit())));

  const recall = (direction: "older" | "newer"): void => {
    const list = history();
    const next = stepHistory(list.length, historyIndex(), direction);
    if (next === historyIndex()) return;
    if (historyIndex() === -1) draft = prompt();
    setHistoryIndex(next);
    setPrompt(next === -1 ? draft : list[next]);
  };

  const submit = (): void => {
    const e = entry(), o = opts(), m = model();
    if (!e || !o || !m) return;
    if (!m.usable) return props.onOpenSettings();
    const text = prompt();
    const settings = toSettings(e, text, o);
    const invalid = validateOptions(e, o) ?? validateQuickGeneration({ entry: e, settings, references: refs() });
    if (invalid) return flash(invalid);
    const frame = editor.ui.currentFrame;
    const result = submitQuickGeneration(editor, service(), {
      entry: e, settings, references: refs(),
      ...(insert() ? { onComplete: (asset: MediaAsset) => placeDroppedAssets(editor, [asset], existingTrack(0), frame, { ripple: false }) } : {}),
    });
    if ("error" in result) return flash(result.error);
    const next = pushHistory(history(), text);
    setHistory(next);
    saveHistory(storage(), next);
    setHistoryIndex(-1);
    setPrompt("");
    setRefs([]);
    setError(undefined);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      setMenuOpen(false);
      input.blur();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      if (prompt() === "" || historyIndex() >= 0) {
        e.preventDefault();
        recall(e.key === "ArrowUp" ? "older" : "newer");
      }
    }
  };

  onMount(() => {
    const onWindowKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.focus();
      }
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (menuOpen() && !root.querySelector(".pb-model")?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onWindowKey);
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onWindowKey);
      window.removeEventListener("pointerdown", onPointerDown);
    });
    fit();
  });

  // MARK: running jobs

  const jobs = createMemo(() =>
    editor.mediaAssets.filter((a) => mediaAssetIsGenerating(a) && (a.generationInput?.outputIndex ?? 0) === 0 && !dismissed().has(a.id)),
  );
  const cancel = (asset: MediaAsset): void => {
    setDismissed(new Set([...dismissed(), asset.id]));
    void cancelGeneration(asset);
  };

  const placeholder = (): string => {
    switch (activeMode()) {
      case "video": return "Describe a video";
      case "image": return "Describe an image";
      case "speech": return "Text to speak";
      case "sfx": return "Describe the sound";
      case "music": return "Describe the music";
    }
  };

  return (
    <div ref={root} class="promptbar" data-clip-type={modeClipType(activeMode())}>
      <Show when={jobs().length > 0}>
        <div class="pb-jobs">
          <For each={jobs()}>
            {(asset) => (
              <div class="pb-job">
                <span class="pb-job-name">{asset.name || "Generating"}</span>
                <span class="pb-job-state">{mediaAssetGeneratingLabel(asset)}</span>
                <span class="pb-job-bar">
                  <span
                    class="pb-job-fill"
                    classList={{ auto: generationProgress(asset.id) === undefined }}
                    style={generationProgress(asset.id) === undefined ? undefined : { transform: `scaleX(${generationProgress(asset.id)})` }}
                  />
                </span>
                <Show when={canCancelGeneration(asset)}>
                  <button type="button" class="pb-icon" title="Cancel" aria-label={`Cancel ${asset.name}`} onClick={() => cancel(asset)}>
                    <X size={11} />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="pb-input-row">
        <textarea
          ref={input}
          class="pb-input"
          rows={1}
          spellcheck={false}
          placeholder={`${placeholder()} (Ctrl+K)`}
          aria-label="Generation prompt"
          value={prompt()}
          onInput={(e) => { setHistoryIndex(-1); setPrompt(e.currentTarget.value); }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="pb-send"
          disabled={!entry()}
          title={model()?.usable === false ? "Add key" : cost() !== undefined ? `Generate · ${formatUsd(cost())}` : "Generate"}
          aria-label="Generate"
          onClick={submit}
        >
          <ArrowUp size={14} />
        </button>
      </div>

      <Show when={error()}>{(message) => <div class="pb-error" role="alert">{message()}</div>}</Show>

      <div class="pb-row">
        <div class="pb-modes" role="tablist" aria-label="Generation mode">
          <For each={promptModes.filter((m) => modes().includes(m.id))}>
            {(m) => (
              <button type="button" role="tab" class="pb-chip" classList={{ on: activeMode() === m.id }} aria-selected={activeMode() === m.id} onClick={() => chooseMode(m.id)}>
                {m.label}
              </button>
            )}
          </For>
        </div>

        <div class="pb-model">
          <button type="button" class="pb-select" classList={{ dim: model()?.usable === false }} aria-haspopup="listbox" aria-expanded={menuOpen()} onClick={() => setMenuOpen(!menuOpen())}>
            <span class="pb-select-label">{entry()?.displayName ?? "No models"}</span>
            <ChevronDown size={11} />
          </button>
          <div class="pb-menu" classList={{ open: menuOpen() }} role="listbox" aria-hidden={!menuOpen()}>
            <For each={models()}>
              {(m) => (
                <div class="pb-menu-row" classList={{ dim: !m.usable, selected: m.entry.id === entry()?.id }}>
                  <button type="button" class="pb-menu-pick" role="option" aria-selected={m.entry.id === entry()?.id} tabIndex={menuOpen() ? 0 : -1} onClick={() => chooseModel(m.entry.id)}>
                    {m.entry.displayName}
                  </button>
                  <Show when={!m.usable}>
                    <button type="button" class="pb-addkey" tabIndex={menuOpen() ? 0 : -1} onClick={() => { setMenuOpen(false); props.onOpenSettings(); }}>
                      Add key
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>

        <For each={defs()}>
          {(def) => (
            <select class="pb-select pb-opt" title={def.label} aria-label={def.label} value={String(opts()?.[def.key] ?? "")} onChange={(e) => setOption(def.key, e.currentTarget.value)}>
              <For each={def.choices}>{(c) => <option value={c.value}>{c.label}</option>}</For>
            </select>
          )}
        </For>
        <Show when={cost() !== undefined}>
          <span class="pb-cost" title="Estimated cost. Actual billing may differ.">~{formatUsd(cost())}</span>
        </Show>
      </div>

      <div class="pb-row">
        <For each={refs()}>
          {(asset) => <RefCard asset={asset} onRemove={() => setRefs(refs().filter((r) => r.id !== asset.id))} />}
        </For>
        <button type="button" class="pb-chip ghost" disabled={selectedClipAsset() === undefined} title="Use the selected timeline clip as a reference" onClick={() => { const a = selectedClipAsset(); if (a) addRef(a); }}>
          Selected clip
        </button>
        <button type="button" class="pb-chip ghost" disabled={capturing()} title="Capture the frame at the playhead as a reference" onClick={() => void addCurrentFrame()}>
          Current frame
        </button>
        <RefDropZone editor={editor} accepting={referenceTypes} icon="plus" onDrop={addRef} />
        <span class="pb-spacer" />
        <label class="pb-toggle" title="Place the result on the timeline at the playhead when it finishes">
          <input type="checkbox" checked={insert()} onChange={(e) => { setInsert(e.currentTarget.checked); write("promptbar.insert", e.currentTarget.checked ? "1" : "0"); }} />
          <span class="pb-switch" />
          <span>Insert at playhead</span>
        </label>
      </div>
    </div>
  );
}
