import AlignCenter from "lucide-solid/icons/text-align-center";
import AlignEnd from "lucide-solid/icons/text-align-end";
import AlignStart from "lucide-solid/icons/text-align-start";
import FileUp from "lucide-solid/icons/file-up";
import KeyRound from "lucide-solid/icons/key-round";
import Sparkles from "lucide-solid/icons/sparkles";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Editor } from "../editor/editor";
import {
  captionCaseLabel, captionCases, captionTargets, captionTargetsForTracks, type CaptionCase,
} from "../editor/mutations/captions";
import { timelineTrackDisplayLabel } from "../editor/mutations/tracks";
import { GeneratingOverlay } from "../generation/GeneratingOverlay";
import {
  makeTextAnimation, makeTextStyle, presetUsesHighlight, textAnimationDefaultHighlight, textStyleCaption, type RGBA,
  type TextAlignment, type TextAnimationPreset, type TextStyle,
} from "../model";
import {
  transcriptionBackendLabel, transcriptionPreference, setTranscriptionPreference,
  transcriptionBackendIds, type TranscriptionBackendId, type TranscriptionPreference,
} from "../transcription/transcriptionBackend";
import { providersWithKeys } from "../generation/providers/registry";
import { CapsuleButton } from "../ui/CapsuleButton";
import { ColorField } from "../ui/ColorField";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { FontPickerField } from "../ui/FontPickerField";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Toggle } from "../ui/Toggle";
import type { MenuItem } from "../ui/Menu";
import { captionLanguageName, captionLanguages } from "./captionLanguages";
import {
  captionUncachedSeconds, defaultCaptionDeps, generateCaptions, importCaptions, makeCaptionRequest,
  timelineTranscript, type CaptionDeps, type CaptionRequest,
} from "./captionGeneration";
import {
  captionGapSettingsDefault, captionMaximumGapRange, makeCaptionGapSettings,
} from "./captionGapSettings";
import { snappedCoordinate } from "./captionPreviewPlacement";
import { CaptionPresetGallery } from "./CaptionPresetGallery";
import { captionDefaultCenter } from "./constants";
import {
  setCaptionPreviewCenterChange, setCaptionPreviewConfiguration, setCaptionPreviewEnabled, captionPreviewEnabled,
} from "./previewState";
import type { TimelineTranscriptDocument } from "./transcriptBrowserModel";
import "./captions.css";

const previewText = "Captions will look like this";
const maxWordRange = { min: 0, max: 50 } as const;
const maxCharacterRange = { min: 0, max: 200 } as const;

/** OS and network seams so the tab runs in the dev page without Tauri or provider keys. */
export interface CaptionsServices {
  pickSubtitleFile(): Promise<string | null>;
  deps: CaptionDeps;
}

export const tauriCaptionsServices: CaptionsServices = {
  async pickSubtitleFile() {
    if (!isTauri()) return null;
    const selected = await open({ multiple: false, directory: false, title: "Import captions", filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }] });
    return typeof selected === "string" ? selected : null;
  },
  deps: defaultCaptionDeps,
};

export type CaptionsOutput =
  | { kind: "captions"; onGenerated: (captionGroupId: string | undefined) => void }
  | { kind: "transcript"; onGenerated: (document: TimelineTranscriptDocument) => void };

const agentTasks: { label: string; prompt: string }[] = [
  { label: "Remove filler words", prompt: "remove filler words (um, uh, er, like, you know) from the captions, keeping each caption's timing unchanged." },
  { label: "Fix names & jargon", prompt: "fix any misspelled names, brand names, or technical jargon in the captions using the surrounding context, keeping timing unchanged." },
  { label: "Add emoji", prompt: "add relevant emoji to the captions, keeping the text and timing otherwise unchanged." },
];

const translateLanguages = [
  ["Spanish", "es"], ["French", "fr"], ["German", "de"], ["Italian", "it"], ["Portuguese", "pt"], ["Japanese", "ja"],
  ["Korean", "ko"], ["Chinese", "zh"], ["Hindi", "hi"], ["Arabic", "ar"],
] as const;

function minutesLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "~1 min of audio" : `~${minutes} min of audio`;
}

/**
 * Port of `CaptionTab`: source, transcription settings, style, animation and the Generate bar. With
 * `output.kind === "transcript"` it only transcribes (the Index tab's empty state).
 */
export function CaptionsTab(props: {
  editor: Editor;
  output: CaptionsOutput;
  onOpenSettings: () => void;
  /** Hands a prompt to the agent chat (the "Agent" menu next to Generate); omit to hide the menu. */
  onAgentTask?: (prompt: string) => void;
  services?: CaptionsServices;
}) {
  const editor = props.editor;
  const services = props.services ?? tauriCaptionsServices;
  const transcriptOnly = props.output.kind === "transcript";

  const [style, setStyle] = createSignal<TextStyle>(textStyleCaption());
  const [center, setCenter] = createSignal<{ x: number; y: number }>({ ...captionDefaultCenter });
  const [selectedTrackId, setSelectedTrackId] = createSignal<string | undefined>(undefined);
  const [selectedClipTargets, setSelectedClipTargets] = createSignal<string[]>([]);
  const [animationPreset, setAnimationPreset] = createSignal<TextAnimationPreset>("none");
  const [animationHighlight, setAnimationHighlight] = createSignal<RGBA>(textAnimationDefaultHighlight());
  const [textCase, setTextCase] = createSignal<CaptionCase>("auto");
  const [maxWords, setMaxWords] = createSignal<number | undefined>(undefined);
  const [maxCharacters, setMaxCharacters] = createSignal<number | undefined>(undefined);
  const [maximumGapSeconds, setMaximumGapSeconds] = createSignal(captionGapSettingsDefault.maximumGapSeconds);
  const [language, setLanguage] = createSignal<string | undefined>(undefined);
  const [isGenerating, setGenerating] = createSignal(false);
  const [uncachedSeconds, setUncachedSeconds] = createSignal<number | undefined>(undefined);
  const [note, setNote] = createSignal<string | undefined>(undefined);
  const [sourceExpanded, setSourceExpanded] = createSignal(true);
  const [settingsExpanded, setSettingsExpanded] = createSignal(true);
  const [styleExpanded, setStyleExpanded] = createSignal(false);
  const [animationExpanded, setAnimationExpanded] = createSignal(false);
  let abort: AbortController | undefined;

  const updateStyle = (mutate: (s: TextStyle) => void): void => {
    const next = structuredClone(style());
    mutate(next);
    setStyle(next);
  };

  // MARK: source

  const liveTargets = (): string[] => {
    const sel = editor.ui.selectedClipIds;
    return sel.size === 0 ? [] : captionTargets(editor, [...sel]).map((c) => c.id);
  };
  const rememberSelectedClipTargets = (): void => {
    const targets = liveTargets();
    if (targets.length > 0) setSelectedClipTargets(targets);
  };
  createEffect(on(() => [editor.ui.selectedClipIds, editor.ui.isMarqueeSelecting] as const, ([, marquee]) => {
    if (!marquee) rememberSelectedClipTargets();
  }));

  const isAutoSource = (): boolean => selectedTrackId() === undefined && selectedClipTargets().length === 0;
  const sourceClipIds = (): string[] => {
    const trackId = selectedTrackId();
    if (trackId !== undefined) return captionTargetsForTracks(editor, new Set([trackId])).map((c) => c.id);
    return selectedClipTargets();
  };
  const effectiveCount = (): number => (isAutoSource() ? captionTargets(editor, []).length : sourceClipIds().length);
  const captionTrackIndices = createMemo(() =>
    editor.timeline.tracks.flatMap((t, i) => (captionTargetsForTracks(editor, new Set([t.id])).length > 0 ? [i] : [])),
  );
  const automaticSourceSummary = (): string => {
    if (selectedClipTargets().length > 0) return `Selected Clips · ${selectedClipTargets().length}`;
    return captionTargets(editor, []).length === 0 ? "No audio" : "Auto";
  };
  const sourceSummary = (): string => {
    const trackId = selectedTrackId();
    if (trackId === undefined) return automaticSourceSummary();
    const index = editor.timeline.tracks.findIndex((t) => t.id === trackId);
    if (index < 0) return "No track";
    return `${timelineTrackDisplayLabel(editor, index)} · ${sourceClipIds().length}`;
  };
  const sourceMenu = (): MenuItem[] => {
    const items: MenuItem[] = [
      { kind: "item", label: automaticSourceSummary(), checked: selectedTrackId() === undefined, onSelect: () => setSelectedTrackId(undefined) },
      { kind: "divider" },
    ];
    if (captionTrackIndices().length === 0) {
      items.push({ kind: "item", label: "No Tracks", onSelect: () => undefined });
    }
    for (const index of captionTrackIndices()) {
      const track = editor.timeline.tracks[index];
      const count = captionTargetsForTracks(editor, new Set([track.id])).length;
      items.push({
        kind: "item",
        label: `${timelineTrackDisplayLabel(editor, index)} · ${count === 1 ? "1 clip" : `${count} clips`}`,
        checked: selectedTrackId() === track.id,
        onSelect: () => setSelectedTrackId(track.id),
      });
    }
    return items;
  };

  // MARK: transcription service

  const backend = (): TranscriptionBackendId | undefined => (providersWithKeys(), services.deps.backend());
  const serviceMenu = (): MenuItem[] => {
    const keyed = providersWithKeys();
    const entries: { pref: TranscriptionPreference; label: string; enabled: boolean }[] = [
      { pref: "auto", label: "Auto", enabled: true },
      ...transcriptionBackendIds.map((id) => ({ pref: id, label: transcriptionBackendLabel(id), enabled: id === "local" || keyed.has(id) })),
    ];
    return entries.map((e) => ({
      kind: "item" as const,
      label: e.enabled ? e.label : `${e.label} (no API key)`,
      checked: transcriptionPreference() === e.pref,
      onSelect: () => setTranscriptionPreference(e.pref),
    }));
  };
  const serviceLabel = (): string => {
    const active = backend();
    const pref = transcriptionPreference();
    if (active === undefined) return "No API key";
    return pref === "auto" ? `Auto · ${transcriptionBackendLabel(active)}` : transcriptionBackendLabel(active);
  };
  const noBackend = (): boolean => backend() === undefined;

  const request = (): CaptionRequest =>
    makeCaptionRequest({
      sourceClipIds: sourceClipIds(),
      autoDetect: isAutoSource(),
      style: style(),
      center: center(),
      textCase: textCase(),
      locale: language(),
      maxWords: maxWords(),
      maxCharacters: maxCharacters(),
      gapSettings: makeCaptionGapSettings(maximumGapSeconds()) ?? captionGapSettingsDefault,
      animation: makeTextAnimation({ preset: animationPreset(), highlight: animationHighlight() }),
    });

  // Uncached-audio estimate for the Generate button help (the cloud-cost estimate in Swift).
  createEffect(() => {
    const key = `${sourceClipIds().join(",")}|${isAutoSource()}|${language() ?? ""}|${selectedClipTargets().length}`;
    void key;
    setUncachedSeconds(undefined);
    if (effectiveCount() === 0 || noBackend()) return;
    const req = request();
    const timer = setTimeout(() => {
      void captionUncachedSeconds(editor, req).then(setUncachedSeconds, () => undefined);
    }, 150);
    onCleanup(() => clearTimeout(timer));
  });

  const canGenerate = (): boolean => effectiveCount() > 0 && !isGenerating() && !noBackend();
  const generateLabel = (): string => (transcriptOnly ? "Transcribe" : "Generate");
  const generateHelp = (): string => {
    if (noBackend()) return "Add an ElevenLabs or OpenAI API key to transcribe.";
    const seconds = uncachedSeconds();
    if (seconds === undefined) return "";
    if (seconds === 0) return backend() === "local" ? "Cached — nothing to transcribe." : "Cached — no API call.";
    return backend() === "local" ? `Transcribes ${minutesLabel(seconds)} on this PC.` : `Uploads ${minutesLabel(seconds)} to ${transcriptionBackendLabel(backend() ?? "elevenlabs")}.`;
  };

  const generate = async (): Promise<void> => {
    setNote(undefined);
    const sourceIds = sourceClipIds();
    if (selectedTrackId() !== undefined && sourceIds.length === 0) {
      setNote("No audio selected.");
      return;
    }
    const req = request();
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    setGenerating(true);
    try {
      if (props.output.kind === "transcript") {
        const doc = await timelineTranscript(editor, req, services.deps, signal);
        if (doc.rows.length === 0) setNote("No speech detected.");
        else props.output.onGenerated(doc);
      } else {
        const createdIds = await generateCaptions(editor, req, services.deps, signal);
        if (createdIds.length === 0) {
          setNote("No speech detected.");
        } else {
          const groupId = createdIds.map((id) => editor.clipFor(id)?.captionGroupId).find((g) => g !== undefined);
          setCaptionPreviewEnabled(false);
          props.output.onGenerated(groupId);
        }
      }
    } catch (error) {
      if (!signal.aborted) setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };

  const importFile = async (): Promise<void> => {
    setNote(undefined);
    const path = await services.pickSubtitleFile();
    if (path === null || props.output.kind !== "captions") return;
    setGenerating(true);
    try {
      const ids = await importCaptions(editor, path, services.deps);
      const groupId = ids.map((id) => editor.clipFor(id)?.captionGroupId).find((g) => g !== undefined);
      if (ids.length > 0) props.output.onGenerated(groupId);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };

  // MARK: caption preview in the timeline preview

  onMount(() => {
    rememberSelectedClipTargets();
    if (!transcriptOnly) setCaptionPreviewCenterChange((c) => setCenter(c));
  });
  createEffect(() => {
    if (transcriptOnly) return;
    setCaptionPreviewConfiguration({
      text: previewText,
      style: style(),
      center: center(),
      preset: animationPreset(),
      highlight: animationHighlight(),
    });
  });
  onCleanup(() => {
    abort?.abort();
    setCaptionPreviewConfiguration(null);
    setCaptionPreviewCenterChange(null);
  });

  // MARK: sections

  const languageMenu = (): MenuItem[] => [
    { kind: "item", label: "Auto", checked: language() === undefined, onSelect: () => setLanguage(undefined) },
    { kind: "divider" },
    ...captionLanguages().map((l) => ({ kind: "item" as const, label: l.name, checked: language() === l.code, onSelect: () => setLanguage(l.code) })),
  ];

  const updateMaxWords = (v: number): void => {
    setMaxWords(Math.round(v) > 0 ? Math.round(v) : undefined);
  };
  const updateMaxCharacters = (v: number): void => {
    setMaxCharacters(Math.round(v) > 0 ? Math.round(v) : undefined);
  };

  const alignIcons: Record<TextAlignment, () => ReturnType<typeof AlignStart>> = {
    left: () => <AlignStart size={12} />,
    center: () => <AlignCenter size={12} />,
    right: () => <AlignEnd size={12} />,
  };

  const positionField = (axis: "x" | "y") => (
    <ScrubbableNumberField
      value={center()[axis]}
      range={{ min: -10, max: 10 }}
      displayMultiplier={Math.max(1, axis === "x" ? editor.timeline.width : editor.timeline.height)}
      format="%.0f"
      fieldWidth="var(--compact-field-w)"
      trailingLabel={axis.toUpperCase()}
      onChanged={(v) => setCenter({ ...center(), [axis]: snappedCoordinate(v) })}
      onCommit={(v) => setCenter({ ...center(), [axis]: snappedCoordinate(v) })}
    />
  );

  const sourceSection = (
    <EditorPanelGroup
      title="Source"
      expanded={sourceExpanded()}
      onToggle={() => setSourceExpanded(!sourceExpanded())}
      headerAccessory={
        <Show when={!transcriptOnly}>
          <span class="cap-preview-toggle" title="Preview">
            <span class="cap-preview-toggle-label">Preview</span>
            <Toggle label="Preview" checked={captionPreviewEnabled()} onChange={setCaptionPreviewEnabled} />
          </span>
        </Show>
      }
    >
      <InspectorRow
        label="Source"
        help="Uses selected clips when available, otherwise all captionable audio. Choose a track to limit captions."
        onReset={() => {
          setSelectedTrackId(undefined);
          setSelectedClipTargets([]);
        }}
      >
        <DropdownMenuButton items={sourceMenu} class="cap-menu-button">
          <EditorMenuValue text={sourceSummary()} expanded />
        </DropdownMenuButton>
      </InspectorRow>
      <InspectorRow
        label="Service"
        help="Transcription runs with your own API key (ElevenLabs Scribe preferred, OpenAI Whisper next), or on this PC when there is none."
        onReset={() => setTranscriptionPreference("auto")}
      >
        <DropdownMenuButton items={serviceMenu} class="cap-menu-button">
          <EditorMenuValue text={serviceLabel()} expanded />
        </DropdownMenuButton>
      </InspectorRow>
      <Show when={!transcriptOnly}>
        <InspectorRow label="Subtitle file" help="Place the cues of an SRT or WebVTT file as captions at the file's own timecodes.">
          <CapsuleButton size="small" onClick={() => void importFile()} disabled={isGenerating()}>
            <FileUp size={11} />
            Import SRT / VTT…
          </CapsuleButton>
        </InspectorRow>
      </Show>
    </EditorPanelGroup>
  );

  const settingsSection = (
    <EditorPanelGroup title="Settings" expanded={settingsExpanded()} onToggle={() => setSettingsExpanded(!settingsExpanded())}>
      <InspectorRow label="Language" onReset={() => setLanguage(undefined)}>
        <DropdownMenuButton items={languageMenu} class="cap-menu-button">
          <EditorMenuValue text={language() === undefined ? "Auto" : captionLanguageName(language() ?? "")} expanded />
        </DropdownMenuButton>
      </InspectorRow>
      <InspectorRow label="Max words" help="Cap the words shown per caption. None fits each line to the box." onReset={() => setMaxWords(undefined)}>
        <ScrubbableNumberField
          value={maxWords() ?? 0}
          range={maxWordRange}
          dragValueAdjustment={Math.round}
          displayTextOverride={(v) => (v < 1 ? "None" : undefined)}
          label="Max words"
          onChanged={updateMaxWords}
          onCommit={updateMaxWords}
        />
      </InspectorRow>
      <InspectorRow
        label="Max characters"
        help="Cap characters per caption, including spaces and punctuation. A single word may exceed the limit."
        onReset={() => setMaxCharacters(undefined)}
      >
        <ScrubbableNumberField
          value={maxCharacters() ?? 0}
          range={maxCharacterRange}
          dragValueAdjustment={Math.round}
          displayTextOverride={(v) => (v < 1 ? "None" : undefined)}
          label="Max characters"
          onChanged={updateMaxCharacters}
          onCommit={updateMaxCharacters}
        />
      </InspectorRow>
      <InspectorRow
        label="Close gaps"
        help="Extends captions across short gaps and holds the final caption."
        onReset={() => setMaximumGapSeconds(captionGapSettingsDefault.maximumGapSeconds)}
      >
        <ScrubbableNumberField
          value={maximumGapSeconds()}
          range={{ min: captionMaximumGapRange.min, max: captionMaximumGapRange.max }}
          displayMultiplier={1000}
          format="%.0f"
          valueSuffix=" ms"
          dragSensitivity={10}
          dragValueAdjustment={(v) => Math.round(v / 0.05) * 0.05}
          label="Close gaps"
          onChanged={setMaximumGapSeconds}
          onCommit={setMaximumGapSeconds}
        />
      </InspectorRow>
    </EditorPanelGroup>
  );

  const styleSection = (
    <EditorPanelGroup title="Style" expanded={styleExpanded()} onToggle={() => setStyleExpanded(!styleExpanded())} onReset={() => setStyle(textStyleCaption())}>
      <InspectorRow label="Font" onReset={() => updateStyle((s) => { s.fontName = makeTextStyle().fontName; })}>
        <FontPickerField
          current={style().fontName}
          onPreview={(name) => updateStyle((s) => { s.fontName = name; })}
          onChange={(name) => updateStyle((s) => { s.fontName = name; })}
          onCancel={() => undefined}
        />
      </InspectorRow>
      <InspectorRow label="Size" onReset={() => updateStyle((s) => { s.fontSize = textStyleCaption().fontSize; })}>
        <ScrubbableNumberField
          value={style().fontSize}
          range={{ min: 8, max: 400 }}
          format="%.0f"
          valueSuffix=" pt"
          fieldWidth="var(--numeric-field-w)"
          onChanged={(v) => updateStyle((s) => { s.fontSize = v; })}
          onCommit={(v) => updateStyle((s) => { s.fontSize = v; })}
        />
      </InspectorRow>
      <InspectorRow label="Case" onReset={() => setTextCase("auto")}>
        <SegmentedControl
          small
          label="Case"
          value={textCase()}
          onChange={setTextCase}
          options={captionCases.map((c) => ({ value: c, label: captionCaseLabel(c) }))}
        />
      </InspectorRow>
      <InspectorRow label="Alignment" onReset={() => updateStyle((s) => { s.alignment = "center"; })}>
        <SegmentedControl
          small
          label="Alignment"
          value={style().alignment}
          onChange={(a) => updateStyle((s) => { s.alignment = a; })}
          options={(["left", "center", "right"] as const).map((a) => ({ value: a, icon: alignIcons[a](), title: a[0].toUpperCase() + a.slice(1) }))}
        />
      </InspectorRow>
      <InspectorRow label="Color" onReset={() => updateStyle((s) => { s.color = textStyleCaption().color; })}>
        <ColorField color={style().color} onChange={(c) => updateStyle((s) => { s.color = c; })} />
      </InspectorRow>
      <InspectorRow label="Position" onReset={() => setCenter({ ...captionDefaultCenter })}>
        <div class="field-pair">
          {positionField("x")}
          {positionField("y")}
        </div>
      </InspectorRow>
      <InspectorRow label="Background" onReset={() => updateStyle((s) => { s.background = textStyleCaption().background; })}>
        <ColorField color={style().background.color} onChange={(c) => updateStyle((s) => { s.background.color = c; })} />
        <Toggle label="Background" checked={style().background.enabled} onChange={(on) => updateStyle((s) => { s.background.enabled = on; })} />
      </InspectorRow>
      <InspectorRow label="Outline" onReset={() => updateStyle((s) => { s.border = textStyleCaption().border; })}>
        <ColorField color={style().border.color} onChange={(c) => updateStyle((s) => { s.border.color = c; })} />
        <Toggle label="Outline" checked={style().border.enabled} onChange={(on) => updateStyle((s) => { s.border.enabled = on; })} />
      </InspectorRow>
      <InspectorRow label="Shadow" onReset={() => updateStyle((s) => { s.shadow = textStyleCaption().shadow; })}>
        <Toggle label="Shadow" checked={style().shadow.enabled} onChange={(on) => updateStyle((s) => { s.shadow.enabled = on; })} />
      </InspectorRow>
    </EditorPanelGroup>
  );

  const animationSection = (
    <EditorPanelGroup title="Animation" expanded={animationExpanded()} onToggle={() => setAnimationExpanded(!animationExpanded())} gap="var(--sp-lg)">
      <CaptionPresetGallery selection={animationPreset()} highlight={animationHighlight()} onSelect={setAnimationPreset} />
      <Show when={presetUsesHighlight(animationPreset())}>
        <InspectorRow label="Highlight" help="Color for the active word." onReset={() => setAnimationHighlight(textAnimationDefaultHighlight())}>
          <ColorField color={animationHighlight()} onChange={setAnimationHighlight} />
        </InspectorRow>
      </Show>
    </EditorPanelGroup>
  );

  const agentMenu = () => (
    <Show when={props.onAgentTask && !transcriptOnly}>
      <DropdownMenuButton
        class="cap-agent-button"
        title="Let Agent create captions for you. Choose a predefined task, or ask Agent in the chat."
        items={() => {
          const send = (task: string): void =>
            props.onAgentTask?.(`If the timeline has no captions yet, transcribe the spoken audio and add captions on word boundaries first. Then ${task}`);
          return [
            ...agentTasks.map((t) => ({ kind: "item" as const, label: t.label, onSelect: () => send(t.prompt) })),
            { kind: "divider" as const },
            ...translateLanguages.map(([name]) => ({
              kind: "item" as const,
              label: `Translate to ${name}`,
              onSelect: () => send(`translate the captions to ${name}, keeping each caption's timing unchanged.`),
            })),
          ];
        }}
      >
        <Sparkles size={12} />
        Agent
      </DropdownMenuButton>
    </Show>
  );

  const generateBar = (
    <div class="cap-footer">
      <Show when={note() ?? (noBackend() ? "Add an ElevenLabs or OpenAI API key to transcribe." : undefined)}>
        {(message) => <p class="cap-footer-message" classList={{ error: note() !== undefined }}>{message()}</p>}
      </Show>
      <div class="cap-footer-row">
        <Show when={noBackend()}>
          <CapsuleButton size="small" onClick={props.onOpenSettings}>
            <KeyRound size={11} />
            Add API key
          </CapsuleButton>
        </Show>
        <span class="cap-footer-spacer" />
        <CapsuleButton variant="prominent" size="small" disabled={!canGenerate()} title={generateHelp()} onClick={() => void generate()}>
          {generateLabel()}
        </CapsuleButton>
        {agentMenu()}
      </div>
    </div>
  );

  return (
    <div class="cap-tab">
      <div class="cap-scroll">
        {sourceSection}
        <Show when={!transcriptOnly}>
          {settingsSection}
          {styleSection}
          {animationSection}
        </Show>
      </div>
      {generateBar}
      <Show when={isGenerating()}>
        <div class="cap-busy">
          <GeneratingOverlay label="Transcribing…" size="preview" />
        </div>
      </Show>
    </div>
  );
}
