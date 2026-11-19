// One general prompt bar floating at the bottom of the timeline: a small pill that expands on hover or focus. On "Auto" a decision model (Settings → Prompt bar) works out what to make
// (video, image, speech, sound effect, music) and where it goes; generation runs through `submitQuickGeneration`, the
// same `generationService.generate` path `GenerationPanel` uses.
import ArrowUp from "lucide-solid/icons/arrow-up";
import CircleAlert from "lucide-solid/icons/circle-exclamation-point";
import EllipsisVertical from "lucide-solid/icons/ellipsis-vertical";
import Plus from "lucide-solid/icons/plus";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import Check from "lucide-solid/icons/check";
import X from "lucide-solid/icons/x";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { existingTrack, placeDroppedAssets } from "../editor/mutations/linking";
import { selectMediaPanelItemAndReveal } from "../editor/mutations/mediaPanel";
import { GenerateGlyph } from "../ui/GenerateGlyph";
import { captureFrameToMedia } from "../agent/tools/captureTools";
import { cancelGeneration, canCancelGeneration } from "../generation/cancelGeneration";
import { fullCatalog, providersWithKeys } from "../generation/providers/registry";
import type { ProviderId } from "../generation/providers/types";
import { formatUsd } from "../generation/costEstimator";
import { getGenerationService, type GenerationService } from "../generation/generationService";
import { generationProgress } from "../generation/generationState";
import { formatTimecode } from "./jobFormat";
import { submitQuickGeneration, validateQuickGeneration } from "../generation/quickGeneration";
import { isModelEnabled } from "../generation/modelPreferences";
import { assetsFromDragPayload } from "../generation/RefControls";
import { activeMediaDrag, mediaDropEventName, type MediaDropDetail } from "../mediapanel/dragSession";
import { mediaAssetGeneratingLabel, mediaAssetIsGenerating, timelineTotalFrames, type ClipType, type MediaAsset } from "../model";
import { httpFetch, type HttpRequest, type HttpResponse } from "../platform/backend";
import { nearestChoice, parseDurationSeconds, routePrompt, type Placement, type Route } from "../routing/promptRouter";
import { askThreshold, askWhenUnsure, routingModel, routingModels } from "../routing/routingSettings";
import {
  availableModes, entryInMode, estimateCost, loadHistory, modelsForMode, normalizeOptions, optionDefs, pickModel, promptModes,
  pushHistory, saveHistory, splitDetail, stepHistory, toSettings, validateOptions, type PromptMode, type PromptOptions,
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

type Kind = "auto" | PromptMode;
type PlacementPref = "auto" | Placement;
type Popover = "add" | "settings" | "more";

/** A generation from this bar that just finished; shown for a few seconds with a way to find it. */
interface Finished { id: string; name: string; kind: string; where: string }
const finishedVisibleMs = 6000;

/** A problem explained in the card above the bar. */
interface Explanation {
  title: string;
  message: string;
  detail?: string;
  retry?: () => void;
  changeModel?: boolean;
  openSettings?: boolean;
}

const maxLines = 6;
const referenceTypes: ReadonlySet<ClipType> = new Set<ClipType>(["image", "video", "audio"]);
const modeLabel = (m: PromptMode): string => promptModes.find((p) => p.id === m)?.label ?? m;

export function PromptBar(props: {
  editor: Editor;
  /** Opens Settings (missing keys, routing model). */
  onOpenSettings: () => void;
  service?: GenerationService;
  /** Injected in the dev page; defaults to the Rust HTTP proxy. */
  fetch?: (req: HttpRequest) => Promise<HttpResponse>;
}) {
  const editor = props.editor;
  const service = (): GenerationService => props.service ?? getGenerationService();

  const storedKind = read("promptbar.kind");
  const [kind, setKind] = createSignal<Kind>(storedKind === undefined ? "auto" : (storedKind as Kind));
  const [placementPref, setPlacementPref] = createSignal<PlacementPref>((read("promptbar.placement") as PlacementPref | undefined) ?? "auto");
  const [prompt, setPrompt] = createSignal("");
  const [options, setOptions] = createSignal<Partial<PromptOptions>>({});
  const [refs, setRefs] = createSignal<MediaAsset[]>([]);
  const [status, setStatus] = createSignal<string>();
  const [explanation, setExplanation] = createSignal<Explanation>();
  const [explaining, setExplaining] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [popover, setPopover] = createSignal<Popover>();
  const [routing, setRouting] = createSignal(false);
  const [clarify, setClarify] = createSignal<{ text: string; route: Route }>();
  const [dropHover, setDropHover] = createSignal(false);
  const [capturing, setCapturing] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [history, setHistory] = createSignal(loadHistory(storage()));
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [modelIds, setModelIds] = createSignal<Record<string, string>>(readModels());
  let input!: HTMLTextAreaElement;
  let root!: HTMLDivElement;
  let pill!: HTMLDivElement;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let draft = "";
  onCleanup(() => clearTimeout(statusTimer));

  const say = (text: string): void => {
    clearTimeout(statusTimer);
    setStatus(text);
    statusTimer = setTimeout(() => setStatus(undefined), 3500);
  };
  const explain = (e: Explanation): void => {
    clearTimeout(statusTimer);
    setStatus(undefined);
    setPopover(undefined);
    setExplanation({ ...e, ...splitDetail(e.message) });
    setExplaining(true);
  };
  const dismissExplanation = (): void => { setExplaining(false); };

  // MARK: kinds, models, options

  const modes = createMemo(() => availableModes(fullCatalog(), isModelEnabled));
  const hasKey = (providerId: ProviderId): boolean => providersWithKeys().has(providerId);
  const modelsFor = (m: PromptMode) => modelsForMode(m, fullCatalog(), isModelEnabled, (e) => hasKey(e.providerId));
  const modelFor = (m: PromptMode) => pickModel(modelsFor(m), modelIds()[m]);
  const fixedKind = (): PromptMode | undefined => {
    const k = kind();
    return k !== "auto" && modes().includes(k) ? k : undefined;
  };
  const fixedEntry = createMemo(() => { const k = fixedKind(); return k ? modelFor(k)?.entry : undefined; });
  const fixedOpts = createMemo<PromptOptions | undefined>(() => { const e = fixedEntry(); return e ? normalizeOptions(e, options()) : undefined; });
  const fixedDefs = createMemo(() => { const e = fixedEntry(); return e ? optionDefs(e) : []; });
  const fixedCost = createMemo(() => { const e = fixedEntry(), o = fixedOpts(); return e && o ? estimateCost(e, prompt(), o) : undefined; });

  const chooseKind = (next: Kind): void => {
    setKind(next);
    write("promptbar.kind", next);
    setOptions({});
  };
  const choosePlacement = (next: PlacementPref): void => {
    setPlacementPref(next);
    write("promptbar.placement", next);
  };
  const chooseModel = (m: PromptMode, id: string): void => {
    const next = { ...modelIds(), [m]: id };
    setModelIds(next);
    write("promptbar.models", JSON.stringify(next));
    if (m === fixedKind()) setOptions({});
  };
  const setOption = (key: keyof PromptOptions, raw: string): void => {
    const current = fixedOpts();
    if (!current) return;
    setOptions({ ...current, [key]: key === "duration" || key === "numImages" ? Number(raw) : raw });
  };

  // MARK: references

  const addRef = (asset: MediaAsset): void => {
    if (refs().some((r) => r.id === asset.id)) return;
    if (!referenceTypes.has(asset.type)) return explain({ title: "Can't use that as a reference", message: `${asset.name} isn't an image, video or audio file.` });
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
    setPopover(undefined);
    try {
      addRef((await captureFrameToMedia(editor, { kind: "timeline", frame: editor.ui.currentFrame })).asset);
    } catch (e) {
      explain({ title: "Couldn't capture the frame", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setCapturing(false);
    }
  };

  // MARK: generation

  const remainingSeconds = (): number => {
    const t = editor.timeline;
    return Math.max(0, timelineTotalFrames(t) - editor.ui.currentFrame) / t.fps;
  };

  /** Generates `text` as `mode`. `route` carries Auto's decisions; a fixed kind uses the bar's own options. */
  const generate = (text: string, mode: PromptMode, route: Route | undefined, references: MediaAsset[]): boolean => {
    const m = modelFor(mode);
    const label = modeLabel(mode).toLowerCase();
    if (!m) {
      explain({ title: `No ${label} models`, message: `Turn on a ${label} model in Settings → Models.`, openSettings: true });
      return false;
    }
    if (!m.usable) {
      explain({
        title: `${m.entry.displayName} needs an API key`,
        message: `Add the provider's key in Settings → API keys, or pick a ${label} model you already have a key for.`,
        openSettings: true, changeModel: true,
      });
      return false;
    }
    const e = m.entry;
    const placement: Placement = placementPref() !== "auto" ? (placementPref() as Placement) : route?.placement ?? "library";
    let o = mode === fixedKind() ? normalizeOptions(e, options()) : normalizeOptions(e, {});
    const durationDef = optionDefs(e).find((d) => d.key === "duration");
    const wanted = parseDurationSeconds(text) ?? (placement === "timeline" && (mode === "music" || mode === "sfx") ? remainingSeconds() : undefined);
    if (durationDef && wanted !== undefined && wanted > 0) {
      const snapped = nearestChoice(durationDef.choices.map((c) => Number(c.value)).filter(Number.isFinite), wanted);
      if (snapped !== undefined) o = { ...o, duration: snapped };
    }
    const selection = route?.useSelection ? selectedClipAsset() : undefined;
    const allRefs = selection && !references.some((r) => r.id === selection.id) ? [...references, selection] : references;
    const settings = toSettings(e, text, o);
    const invalid = validateOptions(e, o) ?? validateQuickGeneration({ entry: e, settings, references: allRefs });
    if (invalid) { explain({ title: "Can't generate yet", message: invalid, changeModel: true }); return false; }
    const frame = editor.ui.currentFrame;
    let submittedId: string | undefined;
    const onFailure = (): void => {
      const status = submittedId === undefined ? undefined : editor.mediaAsset(submittedId)?.generationStatus;
      explain({
        title: `${modeLabel(mode)} with ${e.displayName} failed`,
        message: status?.kind === "failed" ? status.message : "The provider didn't return a result.",
        retry: () => { if (generate(text, mode, route, references)) dismissExplanation(); },
        changeModel: true,
      });
    };
    const onComplete = (asset: MediaAsset): void => {
      if (placement === "timeline") placeDroppedAssets(editor, [asset], existingTrack(0), frame, { ripple: false });
      markFinished({
        id: asset.id, name: asset.name || text, kind: modeLabel(mode),
        where: placement === "timeline" ? `On the timeline at ${formatTimecode(frame / editor.timeline.fps)}` : "In the library",
      });
    };
    const result = submitQuickGeneration(editor, service(), { entry: e, settings, references: allRefs, onFailure, onComplete });
    if ("error" in result) { explain({ title: `Couldn't start ${label}`, message: result.error, changeModel: true }); return false; }
    submittedId = result.id;
    const via = route?.source === "model" ? ` · ${routingModels.find((r) => r.id === routingModel())?.displayName}` : "";
    say(`${modeLabel(mode)} with ${e.displayName} → ${placement === "timeline" ? "timeline" : "library"}${via}`);
    return true;
  };

  const finish = (text: string): void => {
    const next = pushHistory(history(), text);
    setHistory(next);
    saveHistory(storage(), next);
    setHistoryIndex(-1);
    setPrompt("");
    setRefs([]);
  };

  const submit = async (): Promise<void> => {
    const text = prompt().trim();
    if (!text || routing()) return;
    setPopover(undefined);
    setClarify(undefined);
    dismissExplanation();
    const fixed = fixedKind();
    if (fixed) {
      if (generate(text, fixed, undefined, refs())) finish(text);
      return;
    }
    setRouting(true);
    const route = await routePrompt(
      text,
      { available: modes(), hasSelection: selectedClipAsset() !== undefined },
      routingModel(),
      props.fetch ?? httpFetch,
    ).finally(() => setRouting(false));
    if (askWhenUnsure() && route.confidence < askThreshold && modes().length > 1) {
      setClarify({ text, route });
      return;
    }
    if (generate(text, route.kind, route, refs())) finish(text);
  };

  const resolveClarify = (mode: PromptMode): void => {
    const c = clarify();
    if (!c) return;
    setClarify(undefined);
    if (generate(c.text, mode, { ...c.route, kind: mode }, refs())) finish(c.text);
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

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      setPopover(undefined);
      setClarify(undefined);
      dismissExplanation();
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
      if (e.key === "Escape" && (popover() || explaining())) {
        e.preventDefault();
        setPopover(undefined);
        dismissExplanation();
        return;
      }
      // "/" focuses the bar unless the user is already typing somewhere; Ctrl+K stays "split at playhead".
      const target = e.target as HTMLElement | null;
      const typing = target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey && !typing) {
        e.preventDefault();
        input.focus();
      }
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (popover() && !(e.target as Element).closest?.(".pb-anchor")) setPopover(undefined);
      if (explaining() && !(e.target as Element).closest?.(".promptbar")) dismissExplanation();
    };
    const onDrop = (e: Event): void => {
      setDropHover(false);
      for (const asset of assetsFromDragPayload(editor, (e as CustomEvent<MediaDropDetail>).detail.payload)) addRef(asset);
    };
    const enter = (): void => { setDropHover(activeMediaDrag() !== null); };
    const leave = (): void => { setDropHover(false); };
    window.addEventListener("keydown", onWindowKey);
    window.addEventListener("pointerdown", onPointerDown);
    pill.addEventListener(mediaDropEventName, onDrop);
    pill.addEventListener("pointerenter", enter);
    pill.addEventListener("pointermove", enter);
    pill.addEventListener("pointerleave", leave);
    onCleanup(() => {
      window.removeEventListener("keydown", onWindowKey);
      window.removeEventListener("pointerdown", onPointerDown);
      pill.removeEventListener(mediaDropEventName, onDrop);
      pill.removeEventListener("pointerenter", enter);
      pill.removeEventListener("pointermove", enter);
      pill.removeEventListener("pointerleave", leave);
    });
    fit();
  });

  const toggle = (p: Popover): void => { setPopover(popover() === p ? undefined : p); };
  const changeModel = (): void => { dismissExplanation(); setPopover("settings"); };

  /** Hover expands the pill through CSS; these keep it expanded while the bar is in use. */
  const open = (): boolean =>
    focused() || prompt() !== "" || popover() !== undefined || clarify() !== undefined || explaining()
    || dropHover() || routing() || refs().length > 0;

  // MARK: running jobs

  const jobs = createMemo(() =>
    editor.mediaAssets.filter((a) => mediaAssetIsGenerating(a) && (a.generationInput?.outputIndex ?? 0) === 0 && !dismissed().has(a.id)),
  );
  const startedAt = new Map<string, number>();
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (jobs().length === 0) return;
    for (const a of jobs()) if (!startedAt.has(a.id)) startedAt.set(a.id, Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = (a: MediaAsset): string => formatTimecode(Math.max(0, now() - (startedAt.get(a.id) ?? now())) / 1000);
  const jobEntry = (a: MediaAsset) => {
    const id = a.generationInput?.model;
    return id === undefined ? undefined : fullCatalog().find((c) => c.id === id);
  };
  const jobKind = (a: MediaAsset): string => {
    const entry = jobEntry(a);
    const mode = entry ? promptModes.find((m) => entryInMode(entry, m.id)) : undefined;
    return mode?.label ?? (a.type === "audio" ? "Audio" : a.type === "image" ? "Image" : "Video");
  };
  const jobPercent = (a: MediaAsset): string | undefined => {
    const p = generationProgress(a.id);
    return p === undefined ? undefined : `${Math.round(p * 100)}%`;
  };

  const [finished, setFinished] = createSignal<Finished[]>([]);
  const finishTimers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => finishTimers.forEach(clearTimeout));
  const markFinished = (f: Finished): void => {
    if (finished().some((x) => x.id === f.id)) return;
    setFinished([f, ...finished()].slice(0, 3));
    const timer = setTimeout(() => { finishTimers.delete(timer); setFinished(finished().filter((x) => x.id !== f.id)); }, finishedVisibleMs);
    finishTimers.add(timer);
  };
  /** One line for the collapsed pill while something is running or just finished. */
  const live = createMemo<{ text: string; done: boolean } | undefined>(() => {
    const running = jobs();
    if (running.length > 0) {
      const more = running.length > 1 ? ` +${running.length - 1}` : "";
      return { text: `Generating ${jobKind(running[0]).toLowerCase()} · ${elapsed(running[0])}${more}`, done: false };
    }
    const f = finished()[0];
    return f ? { text: `${f.kind} ready`, done: true } : undefined;
  });

  // MARK: cursor glow (rAF-batched; only two custom properties change)

  onMount(() => {
    const area = root.parentElement;
    if (!area) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = (): void => {
      frame = 0;
      const r = pill.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const near = Math.max(0, 1 - Math.hypot(dx, dy) / 220);
      pill.style.setProperty("--mx", `${(x - r.left).toFixed(1)}px`);
      pill.style.setProperty("--my", `${(y - r.top).toFixed(1)}px`);
      pill.style.setProperty("--near", near.toFixed(3));
    };
    const move = (e: PointerEvent): void => {
      x = e.clientX;
      y = e.clientY;
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    const leave = (): void => { pill.style.setProperty("--near", "0"); };
    area.addEventListener("pointermove", move, { passive: true });
    area.addEventListener("pointerleave", leave);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerleave", leave);
    });
  });
  const cancel = (asset: MediaAsset): void => {
    setDismissed(new Set([...dismissed(), asset.id]));
    void cancelGeneration(asset);
  };

  const placeholder = (): string => {
    switch (fixedKind()) {
      case "video": return "Describe a video";
      case "image": return "Describe an image";
      case "speech": return "Text to speak";
      case "sfx": return "Describe a sound effect";
      case "music": return "Describe the music";
      default: return "Describe anything to create";
    }
  };

  const ModelSelect = (p: { mode: PromptMode }) => (
    <select
      class="pb-select"
      aria-label={`${modeLabel(p.mode)} model`}
      value={modelFor(p.mode)?.entry.id ?? ""}
      onChange={(e) => chooseModel(p.mode, e.currentTarget.value)}
    >
      <For each={modelsFor(p.mode)}>
        {(m) => <option value={m.entry.id}>{m.usable ? m.entry.displayName : `${m.entry.displayName} (needs key)`}</option>}
      </For>
    </select>
  );

  return (
    <div
      ref={root}
      class="promptbar"
      data-tour="promptBar"
      classList={{ open: open() }}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(e) => setFocused(root.contains(e.relatedTarget as Node | null))}
    >
      <div
        class="pb-alert"
        classList={{ open: explaining() }}
        role="alertdialog"
        aria-hidden={!explaining()}
        aria-labelledby="pb-alert-title"
        aria-describedby="pb-alert-body"
      >
        <Show when={explanation()}>
          {(x) => (
            <>
              <div class="pb-alert-head">
                <span class="pb-alert-icon"><CircleAlert size={15} /></span>
                <div class="pb-alert-title" id="pb-alert-title">{x().title}</div>
                <button type="button" class="pb-x" aria-label="Dismiss" tabIndex={explaining() ? 0 : -1} onClick={dismissExplanation}>
                  <X size={12} />
                </button>
              </div>
              <p class="pb-alert-body" id="pb-alert-body">{x().message}</p>
              <Show when={x().detail}>{(d) => <p class="pb-alert-detail">{d()}</p>}</Show>
              <div class="pb-alert-actions">
                <Show when={x().openSettings}>
                  <button type="button" class="pb-btn" tabIndex={explaining() ? 0 : -1} onClick={() => { dismissExplanation(); props.onOpenSettings(); }}>Open Settings</button>
                </Show>
                <Show when={x().changeModel}>
                  <button type="button" class="pb-btn" tabIndex={explaining() ? 0 : -1} onClick={changeModel}>Change model</button>
                </Show>
                <Show when={x().retry}>
                  {(retry) => <button type="button" class="pb-btn primary" tabIndex={explaining() ? 0 : -1} onClick={() => retry()()}>Try again</button>}
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>

      <Show when={jobs().length > 0 || finished().length > 0}>
        <div class="pb-jobs" role="list" aria-label="Generations">
          <For each={jobs()}>
            {(asset) => (
              <div class="pb-job" role="listitem">
                <span class="pb-job-tile"><GenerateGlyph size={16} working /></span>
                <div class="pb-job-main">
                  <div class="pb-job-title">{asset.generationInput?.prompt || asset.name || "Generating"}</div>
                  <div class="pb-job-meta">
                    {jobKind(asset)}
                    <Show when={jobEntry(asset)}>{(entry) => <> · {entry().displayName}</>}</Show>
                    {" · "}<span class="pb-job-state">{mediaAssetGeneratingLabel(asset).replace("…", "")}</span>
                  </div>
                </div>
                <span class="pb-job-time">{jobPercent(asset) ?? elapsed(asset)}</span>
                <Show when={canCancelGeneration(asset)}>
                  <button type="button" class="pb-x" title="Cancel" aria-label={`Cancel ${asset.name}`} onClick={() => cancel(asset)}>
                    <X size={12} />
                  </button>
                </Show>
                <span class="pb-job-bar">
                  <span
                    class="pb-job-fill"
                    classList={{ auto: generationProgress(asset.id) === undefined }}
                    style={generationProgress(asset.id) === undefined ? undefined : { transform: `scaleX(${generationProgress(asset.id)})` }}
                  />
                </span>
              </div>
            )}
          </For>
          <For each={finished()}>
            {(f) => (
              <div class="pb-job done" role="listitem">
                <span class="pb-job-tile"><Check size={15} /></span>
                <div class="pb-job-main">
                  <div class="pb-job-title">{f.kind} ready</div>
                  <div class="pb-job-meta">{f.where}</div>
                </div>
                <button type="button" class="pb-btn" onClick={() => selectMediaPanelItemAndReveal(editor, f.id)}>Show</button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={clarify()}>
        {(c) => (
          <div class="pb-clarify" role="group" aria-label="Choose what to make">
            <span class="pb-clarify-label">Make this as</span>
            <For each={modes()}>
              {(m, i) => (
                <button type="button" class="pb-chip" style={{ "--i": i() }} classList={{ on: c().route.kind === m }} onClick={() => resolveClarify(m)}>
                  {modeLabel(m)}
                </button>
              )}
            </For>
            <button type="button" class="pb-x" aria-label="Cancel" onClick={() => setClarify(undefined)}><X size={11} /></button>
          </div>
        )}
      </Show>

      <div class="pb-toast" classList={{ show: status() !== undefined || routing() }} role="status">
        {routing() ? "Working out what to make…" : status() ?? ""}
      </div>

      <div ref={pill} class="pb-pill" classList={{ busy: routing(), working: routing() || jobs().length > 0, drop: dropHover(), live: live() !== undefined && prompt() === "" }}>
        <span class="pb-halo" aria-hidden="true" />
        <span class="pb-spark"><GenerateGlyph size={17} working={routing() || jobs().length > 0} done={live()?.done === true} /></span>
        <Show when={live()}>
          {(l) => <span class="pb-live" classList={{ done: l().done }} aria-live="polite">{l().text}</span>}
        </Show>
        <div class="pb-anchor pb-reveal anchor-add" style={{ "--i": 0 }}>
          <button type="button" class="pb-icon" classList={{ on: popover() === "add" }} title="Add a reference" aria-label="Add a reference" aria-expanded={popover() === "add"} onClick={() => toggle("add")}>
            <Plus size={15} />
          </button>
          <div class="pb-pop add" classList={{ open: popover() === "add" }} role="menu" aria-hidden={popover() !== "add"}>
            <button type="button" class="pb-pop-item" role="menuitem" disabled={selectedClipAsset() === undefined} onClick={() => { const a = selectedClipAsset(); if (a) addRef(a); setPopover(undefined); }}>
              Selected clip
            </button>
            <button type="button" class="pb-pop-item" role="menuitem" disabled={capturing()} onClick={() => void addCurrentFrame()}>
              Current frame
            </button>
            <div class="pb-pop-hint">Or drag media from the library onto the bar.</div>
          </div>
        </div>

        <div class="pb-anchor pb-reveal anchor-settings" style={{ "--i": 1 }}>
          <button type="button" class="pb-icon" classList={{ on: popover() === "settings" }} title="Type, model and options" aria-label="Type, model and options" aria-expanded={popover() === "settings"} onClick={() => toggle("settings")}>
            <SlidersHorizontal size={15} />
          </button>
          <div class="pb-pop wide settings" classList={{ open: popover() === "settings" }} aria-hidden={popover() !== "settings"}>
            <div class="pb-pop-title">Make</div>
            <div class="pb-seg" role="radiogroup" aria-label="What to make">
              <button type="button" role="radio" aria-checked={kind() === "auto"} classList={{ on: kind() === "auto" }} onClick={() => chooseKind("auto")}>Auto</button>
              <For each={modes()}>
                {(m) => <button type="button" role="radio" aria-checked={kind() === m} classList={{ on: kind() === m }} onClick={() => chooseKind(m)}>{modeLabel(m)}</button>}
              </For>
            </div>

            <Show
              when={fixedKind()}
              fallback={
                <>
                  <div class="pb-pop-title">Models</div>
                  <For each={modes()}>
                    {(m) => (
                      <label class="pb-field">
                        <span>{modeLabel(m)}</span>
                        <ModelSelect mode={m} />
                      </label>
                    )}
                  </For>
                </>
              }
            >
              {(m) => (
                <>
                  <div class="pb-pop-title">Model</div>
                  <ModelSelect mode={m()} />
                  <For each={fixedDefs()}>
                    {(def) => (
                      <label class="pb-field">
                        <span>{def.label}</span>
                        <select class="pb-select" aria-label={def.label} value={String(fixedOpts()?.[def.key] ?? "")} onChange={(e) => setOption(def.key, e.currentTarget.value)}>
                          <For each={def.choices}>{(c) => <option value={c.value}>{c.label}</option>}</For>
                        </select>
                      </label>
                    )}
                  </For>
                  <Show when={fixedCost() !== undefined}>
                    <div class="pb-pop-hint">About {formatUsd(fixedCost())} per generation. Actual billing may differ.</div>
                  </Show>
                </>
              )}
            </Show>

            <div class="pb-pop-title">Result</div>
            <div class="pb-seg" role="radiogroup" aria-label="Where the result goes">
              <For each={[["auto", "Auto"], ["library", "Library"], ["timeline", "Timeline"]] as const}>
                {([id, label]) => <button type="button" role="radio" aria-checked={placementPref() === id} classList={{ on: placementPref() === id }} onClick={() => choosePlacement(id)}>{label}</button>}
              </For>
            </div>
          </div>
        </div>

        <Show when={fixedKind()}>
          {(m) => (
            <button type="button" class="pb-kind" title="Back to Auto" onClick={() => chooseKind("auto")}>
              {modeLabel(m())} <X size={10} />
            </button>
          )}
        </Show>
        <For each={refs()}>
          {(asset) => (
            <button type="button" class="pb-kind ref" title={`Remove ${asset.name}`} onClick={() => setRefs(refs().filter((r) => r.id !== asset.id))}>
              <span class="pb-ref-name">{asset.name}</span> <X size={10} />
            </button>
          )}
        </For>

        <textarea
          ref={input}
          class="pb-input"
          rows={1}
          spellcheck={false}
          placeholder={`${placeholder()}…`}
          aria-label="Generation prompt"
          value={prompt()}
          onInput={(e) => { setHistoryIndex(-1); setPrompt(e.currentTarget.value); }}
          onKeyDown={onKeyDown}
        />
        <kbd class="pb-kbd" aria-hidden="true">/</kbd>

        <div class="pb-anchor pb-reveal anchor-more" style={{ "--i": 2 }}>
          <button type="button" class="pb-icon" classList={{ on: popover() === "more" }} title="More" aria-label="More" aria-expanded={popover() === "more"} onClick={() => toggle("more")}>
            <EllipsisVertical size={15} />
          </button>
          <div class="pb-pop end more" classList={{ open: popover() === "more" }} role="menu" aria-hidden={popover() !== "more"}>
            <div class="pb-pop-title">Recent</div>
            <For each={history().slice(0, 5)} fallback={<div class="pb-pop-hint">No prompts yet.</div>}>
              {(h) => <button type="button" class="pb-pop-item clip" role="menuitem" onClick={() => { setPrompt(h); setPopover(undefined); input.focus(); }}>{h}</button>}
            </For>
            <div class="pb-pop-sep" />
            <button type="button" class="pb-pop-item" role="menuitem" onClick={() => { setPopover(undefined); props.onOpenSettings(); }}>
              Routing: {routingModels.find((r) => r.id === routingModel())?.displayName}
            </button>
            <button type="button" class="pb-pop-item" role="menuitem" disabled={history().length === 0} onClick={() => { setHistory([]); saveHistory(storage(), []); setPopover(undefined); }}>
              Clear history
            </button>
          </div>
        </div>

        <button
          type="button"
          class="pb-send pb-reveal"
          style={{ "--i": 3 }}
          classList={{ ready: prompt().trim() !== "" }}
          disabled={routing()}
          title={fixedCost() !== undefined ? `Generate · ${formatUsd(fixedCost())}` : "Generate"}
          aria-label="Generate"
          onClick={() => void submit()}
        >
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}
