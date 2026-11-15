// Port of UI/GenerationView (+Mentions, +ModelState, +References, +Settings, +Submit, +UpscaleSettings).
// The panel lives in the media panel's `generationPanel` slot.
import ArrowUp from "lucide-solid/icons/arrow-up";
import AudioWaveform from "lucide-solid/icons/audio-waveform";
import ChevronDown from "lucide-solid/icons/chevron-down";
import CircleArrowUp from "lucide-solid/icons/circle-arrow-up";
import Film from "lucide-solid/icons/film";
import ImageIcon from "lucide-solid/icons/image";
import Volume2 from "lucide-solid/icons/volume-2";
import VolumeX from "lucide-solid/icons/volume-x";
import X from "lucide-solid/icons/x";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { Editor } from "../editor/editor";
import { clearPendingReplacement, markPendingReplacement, replaceClipMediaRef } from "../editor/mutations/clipMutations";
import { clearPendingGenerationPanelState } from "../editor/mutations/aiEdit";
import { finalizeGeneratingClip, placeGeneratingAudioClip } from "../editor/mutations/generatedClips";
import { finalizeTransitionClip, placeGeneratingTransitionClip } from "../editor/mutations/aiTransition";
import { selectMediaPanelItem } from "../editor/mutations/mediaPanel";
import { folder } from "../media/folders";
import { mediaAssetResolvedDuration, type ClipType, type GenerationInput, type MediaAsset, type UpscaleSettings } from "../model";
import type { ThumbnailProvider } from "../mediapanel/thumbnailProvider";
import { swiftRound } from "../util/math";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { audioModels, imageModels, upscaleModels, videoModels, isEntryUsable } from "./catalog";
import { formatUsd, localizedEstimate } from "./costEstimator";
import { audioCost, imageCost, upscaleCost, videoCost } from "./costEstimator";
import { getGenerationService, type GenerationService } from "./generationService";
import { pendingGeneration } from "./generationState";
import {
  audioInputs, audioCategory, audioCategoryLabel, audioCategoryOrder, audioHasDurationControl, audioMaxReferenceAudios,
  audioMaxReferenceImages, audioAcceptsSource, audioAcceptsSourceMedia, audioReferencesExclusive,
  audioSupportsReferences, aspectRatioDisplayLabel, billingDurationSeconds, imageMaxImages,
  isAudioEntry, isImageEntry, isUpscaleEntry, isVideoEntry, languageName, resolutionDisplayLabel, snappedUpscaleValue,
  upscaleAvailableOptions, upscaleDefaultSettings, upscaleNormalizedSettings, upscaleOptionLabel, upscaleSupports,
  validateAudioParams, validateAudioSpan, validateImage, validateSourceDuration,
  validateVideo, videoIsLipSync, videoRequiresReferenceAudio, videoRequiresSourceVideo, videoSupportsPrompt,
  videoSupportsReferences, videoSupportsSourceVideo, videoUsesOutputDuration,
  type AudioEntry, type ImageEntry, type UpscaleEntry, type VideoEntry,
} from "./modelConfig";
import { isModelEnabled } from "./modelPreferences";
import type { CatalogEntry, AudioParams } from "./providers/types";
import { RefCard, RefDropZone, FrameSlot } from "./RefControls";
import {
  makeAudioSubmission, makeImageSubmission, makeVideoSubmission, setAudioSourceAsset, type GenerationPlan,
} from "./submission";
import { makeUpscalePlan } from "./edit/editSubmitter";
import {
  audioInputReferences, makeVideoInputAssets, validateAudioInputs, validateVideoInputs, videoTextToVideoReferences,
  type AudioInputAssets, type VideoInputAssets,
} from "./inputAssets";
import { trimmedSourceDurationSeconds, trimmedSourceHasTrim, type TrimmedSource } from "./trimmedSource";
import { buildAudioParams, buildGenerationInput, type GenerationSettings } from "./quickGeneration";
import "./generation.css";

type GType = "image" | "video" | "audio" | "upscale";
type InputMode = "frames" | "references" | "sourceVideo";

const typeInfo: Record<GType, { title: string; clip: ClipType; accent: string; icon: () => JSX.Element }> = {
  image: { title: "Image", clip: "image", accent: "var(--track-image)", icon: () => <ImageIcon size={14} /> },
  video: { title: "Video", clip: "video", accent: "var(--track-video)", icon: () => <Film size={14} /> },
  audio: { title: "Audio", clip: "audio", accent: "var(--track-audio)", icon: () => <AudioWaveform size={14} /> },
  upscale: { title: "Upscale", clip: "video", accent: "var(--track-video)", icon: () => <CircleArrowUp size={14} /> },
};

const inputModeTitle: Record<InputMode, string> = { frames: "First/Last", references: "References", sourceVideo: "Extend" };

function Chip(props: { onClick: (e: MouseEvent) => void; title?: string; subtle?: boolean; children: JSX.Element }) {
  return (
    <button type="button" class="gen-chip" classList={{ subtle: props.subtle }} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

function OptionPicker<T extends string | number>(props: {
  label: string;
  options: readonly T[];
  value: T;
  format?: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div class="gen-setting">
      <span class="gen-label">{props.label}</span>
      <div class="gen-grid">
        <For each={props.options}>
          {(o) => (
            <button type="button" classList={{ selected: o === props.value }} onClick={() => props.onChange(o)}>
              {props.format ? props.format(o) : String(o)}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export function GenerationPanel(props: {
  editor: Editor;
  /** Called by every "Add API key" affordance. */
  onOpenSettings: () => void;
  thumbnailProvider?: ThumbnailProvider;
  service?: GenerationService;
}) {
  const editor = props.editor;
  const pending = pendingGeneration(editor);
  const service = (): GenerationService => props.service ?? getGenerationService();

  const [type, setType] = createSignal<GType>("video");
  const [prompt, setPrompt] = createSignal("");
  const [selected, setSelected] = createSignal<Record<GType, string | undefined>>({ image: undefined, video: undefined, audio: undefined, upscale: undefined });
  const [duration, setDuration] = createSignal(5);
  const [aspectRatio, setAspectRatio] = createSignal("16:9");
  const [resolution, setResolution] = createSignal("1080p");
  const [quality, setQuality] = createSignal("high");
  const [numImages, setNumImages] = createSignal(1);
  const [voice, setVoice] = createSignal("");
  const [lyrics, setLyrics] = createSignal("");
  const [styleInstructions, setStyleInstructions] = createSignal("");
  const [instrumental, setInstrumental] = createSignal(false);
  const [audioDuration, setAudioDuration] = createSignal(30);
  const [targetLanguage, setTargetLanguage] = createSignal("");
  const [multilingual, setMultilingual] = createSignal(false);
  const [generateAudio, setGenerateAudio] = createSignal(true);
  const [upscaleSettings, setUpscaleSettings] = createSignal<UpscaleSettings>({ selections: {}, numbers: {}, toggles: {} });
  const [inputMode, setInputMode] = createSignal<InputMode>("frames");
  const [firstFrame, setFirstFrame] = createSignal<string>();
  const [lastFrame, setLastFrame] = createSignal<string>();
  const [imageRefs, setImageRefs] = createSignal<string[]>([]);
  const [refImages, setRefImages] = createSignal<string[]>([]);
  const [refVideos, setRefVideos] = createSignal<string[]>([]);
  const [refAudios, setRefAudios] = createSignal<string[]>([]);
  const [sourceVideo, setSourceVideo] = createSignal<string>();
  const [audioSource, setAudioSource] = createSignal<string>();
  const [upscaleSource, setUpscaleSource] = createSignal<string>();
  const [editFolderId, setEditFolderId] = createSignal<string>();
  const [dropError, setDropError] = createSignal<string>();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] }>();
  const [mentionQuery, setMentionQuery] = createSignal<string>();
  const [mentionIndex, setMentionIndex] = createSignal(0);
  let populating = false;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(errorTimer));

  const flashDropError = (message: string): void => {
    clearTimeout(errorTimer);
    setDropError(message);
    errorTimer = setTimeout(() => setDropError(undefined), 3000);
  };

  const asset = (id: string | undefined): MediaAsset | undefined => (id === undefined ? undefined : editor.mediaAsset(id));
  const assets = (ids: readonly string[]): MediaAsset[] => ids.flatMap((id) => editor.mediaAsset(id) ?? []);

  // MARK: model state

  const entriesFor = (t: GType): CatalogEntry[] => {
    switch (t) {
      case "video": return videoModels();
      case "image": return imageModels();
      case "audio": return audioModels();
      case "upscale": return upscaleModels();
    }
  };
  const enabledEntries = (t: GType): CatalogEntry[] =>
    entriesFor(t).filter((m) => {
      if (!isModelEnabled(m.id)) return false;
      if (t !== "upscale" || !isUpscaleEntry(m)) return true;
      const src = asset(upscaleSource());
      return src ? upscaleSupports(m, src) : true;
    });
  const model = createMemo<CatalogEntry | undefined>(() => {
    const list = enabledEntries(type());
    return list.find((m) => m.id === selected()[type()]) ?? list.find(isEntryUsable) ?? list[0];
  });
  const videoM = (): VideoEntry | undefined => { const m = model(); return type() === "video" && isVideoEntry(m) ? m : undefined; };
  const imageM = (): ImageEntry | undefined => { const m = model(); return type() === "image" && isImageEntry(m) ? m : undefined; };
  const audioM = (): AudioEntry | undefined => { const m = model(); return type() === "audio" && isAudioEntry(m) ? m : undefined; };
  const upscaleM = (): UpscaleEntry | undefined => { const m = model(); return type() === "upscale" && isUpscaleEntry(m) ? m : undefined; };
  const locked = () => { const m = model(); return m !== undefined && !isEntryUsable(m); };

  const usesSourceVideoInput = () => {
    const m = videoM();
    return m !== undefined && (videoRequiresSourceVideo(m) || (videoSupportsSourceVideo(m) && inputMode() === "sourceVideo"));
  };
  const audioUsesSource = () => {
    const m = audioM();
    return m !== undefined && audioAcceptsSourceMedia(m) && (!audioInputs(m).includes("text") || audioSource() !== undefined);
  };
  const activeAudioInput = (): "text" | "audio" | "video" => {
    const src = audioUsesSource() ? asset(audioSource()) : undefined;
    return src ? (src.type === "video" ? "video" : "audio") : "text";
  };
  const showsPrompt = () => {
    switch (type()) {
      case "video": { const m = videoM(); return m ? videoSupportsPrompt(m) : true; }
      case "audio": { const m = audioM(); return m ? audioInputs(m).includes("text") : true; }
      case "image": return true;
      case "upscale": return false;
    }
  };
  const aspectRatios = (): string[] => videoM()?.uiCapabilities.aspectRatios ?? imageM()?.uiCapabilities.aspectRatios ?? [];
  const resolutions = (): string[] | undefined => videoM()?.uiCapabilities.resolutions ?? imageM()?.uiCapabilities.resolutions;
  const qualities = (): string[] | undefined => imageM()?.uiCapabilities.qualities;
  const effectiveResolution = (): string | undefined => (resolutions() ? resolution() : undefined);
  const supportsAudioToggle = () => videoM()?.uiCapabilities.supportsGenerateAudio === true;
  const effectiveGenerateAudio = () => (supportsAudioToggle() ? generateAudio() : true);
  const trimmedPrompt = () => prompt().replace(/^[ \t]+|[ \t]+$/g, "");

  // MARK: references

  const showsFrameStrip = () => {
    const m = videoM();
    if (!m || !m.uiCapabilities.supportsFirstFrame || usesSourceVideoInput()) return false;
    return m.uiCapabilities.framesAndReferencesExclusive ? inputMode() === "frames" : true;
  };
  const showsRefSections = () => {
    if (type() === "video") {
      const m = videoM();
      if (!m || !videoSupportsReferences(m) || usesSourceVideoInput()) return false;
      return !m.uiCapabilities.framesAndReferencesExclusive || inputMode() === "references";
    }
    if (type() === "audio") { const m = audioM(); return !!m && audioSupportsReferences(m) && !audioUsesSource(); }
    return false;
  };
  const availableInputModes = (): InputMode[] => {
    const m = videoM();
    if (!m) return [];
    const modes: InputMode[] = ["frames"];
    if (m.uiCapabilities.framesAndReferencesExclusive && videoSupportsReferences(m)) modes.push("references");
    if (videoSupportsSourceVideo(m) && !videoRequiresSourceVideo(m)) modes.push("sourceVideo");
    return modes;
  };
  const refCap = (t: ClipType): number => {
    if (type() === "audio") {
      const m = audioM();
      return !m ? 0 : t === "image" ? audioMaxReferenceImages(m) : t === "audio" ? audioMaxReferenceAudios(m) : 0;
    }
    const c = videoM()?.uiCapabilities;
    return !c ? 0 : t === "image" ? c.maxReferenceImages : t === "video" ? c.maxReferenceVideos : t === "audio" ? c.maxReferenceAudios : 0;
  };
  const refCount = (t: ClipType): number => (t === "image" ? refImages().length : t === "video" ? refVideos().length : t === "audio" ? refAudios().length : 0);
  const activeRefTypes = (): ClipType[] => {
    const supported = (["image", "video", "audio"] as ClipType[]).filter((t) => refCap(t) > 0);
    const m = audioM();
    if (type() !== "audio" || !m || !audioReferencesExclusive(m)) return supported;
    if (refImages().length > 0) return ["image"];
    if (refAudios().length > 0) return ["audio"];
    return supported;
  };
  const totalRefCount = () => refImages().length + refVideos().length + refAudios().length;
  const isRefCapReached = () => {
    const total = videoM()?.uiCapabilities.maxTotalReferences;
    if (type() === "video" && total !== undefined && totalRefCount() >= total) return true;
    const types = activeRefTypes();
    return types.length > 0 && types.every((t) => refCount(t) >= refCap(t));
  };
  const tagNoun = (t: ClipType): string => (t === "image" ? (type() === "video" ? videoM()?.uiCapabilities.referenceTagNoun ?? "Image" : "Image") : t === "video" ? "Video" : t === "audio" ? "Audio" : t);
  const refCards = () =>
    (["image", "video", "audio"] as ClipType[]).flatMap((t) =>
      assets(t === "image" ? refImages() : t === "video" ? refVideos() : refAudios()).map((a, i) => ({
        asset: a, type: t, tag: type() === "audio" && t === "image" ? undefined : `@${tagNoun(t)}${i + 1}`,
      })),
    );
  const refCounterLabel = () => {
    const total = totalRefCount();
    const cap = videoM()?.uiCapabilities.maxTotalReferences;
    const short: Record<string, string> = { image: "img", video: "vid", audio: "aud" };
    if (type() === "video" && cap !== undefined) return `${total}/${cap} · ${activeRefTypes().map((t) => `${refCount(t)} ${short[t]}`).join(" · ")}`;
    return `${total}/${Math.max(0, ...activeRefTypes().map(refCap))}`;
  };

  const videoInputAssets = (): VideoInputAssets => {
    const m = videoM();
    if (usesSourceVideoInput() && m) {
      const c = m.uiCapabilities;
      return makeVideoInputAssets({
        sourceVideo: asset(sourceVideo()),
        imageRefs: assets(imageRefs()).slice(0, c.maxReferenceImages),
        videoRefs: assets(refVideos()).slice(0, c.maxReferenceVideos),
        audioRefs: assets(refAudios()).slice(0, c.maxReferenceAudios),
      });
    }
    return makeVideoInputAssets({
      frames: showsFrameStrip() ? assets([firstFrame(), lastFrame()].flatMap((x) => (x === undefined ? [] : [x]))) : [],
      imageRefs: showsRefSections() ? assets(refImages()) : [],
      videoRefs: showsRefSections() ? assets(refVideos()) : [],
      audioRefs: showsRefSections() ? assets(refAudios()) : [],
    });
  };
  const audioInputAssets = (): AudioInputAssets => {
    const m = audioM();
    return m && audioSupportsReferences(m) ? { imageRefs: assets(refImages()), audioRefs: assets(refAudios()) } : { imageRefs: [], audioRefs: [] };
  };
  /** Matches the service: the trim rewrites the first reference whose path matches it. */
  const pendingTrim = (inputs: VideoInputAssets): TrimmedSource | undefined => {
    const trim = pending.trimmedSource;
    const m = videoM();
    if (!trim || !trimmedSourceHasTrim(trim) || !m) return undefined;
    if (videoRequiresSourceVideo(m) || inputs.sourceVideo) {
      const src = inputs.sourceVideo ?? asset(sourceVideo());
      return src && trim.sourceURL === src.url ? trim : undefined;
    }
    const match = videoTextToVideoReferences(inputs).find((a) => a.url === trim.sourceURL);
    return match?.type === "video" ? trim : undefined;
  };

  function addRefAsset(a: MediaAsset): void {
    if ([...refImages(), ...refVideos(), ...refAudios()].includes(a.id)) return flashDropError(`${a.name} is already a reference`);
    if (type() === "audio") {
      const m = audioM();
      if (!m) return;
      const next = audioInputAssets();
      if (a.type === "image") next.imageRefs.push(a);
      else if (a.type === "audio") next.audioRefs.push(a);
      else return flashDropError(`${m.displayName} only accepts image or audio references.`);
      const err = validateAudioInputs(next, m);
      if (err) return flashDropError(err);
    } else {
      const m = videoM();
      if (!m) return;
      const next = videoInputAssets();
      if (a.type === "image") next.imageRefs.push(a);
      else if (a.type === "video") next.videoRefs.push(a);
      else if (a.type === "audio") next.audioRefs.push(a);
      else return flashDropError(`${m.displayName} only accepts ${activeRefTypes().join(" and ")} references.`);
      const err = validateVideoInputs(next, m, pendingTrim(next));
      if (err) return flashDropError(err);
    }
    if (a.type === "image") setRefImages([...refImages(), a.id]);
    else if (a.type === "video") setRefVideos([...refVideos(), a.id]);
    else if (a.type === "audio") setRefAudios([...refAudios(), a.id]);
  }
  const removeRef = (t: ClipType, id: string): void => {
    if (t === "image") setRefImages(refImages().filter((x) => x !== id));
    else if (t === "video") setRefVideos(refVideos().filter((x) => x !== id));
    else if (t === "audio") setRefAudios(refAudios().filter((x) => x !== id));
  };
  const resetRefPools = (): void => { setRefImages([]); setRefVideos([]); setRefAudios([]); };
  const clearReferences = (): void => {
    setFirstFrame(undefined); setLastFrame(undefined); setImageRefs([]); resetRefPools();
    setSourceVideo(undefined); setAudioSource(undefined); setUpscaleSource(undefined);
  };

  // MARK: durations / cost

  const effectiveSourceVideoSeconds = (): number => {
    if (!usesSourceVideoInput()) return duration();
    const sv = asset(sourceVideo());
    const trim = pending.trimmedSource;
    if (trim && sv && trim.sourceURL === sv.url && trimmedSourceHasTrim(trim)) return trimmedSourceDurationSeconds(trim);
    return sv ? mediaAssetResolvedDuration(sv) : 0;
  };
  const effectiveVideoSeconds = (): number => {
    const m = videoM();
    if (!m || !usesSourceVideoInput() || videoUsesOutputDuration(m)) return duration();
    return billingDurationSeconds(m, effectiveSourceVideoSeconds(), asset(refAudios()[0])?.duration) ?? 0;
  };
  const audioSourceTrim = (src: MediaAsset): TrimmedSource | undefined => {
    const t = pending.trimmedSource;
    return t && t.sourceURL === src.url ? t : undefined;
  };
  const effectiveAudioSourceSpan = (): number => {
    const src = asset(audioSource());
    if (!src) return 0;
    const trim = audioSourceTrim(src);
    return trim && trimmedSourceHasTrim(trim) ? trimmedSourceDurationSeconds(trim) : src.duration;
  };
  const effectiveAudioSourceSeconds = () => Math.max(1, swiftRound(effectiveAudioSourceSpan()));
  const effectiveUpscaleSeconds = (): number => {
    const src = asset(upscaleSource());
    if (!src) return 0;
    const t = pending.trimmedSource;
    if (t && t.sourceURL === src.url && trimmedSourceHasTrim(t)) return Math.max(1, swiftRound(trimmedSourceDurationSeconds(t)));
    return src.type === "image" ? 1 : Math.max(1, swiftRound(src.duration));
  };

  const estimatedCost = createMemo<number | undefined>(() => {
    const v = videoM(), i = imageM(), a = audioM(), u = upscaleM();
    if (v) return videoCost(v, { durationSeconds: effectiveVideoSeconds(), resolution: effectiveResolution() });
    if (i) return imageCost(i, { resolution: effectiveResolution(), numImages: numImages() });
    if (a) {
      const d = audioUsesSource() ? (audioSource() === undefined ? undefined : effectiveAudioSourceSeconds()) : audioHasDurationControl(a) ? audioDuration() : undefined;
      return audioCost(a, { prompt: trimmedPrompt(), durationSeconds: d });
    }
    if (u) return upscaleCost(u, { durationSeconds: effectiveUpscaleSeconds(), isImage: asset(upscaleSource())?.type === "image" });
    return undefined;
  });

  // MARK: settings reset / normalization

  const resetUpscaleSettings = (): void => {
    const u = upscaleM();
    if (u) setUpscaleSettings(upscaleNormalizedSettings(u, upscaleDefaultSettings(u), asset(upscaleSource())));
  };
  const normalizeAudioDuration = (): void => {
    const c = audioM()?.uiCapabilities;
    if (c?.durationRange && !(audioDuration() >= c.durationRange.minimum && audioDuration() <= c.durationRange.maximum)) setAudioDuration(c.durationRange.defaultValue);
    else if (c?.durations && !c.durations.includes(audioDuration())) setAudioDuration(c.durations[0] ?? 30);
  };
  const resetAudioState = (): void => {
    const m = audioM();
    if (!m) return;
    setMultilingual(false);
    setVoice(m.uiCapabilities.defaultVoice ?? "");
    const langs = m.uiCapabilities.targetLanguages;
    setTargetLanguage(langs ? (m.uiCapabilities.defaultTargetLanguage && langs.includes(m.uiCapabilities.defaultTargetLanguage) ? m.uiCapabilities.defaultTargetLanguage : langs[0] ?? "") : "");
    if (!m.uiCapabilities.supportsLyrics) setLyrics("");
    if (!m.uiCapabilities.supportsStyleInstructions) setStyleInstructions("");
    if (!m.uiCapabilities.supportsInstrumental) setInstrumental(false);
    normalizeAudioDuration();
  };
  const resetSettings = (): void => {
    if (type() === "upscale") return resetUpscaleSettings();
    const ar = aspectRatios();
    if (!ar.includes(aspectRatio())) setAspectRatio(ar[0] ?? "16:9");
    const res = resolutions();
    if (res && !res.includes(resolution())) setResolution(res[0] ?? "1080p");
    const q = qualities();
    if (q && !q.includes(quality())) setQuality(q[q.length - 1] ?? "high");
    const v = videoM();
    if (v) {
      if (!v.uiCapabilities.durations.includes(duration())) setDuration(v.uiCapabilities.durations[0] ?? 5);
      setGenerateAudio(true);
      if (!populating) setInputMode(videoRequiresSourceVideo(v) ? "sourceVideo" : "frames");
    }
    const i = imageM();
    if (i) setNumImages(Math.min(Math.max(1, numImages()), imageMaxImages(i)));
    if (audioM()) normalizeAudioDuration();
  };

  // Model / type changes (not while a seed is being applied).
  createEffect(on(type, () => {
    if (populating) return;
    resetSettings(); clearReferences();
    if (type() === "audio") resetAudioState();
    setEditFolderId(undefined);
    clearPendingGenerationPanelState(editor, true);
  }, { defer: true }));
  createEffect(on(() => model()?.id, () => {
    if (populating) return;
    if (type() === "video") { resetSettings(); setInputMode(videoM() && videoRequiresSourceVideo(videoM() as VideoEntry) ? "sourceVideo" : "frames"); if (!videoM() || !videoRequiresSourceVideo(videoM() as VideoEntry)) setSourceVideo(undefined); resetRefPools(); }
    else if (type() === "image") resetSettings();
    else if (type() === "audio") { resetRefPools(); resetAudioState(); }
    else resetUpscaleSettings();
  }));
  createEffect(on(upscaleSource, () => { if (type() === "upscale" && !populating) resetUpscaleSettings(); }, { defer: true }));

  // MARK: mentions

  const mentionTags = (): { label: string; kind: ClipType }[] => {
    if (!showsRefSections()) return [];
    if (type() === "audio") return refAudios().map((_, i) => ({ label: `Audio${i + 1}`, kind: "audio" as ClipType }));
    return (["image", "video", "audio"] as ClipType[]).flatMap((t) => Array.from({ length: refCount(t) }, (_, i) => ({ label: `${tagNoun(t)}${i + 1}`, kind: t })));
  };
  const matchedTags = () => {
    const q = (mentionQuery() ?? "").toLowerCase();
    return mentionTags().filter((t) => q === "" || t.label.toLowerCase().includes(q));
  };
  const showMentions = () => mentionQuery() !== undefined && mentionTags().length > 0;
  const updateMentionQuery = (text: string): void => {
    let q: string | undefined;
    const at = text.lastIndexOf("@");
    if (mentionTags().length > 0 && at >= 0) {
      const after = text.slice(at + 1);
      if (!/\s/.test(after) && (at === 0 || /\s/.test(text[at - 1]))) q = after;
    }
    if (q !== mentionQuery()) { setMentionQuery(q); setMentionIndex(0); }
  };
  const pickTag = (label: string): void => {
    const at = prompt().lastIndexOf("@");
    setPrompt(`${at >= 0 ? prompt().slice(0, at) : prompt()}@${label} `);
    setMentionQuery(undefined);
  };
  const onPromptKey = (e: KeyboardEvent): void => {
    if (!showMentions()) return;
    const tags = matchedTags();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (tags.length > 0) setMentionIndex(Math.min(tags.length - 1, Math.max(0, mentionIndex() + (e.key === "ArrowUp" ? -1 : 1))));
    } else if (e.key === "Enter" && tags[mentionIndex()]) {
      e.preventDefault();
      pickTag(tags[mentionIndex()].label);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMentionQuery(undefined);
    }
  };

  // MARK: validation / submit

  const canSubmit = (): boolean => {
    if (locked()) return true;
    const t = type();
    if (t === "upscale") {
      const u = upscaleM(), src = asset(upscaleSource());
      if (!u || !src || src.sourceWidth === undefined || src.sourceHeight === undefined) return false;
      if (src.type === "video" && src.sourceFPS === undefined) return false;
      return (u.uiCapabilities.selectSettings ?? []).every((s) => upscaleAvailableOptions(u, s, src).includes(upscaleSettings().selections[s.key] ?? s.defaultValue));
    }
    const v = videoM();
    if (v && usesSourceVideoInput()) {
      if (!sourceVideo()) return false;
      if (v.uiCapabilities.requiresReferenceImage && imageRefs().length === 0) return false;
      if (videoRequiresReferenceAudio(v) && refAudios().length === 0) return false;
      if (videoIsLipSync(v) && effectiveVideoSeconds() === 0) return false;
      if (videoSupportsPrompt(v) && !videoSupportsReferences(v) && trimmedPrompt() === "") return false;
      return true;
    }
    if (v && v.uiCapabilities.framesAndReferencesExclusive && inputMode() === "references" && totalRefCount() === 0) return false;
    const a = audioM();
    if (a) {
      if (audioUsesSource()) {
        if (!audioSource()) return false;
        const langs = a.uiCapabilities.targetLanguages;
        return !langs || langs.includes(targetLanguage());
      }
      return Array.from(trimmedPrompt()).length >= Math.max(1, a.uiCapabilities.minPromptLength);
    }
    return trimmedPrompt() !== "";
  };

  const settingsSnapshot = (): GenerationSettings => ({
    prompt: prompt(), duration: duration(), aspectRatio: aspectRatio(), resolution: effectiveResolution(),
    quality: qualities() ? quality() : undefined, voice: voice(), lyrics: lyrics(), styleInstructions: styleInstructions(),
    instrumental: instrumental(), targetLanguage: targetLanguage(), multilingual: multilingual(), generateAudio: generateAudio(),
  });
  const audioParams = (audioDur: number): AudioParams => buildAudioParams(audioM(), settingsSnapshot(), audioDur);

  const preflight = (audioDur: number): string | undefined => {
    const v = videoM(), i = imageM(), a = audioM(), u = upscaleM();
    if (v) {
      const inputs = videoInputAssets();
      const trim = pendingTrim(inputs);
      const modelError = usesSourceVideoInput()
        ? validateSourceDuration(v, effectiveSourceVideoSeconds()) ??
          validateVideo(v, videoUsesOutputDuration(v) ? duration() : 0, videoUsesOutputDuration(v) ? aspectRatio() : "", videoUsesOutputDuration(v) ? effectiveResolution() : undefined)
        : validateVideo(v, duration(), aspectRatio(), effectiveResolution());
      return modelError ?? validateVideoInputs(inputs, v, trim);
    }
    if (i) {
      const count = imageMaxImages(i) > 1 ? Math.min(imageMaxImages(i), Math.max(1, numImages())) : 1;
      return validateImage(i, { aspectRatio: aspectRatio(), resolution: effectiveResolution(), quality: qualities() ? quality() : undefined, imageRefCount: imageRefs().length, numImages: count });
    }
    if (a) {
      if (audioUsesSource()) {
        if (!audioSource()) return "Add source media.";
        return validateAudioSpan(a, effectiveAudioSourceSpan()) ?? validateAudioParams(a, audioParams(audioDur));
      }
      return validateAudioParams(a, audioParams(audioDur)) ?? validateAudioInputs(audioInputAssets(), a);
    }
    if (u) {
      const src = asset(upscaleSource());
      if (!src) return "Add source media.";
      if (src.type !== "image" && src.type !== "video") return `${u.displayName} does not support this media type.`;
      if (!u.uiCapabilities.supportedTypes.includes(src.type)) return `${u.displayName} does not support this media type.`;
      if (src.sourceWidth === undefined || src.sourceHeight === undefined) return "Loading source dimensions…";
      if (src.type === "video") {
        if (src.sourceFPS === undefined) return "Loading source frame rate…";
        if (!upscaleSupports(u, src)) return "This model cannot cap the output at 60 FPS.";
      }
    }
    return undefined;
  };

  function submit(): void {
    const m = model();
    if (!m) return;
    if (locked()) return props.onOpenSettings();
    const t = type();
    const audioDur = t !== "audio" ? 0 : audioUsesSource() ? effectiveAudioSourceSeconds() : audioM() && audioHasDurationControl(audioM() as AudioEntry) ? audioDuration() : 0;
    const err = preflight(audioDur);
    if (err) return flashDropError(err);
    const inputDuration = t === "video" ? effectiveVideoSeconds() : t === "audio" ? audioDur : t === "upscale" ? effectiveUpscaleSeconds() : 0;
    const a = audioM(), i = imageM();
    const imageCount = i && imageMaxImages(i) > 1 ? Math.min(imageMaxImages(i), Math.max(1, numImages())) : 1;
    const genInput: GenerationInput = buildGenerationInput(m, {
      ...settingsSnapshot(), duration: inputDuration, numImages: imageCount,
      ...(t === "video" ? { usesSourceVideo: usesSourceVideoInput() } : {}),
      ...(t === "audio" ? { audioInput: activeAudioInput() } : {}),
    });

    const replacementClipId = pending.replacementClipId ?? undefined;
    const audioPlacement = t === "audio" ? pending.audioPlacement : null;
    const transitionPlacement = t === "video" ? pending.transitionPlacement : null;
    if (replacementClipId) markPendingReplacement(editor, replacementClipId);
    const makeOnComplete = (resetTrim: boolean): ((a: MediaAsset) => void) | undefined => {
      if (!replacementClipId) return undefined;
      let fired = false;
      return (newAsset) => {
        if (fired) return;
        fired = true;
        replaceClipMediaRef(editor, replacementClipId, newAsset.id, { resetTrim });
        clearPendingReplacement(editor, replacementClipId);
      };
    };
    const onFailure = replacementClipId ? () => clearPendingReplacement(editor, replacementClipId) : undefined;
    const chain = (first: ((a: MediaAsset) => void) | undefined, second: ((a: MediaAsset) => void) | undefined) =>
      first || second ? (x: MediaAsset) => { first?.(x); second?.(x); } : undefined;
    const run = (plan: GenerationPlan, onComplete: ((a: MediaAsset) => void) | undefined): string =>
      service().generate(editor, plan, { ...(onComplete ? { onComplete } : {}), ...(onFailure ? { onFailure } : {}) });
    const autoOpen = (id: string): void => { if (!replacementClipId) selectMediaPanelItem(editor, id); };
    const folderOf = (...candidates: (MediaAsset | undefined)[]): string | undefined => {
      const f = editFolderId() ?? candidates.find((c) => c?.folderId !== undefined)?.folderId ?? editor.ui.mediaPanelCurrentFolderId ?? undefined;
      return f !== undefined && folder(editor, f) ? f : undefined;
    };

    if (t === "video" && videoM()) {
      const v = videoM() as VideoEntry;
      const inputs = videoInputAssets();
      const trim = pendingTrim(inputs);
      const placeholderDuration = usesSourceVideoInput() ? (videoUsesOutputDuration(v) ? duration() : effectiveSourceVideoSeconds()) : trim && trimmedSourceHasTrim(trim) ? trimmedSourceDurationSeconds(trim) : duration();
      const folderId = folderOf(...(usesSourceVideoInput() ? [inputs.sourceVideo, inputs.imageRefs[inputs.imageRefs.length - 1]] : [videoTextToVideoReferences(inputs).at(-1)]));
      const plan = makeVideoSubmission({
        genInput, model: v, inputAssets: inputs, placeholderDuration,
        ...(trim ? { trimmedSourceOverride: trim } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        generateAudio: effectiveGenerateAudio(),
      });
      const base = makeOnComplete(trim !== undefined && trimmedSourceHasTrim(trim));
      const id = run(plan, transitionPlacement ? chain((x) => finalizeTransitionClip(editor, x.id, x), base) : base);
      if (transitionPlacement) placeGeneratingTransitionClip(editor, id, transitionPlacement);
      autoOpen(id);
    } else if (t === "image" && i) {
      const refs = assets(imageRefs());
      const folderId = folderOf(refs.at(-1));
      const id = run(makeImageSubmission({ genInput, model: i, references: refs, numImages: imageCount, ...(folderId !== undefined ? { folderId } : {}) }), makeOnComplete(false));
      autoOpen(id);
    } else if (t === "audio" && a) {
      const inputs = audioInputAssets();
      const source = audioAcceptsSourceMedia(a) ? asset(audioSource()) : undefined;
      if (source) setAudioSourceAsset(genInput, source);
      const refs = audioSupportsReferences(a) ? audioInputReferences(inputs) : source ? [source] : [];
      const folderId = folderOf(source, refs.at(-1));
      const trim = source ? audioSourceTrim(source) : undefined;
      const base = makeOnComplete(false);
      const id = run(
        makeAudioSubmission({ genInput, model: a, params: audioParams(audioDur), references: refs, ...(folderId !== undefined ? { folderId } : {}), ...(trim ? { trimmedSourceOverride: trim } : {}) }),
        audioPlacement ? chain((x) => finalizeGeneratingClip(editor, x.id, x), base) : base,
      );
      if (audioPlacement) placeGeneratingAudioClip(editor, id, audioPlacement.startFrame, audioPlacement.spanSeconds, audioPlacement.actionName);
    } else if (t === "upscale" && upscaleM()) {
      const src = asset(upscaleSource());
      if (!src) return;
      const trim = pending.trimmedSource && pending.trimmedSource.sourceURL === src.url ? pending.trimmedSource : undefined;
      const plan = makeUpscalePlan(src, upscaleM() as UpscaleEntry, upscaleSettings(), trim);
      const id = run(plan, makeOnComplete(trim !== undefined && trimmedSourceHasTrim(trim)));
      autoOpen(id);
    }
    clearPendingGenerationPanelState(editor);
    setLyrics(""); setStyleInstructions(""); setPrompt(""); setEditFolderId(undefined);
    clearReferences();
  }

  // MARK: seeding (populatePanel)

  function populate(seedAsset: MediaAsset, stored: GenerationInput): void {
    const entry = [...videoModels(), ...imageModels(), ...audioModels(), ...upscaleModels()].find((m) => m.id === stored.model);
    if (!entry) return;
    populating = true;
    const t: GType = entry.kind;
    setType(t);
    setSelected({ ...selected(), [t]: entry.id });
    setPrompt(stored.prompt);
    if (stored.aspectRatio !== "") setAspectRatio(stored.aspectRatio);
    if (stored.resolution !== undefined) setResolution(stored.resolution);
    if (stored.quality !== undefined) setQuality(stored.quality);
    if (stored.duration > 0) { setDuration(stored.duration); setAudioDuration(stored.duration); }
    if (stored.numImages !== undefined) setNumImages(Math.max(1, stored.numImages));
    if (stored.voice) setVoice(stored.voice);
    if (isAudioEntry(entry)) {
      const langs = entry.uiCapabilities.targetLanguages;
      setTargetLanguage(stored.targetLanguage && langs?.includes(stored.targetLanguage) ? stored.targetLanguage : langs?.[0] ?? "");
    }
    setMultilingual(stored.multilingual ?? false);
    setLyrics(stored.lyrics ?? "");
    setStyleInstructions(stored.styleInstructions ?? "");
    setInstrumental(stored.instrumental ?? false);
    setGenerateAudio(stored.generateAudio ?? true);
    if (t === "upscale" && isUpscaleEntry(entry)) setUpscaleSettings(stored.upscaleSettings ?? upscaleDefaultSettings(entry));
    clearReferences();
    const exists = (id: string) => editor.mediaAsset(id) !== undefined;
    const ids = (list: string[] | undefined) => (list ?? []).filter(exists);
    const primary = ids(stored.imageURLAssetIds);
    if (isVideoEntry(entry)) {
      const c = entry.uiCapabilities;
      const usesSource = videoRequiresSourceVideo(entry) || stored.usesSourceVideo === true;
      if (usesSource) {
        setInputMode("sourceVideo");
        setSourceVideo(primary[0]);
        let imgs = ids(stored.referenceImageAssetIds);
        if (imgs.length === 0 && c.maxReferenceImages > 0 && primary.length > 1) imgs = [primary[1]];
        setImageRefs(imgs);
        setRefVideos(ids(stored.referenceVideoAssetIds));
        setRefAudios(ids(stored.referenceAudioAssetIds));
      } else {
        if (c.supportsFirstFrame) {
          setFirstFrame(primary[0]);
          if (c.supportsLastFrame && primary.length > 1) setLastFrame(primary[1]);
        }
        setRefImages(ids(stored.referenceImageAssetIds));
        setRefVideos(ids(stored.referenceVideoAssetIds));
        setRefAudios(ids(stored.referenceAudioAssetIds));
        setInputMode(c.framesAndReferencesExclusive && totalRefCountNow() > 0 ? "references" : "frames");
      }
    } else if (isImageEntry(entry)) {
      setImageRefs(primary);
    } else if (isAudioEntry(entry)) {
      if (audioSupportsReferences(entry)) {
        setRefImages(ids(stored.referenceImageAssetIds));
        setRefAudios(ids(stored.referenceAudioAssetIds));
      } else {
        setAudioSource(ids(stored.referenceAudioAssetIds)[0] ?? ids(stored.referenceVideoAssetIds)[0]);
      }
    } else if (isUpscaleEntry(entry)) {
      setUpscaleSource(primary[0] ?? seedAsset.id);
    }
    setEditFolderId(seedAsset.folderId);
    queueMicrotask(() => {
      if (isUpscaleEntry(entry)) setUpscaleSettings(upscaleNormalizedSettings(entry, upscaleSettings(), asset(upscaleSource())));
      else resetSettings();
      populating = false;
    });
  }
  const totalRefCountNow = totalRefCount;

  createEffect(() => {
    const seed = pending.panelSeed;
    if (!seed) return;
    populate(seed.asset, seed.stored);
    pending.panelSeed = null;
  });

  // MARK: menus

  const openModelMenu = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = type();
    const entries = enabledEntries(t);
    const toItem = (m: CatalogEntry): ContextMenuItem => ({
      kind: "item", label: m.displayName, checked: m.id === model()?.id, disabled: !isEntryUsable(m),
      tooltip: isEntryUsable(m) ? m.description : `${m.providerName ?? m.providerId} needs an API key`,
      onSelect: () => setSelected({ ...selected(), [t]: m.id }),
    });
    const groups = new Map<string, CatalogEntry[]>();
    const keyOf = (m: CatalogEntry): string =>
      t === "audio" && isAudioEntry(m) ? audioCategoryLabel[audioCategory(m)] : t === "upscale" ? (isUpscaleEntry(m) ? m.uiCapabilities.supportedTypes.join(" / ") : "") : m.providerName ?? m.providerId;
    const order = t === "audio" ? audioCategoryOrder.map((c) => audioCategoryLabel[c]) : [];
    for (const m of entries) groups.set(keyOf(m), [...(groups.get(keyOf(m)) ?? []), m]);
    const names = [...groups.keys()].sort((x, y) => (order.indexOf(x) < 0 ? 99 : order.indexOf(x)) - (order.indexOf(y) < 0 ? 99 : order.indexOf(y)));
    const items: ContextMenuItem[] = [];
    for (const name of names) {
      if (items.length > 0) items.push({ kind: "divider" });
      items.push({ kind: "item", label: name, disabled: true });
      items.push(...(groups.get(name) ?? []).map(toItem));
    }
    if (entries.some((m) => !isEntryUsable(m))) {
      items.push({ kind: "divider" }, { kind: "item", label: "Add API key…", onSelect: props.onOpenSettings });
    }
    if (entries.length === 0) items.push({ kind: "item", label: "No models available", disabled: true }, { kind: "item", label: "Add API key…", onSelect: props.onOpenSettings });
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };

  const openSimpleMenu = (e: MouseEvent, items: ContextMenuItem[]): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, items });
  };

  const settingsSummary = (): string => {
    const parts: string[] = [];
    const t = type();
    if (t === "upscale") {
      for (const key of ["targetResolution", "targetFPS"]) {
        const s = upscaleM()?.uiCapabilities.selectSettings?.find((x) => x.key === key);
        if (!s) continue;
        const value = upscaleSettings().selections[key] ?? s.defaultValue;
        parts.push(key === "targetFPS" && value === "source" ? (asset(upscaleSource())?.sourceFPS ? `${Math.max(1, swiftRound(asset(upscaleSource())?.sourceFPS ?? 0))} FPS` : "Original FPS") : upscaleOptionLabel(key, value));
      }
      return parts.length ? parts.join(" · ") : "Settings";
    }
    if (t === "audio") {
      const a = audioM();
      if (a && audioHasDurationControl(a) && !audioUsesSource()) parts.push(`${audioDuration()}s`);
      if (a?.uiCapabilities.supportsInstrumental && instrumental()) parts.push("Instrumental");
      if (a?.uiCapabilities.supportsMultilingual && multilingual()) parts.push("Multilingual");
      return parts.length ? parts.join(" · ") : "Settings";
    }
    if (resolutions()) parts.push(t === "image" ? resolutionDisplayLabel(resolution()) : resolution());
    if (qualities()) parts.push(quality());
    if (t === "video") parts.push(`${duration()}s`);
    if (aspectRatio() !== "" && aspectRatios().length > 0) parts.push(t === "image" ? aspectRatioDisplayLabel(aspectRatio()) : aspectRatio());
    const i = imageM();
    if (i && imageMaxImages(i) > 1 && numImages() > 1) parts.push(`×${numImages()}`);
    return parts.join(" · ");
  };
  const hasAnySettings = (): boolean => {
    const v = videoM(), i = imageM(), a = audioM();
    if (v) return v.uiCapabilities.durations.length > 0 || aspectRatios().length > 0 || !!resolutions() || supportsAudioToggle();
    if (i) return aspectRatios().length > 0 || !!resolutions() || !!qualities() || imageMaxImages(i) > 1;
    if (a) return !!a.uiCapabilities.supportsInstrumental || !!a.uiCapabilities.supportsMultilingual || (!audioUsesSource() && audioHasDurationControl(a));
    return type() === "upscale";
  };
  const promptPlaceholder = (): string => {
    const t = type();
    if (t === "image") return "Describe the image";
    if (t === "video") return "Describe the video";
    if (t === "upscale") return "No prompt needed";
    const a = audioM();
    const min = a?.uiCapabilities.minPromptLength ?? 1;
    const base: Record<string, string> = { general: "Describe the audio scene", tts: "Text to speak", music: "Describe the music style or mood", sfx: "Describe the sound" };
    const cat = a ? audioCategory(a) : "tts";
    if (cat === "cleanup" || cat === "dubbing") return "No prompt needed";
    return min > 1 ? `${base[cat]} (minimum ${min} characters)` : base[cat];
  };

  const costText = () => {
    const c = estimatedCost();
    return c === undefined ? undefined : formatUsd(c);
  };

  const referencesContent = (): JSX.Element => {
    const sharedProvider = props.thumbnailProvider;
    const slot = (label: string, id: string | undefined, set: (v: string | undefined) => void, accepting: ClipType[], icon: "image" | "video" | "audio") => (
      <FrameSlot editor={editor} label={label} asset={asset(id)} accepting={new Set(accepting)} icon={icon} provider={sharedProvider}
        onDrop={(a) => set(a.id)} onClear={() => set(undefined)} onError={flashDropError} />
    );
    return (
      <>
        <Show when={type() === "upscale"}>{slot("Source Media", upscaleSource(), setUpscaleSource, ["video", "image"], "image")}</Show>
        <Show when={type() === "video" && usesSourceVideoInput()}>
          <div class="gen-ref-row">
            {slot("Source Video", sourceVideo(), setSourceVideo, ["video"], "video")}
            <Show when={(videoM()?.uiCapabilities.maxReferenceImages ?? 0) > 0}>
              {slot("Reference Image", imageRefs()[0], (id) => setImageRefs(id ? [id] : []), ["image"], "image")}
            </Show>
            <Show when={(videoM()?.uiCapabilities.maxReferenceAudios ?? 0) > 0}>
              {slot("Replacement Audio", refAudios()[0], (id) => setRefAudios(id ? [id] : []), ["audio"], "audio")}
            </Show>
          </div>
        </Show>
        <Show when={type() === "video" && !usesSourceVideoInput()}>
          <Show when={showsFrameStrip()}>
            <div class="gen-ref-row">
              {slot("First Frame", firstFrame(), setFirstFrame, ["image"], "image")}
              <Show when={videoM()?.uiCapabilities.supportsLastFrame}>{slot("Last Frame", lastFrame(), setLastFrame, ["image"], "image")}</Show>
            </div>
          </Show>
          <Show when={showsRefSections()}>{refSection()}</Show>
        </Show>
        <Show when={type() === "image" && imageM()?.uiCapabilities.supportsImageReference}>
          <div class="gen-refs">
            <span class="gen-label">References</span>
            <div class="gen-ref-row">
              <For each={assets(imageRefs())}>{(a) => <RefCard asset={a} provider={sharedProvider} onRemove={() => setImageRefs(imageRefs().filter((x) => x !== a.id))} />}</For>
              <RefDropZone editor={editor} icon="image" onDrop={(a) => {
                if (a.type !== "image") flashDropError("Drop image here.");
                else if (imageRefs().includes(a.id)) flashDropError(`${a.name} is already a reference`);
                else setImageRefs([...imageRefs(), a.id]);
              }} />
            </div>
          </div>
        </Show>
        <Show when={type() === "audio" && audioUsesSource()}>
          {slot(
            audioM() && audioAcceptsSource(audioM() as AudioEntry, "audio") && audioAcceptsSource(audioM() as AudioEntry, "video") ? "Source Media" : audioM() && audioAcceptsSource(audioM() as AudioEntry, "video") ? "Source Video" : "Source Audio",
            audioSource(), setAudioSource,
            (["audio", "video"] as ClipType[]).filter((c) => audioM() && audioAcceptsSource(audioM() as AudioEntry, c as "audio" | "video")), "audio",
          )}
        </Show>
        <Show when={type() === "audio" && !audioUsesSource() && showsRefSections()}>{refSection()}</Show>
      </>
    );
  };
  const refSection = (): JSX.Element => (
    <div class="gen-refs">
      <div><span class="gen-label">References</span><span class="gen-counter">{refCounterLabel()}</span></div>
      <div class="gen-ref-row">
        <For each={refCards()}>{(c) => <RefCard asset={c.asset} tag={c.tag} provider={props.thumbnailProvider} onRemove={() => removeRef(c.type, c.asset.id)} />}</For>
        <Show when={!isRefCapReached()}>
          <RefDropZone editor={editor} icon="plus" accepting={new Set(activeRefTypes())} onDrop={addRefAsset} />
        </Show>
      </div>
    </div>
  );

  const settingsContent = (): JSX.Element => {
    const u = upscaleM();
    return (
      <Show
        when={!u}
        fallback={
          <>
            <For each={u?.uiCapabilities.selectSettings ?? []}>
              {(s) => (
                <OptionPicker label={s.label} options={upscaleAvailableOptions(u as UpscaleEntry, s, asset(upscaleSource()))}
                  value={upscaleSettings().selections[s.key] ?? s.defaultValue} format={(v) => upscaleOptionLabel(s.key, v)}
                  onChange={(v) => setUpscaleSettings({ ...upscaleSettings(), selections: { ...upscaleSettings().selections, [s.key]: v } })} />
              )}
            </For>
            <For each={u?.uiCapabilities.numericSettings ?? []}>
              {(s) => (
                <div class="gen-setting">
                  <span class="gen-label">{s.label}</span>
                  <input type="range" min={s.minimum} max={s.maximum} step={s.step} value={upscaleSettings().numbers[s.key] ?? s.defaultValue}
                    onInput={(e) => setUpscaleSettings({ ...upscaleSettings(), numbers: { ...upscaleSettings().numbers, [s.key]: snappedUpscaleValue(Number(e.currentTarget.value), s.minimum, s.maximum, s.step) } })} />
                </div>
              )}
            </For>
            <For each={u?.uiCapabilities.toggleSettings ?? []}>
              {(s) => (
                <label class="gen-setting row"><span class="gen-label">{s.label}</span>
                  <input type="checkbox" checked={upscaleSettings().toggles[s.key] ?? s.defaultValue}
                    onChange={(e) => setUpscaleSettings({ ...upscaleSettings(), toggles: { ...upscaleSettings().toggles, [s.key]: e.currentTarget.checked } })} />
                </label>
              )}
            </For>
          </>
        }
      >
        <Show when={videoM()}>{(v) => <OptionPicker label="Duration" options={v().uiCapabilities.durations} value={duration()} format={(d) => `${d}s`} onChange={setDuration} />}</Show>
        <Show when={audioM() && !audioUsesSource()}>
          <Show when={audioM()?.uiCapabilities.durations}>{(d) => <OptionPicker label="Duration" options={d()} value={audioDuration()} format={(x) => `${x}s`} onChange={setAudioDuration} />}</Show>
          <Show when={audioM()?.uiCapabilities.durationRange}>
            {(r) => (
              <div class="gen-setting">
                <span class="gen-label">Duration ({r().minimum}-{r().maximum} seconds)</span>
                <input type="number" min={r().minimum} max={r().maximum} value={audioDuration()}
                  onChange={(e) => setAudioDuration(Math.min(r().maximum, Math.max(r().minimum, Math.round(Number(e.currentTarget.value) || r().defaultValue))))} />
              </div>
            )}
          </Show>
        </Show>
        <Show when={aspectRatios().length > 0}>
          <OptionPicker label="Aspect Ratio" options={aspectRatios()} value={aspectRatio()} format={(x) => (type() === "image" ? aspectRatioDisplayLabel(x) : x)} onChange={setAspectRatio} />
        </Show>
        <Show when={resolutions()}>{(r) => <OptionPicker label="Resolution" options={r()} value={resolution()} format={(x) => (type() === "image" ? resolutionDisplayLabel(x) : x)} onChange={setResolution} />}</Show>
        <Show when={qualities()}>{(q) => <OptionPicker label="Quality" options={q()} value={quality()} format={(x) => x[0].toUpperCase() + x.slice(1)} onChange={setQuality} />}</Show>
        <Show when={imageM() && imageMaxImages(imageM() as ImageEntry) > 1}>
          <OptionPicker label="Count" options={Array.from({ length: imageMaxImages(imageM() as ImageEntry) }, (_, i) => i + 1)} value={numImages()} onChange={setNumImages} />
        </Show>
        <Show when={audioM()?.uiCapabilities.supportsInstrumental}>
          <label class="gen-setting row"><span class="gen-label">Instrumental</span><input type="checkbox" checked={instrumental()} onChange={(e) => setInstrumental(e.currentTarget.checked)} /></label>
        </Show>
        <Show when={audioM()?.uiCapabilities.supportsMultilingual}>
          <label class="gen-setting row" title="Use for non-English or mixed-language audio."><span class="gen-label">Multilingual</span><input type="checkbox" checked={multilingual()} onChange={(e) => setMultilingual(e.currentTarget.checked)} /></label>
        </Show>
        <Show when={supportsAudioToggle()}>
          <label class="gen-setting row" title="Turn off to skip audio generation."><span class="gen-label">Generate audio</span><input type="checkbox" checked={generateAudio()} onChange={(e) => setGenerateAudio(e.currentTarget.checked)} /></label>
        </Show>
      </Show>
    );
  };

  return (
    <div class="gen-panel" onPointerDown={(e) => { if (settingsOpen() && !(e.target as HTMLElement).closest(".gen-popover, .gen-settings-chip")) setSettingsOpen(false); }}>
      <div class="gen-head">
        <div class="gen-tabs" role="tablist">
          <For each={(Object.keys(typeInfo) as GType[]).filter((t) => t !== "upscale" || upscaleModels().length > 0)}>
            {(t) => (
              <button type="button" role="tab" class="gen-tab" classList={{ selected: type() === t }} style={{ "--tab-accent": typeInfo[t].accent }}
                aria-selected={type() === t} title={typeInfo[t].title} onClick={() => setType(t)}>
                {typeInfo[t].icon()}
                <span>{typeInfo[t].title}</span>
              </button>
            )}
          </For>
        </div>
        <span class="gen-spacer" />
        <button type="button" class="gen-icon-btn" aria-label="Close" onClick={() => { setEditFolderId(undefined); editor.ui.showGenerationPanel = false; }}>
          <X size={11} />
        </button>
      </div>
      <div class="gen-body">
        <div class="gen-refs">{referencesContent()}</div>
        <Show when={dropError()}>{(msg) => <span class="gen-error">{msg()}</span>}</Show>
        <div class="gen-input">
          <Show when={showMentions()}>
            <div class="gen-mentions">
              <Show when={matchedTags().length > 0} fallback={<div class="gen-mention">No matches</div>}>
                <For each={matchedTags()}>
                  {(tag, idx) => (
                    <div class="gen-mention" classList={{ active: idx() === mentionIndex() }} onMouseEnter={() => setMentionIndex(idx())} onMouseDown={(e) => { e.preventDefault(); pickTag(tag.label); }}>
                      <span>@{tag.label}</span><small>{tag.kind}</small>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
          <Show when={showsPrompt()}>
            <textarea class="gen-prompt" placeholder={promptPlaceholder()} value={prompt()} aria-label="Prompt"
              onInput={(e) => { setPrompt(e.currentTarget.value); updateMentionQuery(e.currentTarget.value); }} onKeyDown={onPromptKey} />
          </Show>
          <Show when={audioM()?.uiCapabilities.supportsLyrics}>
            <textarea class="gen-secondary" placeholder="Lyrics (optional). [Verse] and [Chorus] tags supported." value={lyrics()} onInput={(e) => setLyrics(e.currentTarget.value)} />
          </Show>
          <Show when={audioM()?.uiCapabilities.supportsStyleInstructions}>
            <textarea class="gen-secondary" placeholder="Style instructions (optional). e.g., warm and slow, British accent." value={styleInstructions()} onInput={(e) => setStyleInstructions(e.currentTarget.value)} />
          </Show>
          <div class="gen-toolbar">
            <Chip onClick={openModelMenu} title="Model">
              <span>{model()?.displayName ?? "No models"}</span>
              <Show when={locked()}><span class="gen-cost">· Add API key</span></Show>
              <ChevronDown size={9} />
            </Chip>
            <Show when={availableInputModes().length > 1}>
              <Chip onClick={(e) => openSimpleMenu(e, availableInputModes().map((m): ContextMenuItem => ({
                kind: "item", label: inputModeTitle[m], checked: inputMode() === m,
                onSelect: () => {
                  setInputMode(m);
                  if (m === "frames") { resetRefPools(); setSourceVideo(undefined); }
                  else if (m === "references") { setFirstFrame(undefined); setLastFrame(undefined); setSourceVideo(undefined); }
                  else { setFirstFrame(undefined); setLastFrame(undefined); resetRefPools(); }
                },
              })))}>
                <span>{inputModeTitle[inputMode()]}</span><ChevronDown size={9} />
              </Chip>
            </Show>
            <Show when={audioM()?.uiCapabilities.voices}>
              {(voices) => (
                <Chip onClick={(e) => openSimpleMenu(e, voices().map((v): ContextMenuItem => ({ kind: "item", label: v, checked: v === voice(), onSelect: () => setVoice(v) })))}>
                  <span>{voice() === "" ? audioM()?.uiCapabilities.defaultVoice ?? "Voice" : voice()}</span><ChevronDown size={9} />
                </Chip>
              )}
            </Show>
            <Show when={audioM()?.uiCapabilities.targetLanguages}>
              {(langs) => (
                <Chip title="Target Language" onClick={(e) => openSimpleMenu(e, langs().map((c): ContextMenuItem => ({ kind: "item", label: languageName(c), checked: c === targetLanguage(), onSelect: () => setTargetLanguage(c) })))}>
                  <span>{languageName(targetLanguage())}</span><ChevronDown size={9} />
                </Chip>
              )}
            </Show>
            <Show when={hasAnySettings()}>
              <button type="button" class="gen-chip subtle gen-settings-chip" onClick={() => setSettingsOpen(!settingsOpen())}>
                <span>{settingsSummary()}</span>
                <Show when={supportsAudioToggle()}>{generateAudio() ? <Volume2 size={10} /> : <VolumeX size={10} />}</Show>
              </button>
            </Show>
            <span class="gen-spacer" />
            <Show when={costText()}>
              {(text) => <span class="gen-cost" title={localizedEstimate(estimatedCost() ?? 0)}>{text()}</span>}
            </Show>
            <button type="button" class="gen-submit" disabled={!locked() && !canSubmit()} aria-label={type() === "upscale" ? "Upscale" : "Generate"}
              title={locked() ? "Add API key" : type() === "upscale" ? "Upscale source media" : "Generate"} onClick={submit}>
              <ArrowUp size={14} stroke-width={3} />
            </button>
          </div>
          <Show when={settingsOpen()}>
            <div class="gen-popover" style={type() === "upscale" ? { width: "280px" } : undefined}>{settingsContent()}</div>
          </Show>
        </div>
      </div>
      <Show when={menu()}>{(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(undefined)} />}</Show>
    </div>
  );
}
