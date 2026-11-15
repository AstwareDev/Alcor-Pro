// Port of MediaPanel/AudioPanelTab (AudioPanelTab + MusicTab) plus SpeechTab's speaker labels (colour / rename / remove).
// Silence detection lives in src/deadair; speaker Identify (voice matching) is not ported, so the registry only holds
// speakers from opened projects.
import AudioWaveform from "lucide-solid/icons/audio-waveform";
import { createMemo, createSignal, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import type { MediaPanelExtraTab } from "../mediapanel/MediaPanelView";
import { selectedTimelineSpan } from "../editor/mutations/generatedClips";
import { validSelectedTimelineRange } from "../editor/mutations/timelineRange";
import { CapsuleButton } from "../ui/CapsuleButton";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { audioModels, isEntryUsable } from "./catalog";
import { audioCost, formatUsd } from "./costEstimator";
import { GeneratingOverlay } from "./GeneratingOverlay";
import { SpeakerSection } from "./SpeakerSection";
import { audioInputs, audioCategory, audioPromptLabel, validateAudioParams, validateAudioSpan, type AudioEntry } from "./modelConfig";
import { musicHooks, musicPhaseLabel, runMusicGeneration, type MusicMode } from "./musicGeneration";
import "./generation.css";

function clock(frame: number, fps: number): string {
  const total = frame / Math.max(1, fps);
  return `${Math.trunc(total / 60)}:${String(Math.trunc(total % 60)).padStart(2, "0")}`;
}

export function MusicSection(props: { editor: Editor; onOpenSettings: () => void }) {
  const editor = props.editor;
  const [modelId, setModelId] = createSignal<string>();
  const [mode, setMode] = createSignal<MusicMode>("videoToMusic");
  const [prompt, setPrompt] = createSignal("");
  const [textDuration, setTextDuration] = createSignal(90);
  const [busyLabel, setBusyLabel] = createSignal<string>();
  const [note, setNote] = createSignal<string>();

  const models = createMemo(() => audioModels().filter((m) => audioCategory(m) === "music" && (audioInputs(m).includes("video") || audioInputs(m).includes("text"))));
  const model = (): AudioEntry | undefined => models().find((m) => m.id === modelId()) ?? models().find(isEntryUsable) ?? models()[0];
  const supportsText = (m: AudioEntry | undefined) => !!m && audioInputs(m).includes("text");
  const supportsVideo = (m: AudioEntry | undefined) => !!m && audioInputs(m).includes("video");
  const effectiveMode = (): MusicMode => (supportsText(model()) && (mode() === "textToMusic" || !supportsVideo(model())) ? "textToMusic" : "videoToMusic");
  const isText = () => effectiveMode() === "textToMusic";
  const range = () => model()?.uiCapabilities.durationRange;
  const source = () => selectedTimelineSpan(editor);
  const spanSeconds = () => { const s = source(); return s ? s.frameCount / Math.max(1, editor.timeline.fps) : 0; };
  const marked = () => validSelectedTimelineRange(editor);
  const placementFrame = () => marked()?.startFrame ?? editor.ui.currentFrame;
  const costDuration = () => (isText() ? Math.round(textDuration()) : Math.round(spanSeconds()));
  const cost = () => { const m = model(); return m && costDuration() > 0 ? audioCost(m, { prompt: prompt().trim(), durationSeconds: costDuration() }) : undefined; };
  const locked = () => { const m = model(); return !!m && !isEntryUsable(m); };

  const validation = (): string | undefined => {
    const m = model();
    if (!m) return "No music models available.";
    if (isText()) {
      if (prompt().trim() === "") return "Describe the music to generate.";
      return validateAudioParams(m, { prompt: prompt().trim(), durationSeconds: costDuration() });
    }
    if (!source()) return "Add video to the timeline, then mark a range to score only part of it.";
    if (!musicHooks.renderTimelineSpan) return "Rendering the timeline for video-to-music is not available yet.";
    return validateAudioSpan(m, spanSeconds());
  };
  const sourceSummary = (): string => {
    const s = source();
    if (!s) return "No video";
    const fps = editor.timeline.fps;
    const r = `${clock(s.startFrame, fps)} – ${clock(s.startFrame + s.frameCount, fps)} · ${spanSeconds().toFixed(1)}s`;
    return marked() ? r : `Whole timeline · ${r}`;
  };

  const generate = (): void => {
    setNote(undefined);
    const m = model();
    if (!m) return;
    if (locked()) return props.onOpenSettings();
    const text = prompt().trim();
    const common = { model: m, ...(text ? { prompt: text } : {}), onPhase: (p: "exporting" | "generating") => setBusyLabel(musicPhaseLabel[p]), onFinished: () => setBusyLabel(undefined) };
    setBusyLabel(isText() ? musicPhaseLabel.generating : musicPhaseLabel.exporting);
    const run = isText()
      ? runMusicGeneration(editor, { ...common, mode: "textToMusic", source: { startFrame: placementFrame(), frameCount: Math.max(1, Math.trunc(textDuration() * Math.max(1, editor.timeline.fps))) }, spanSeconds: textDuration() })
      : (() => { const s = source(); return s ? runMusicGeneration(editor, { ...common, mode: "videoToMusic", source: s, spanSeconds: spanSeconds() }) : Promise.resolve(); })();
    run.catch((e: unknown) => { setNote(e instanceof Error ? e.message : String(e)); setBusyLabel(undefined); });
  };

  return (
    <div style={{ position: "relative" }}>
      <EditorPanelGroup title="Music">
        <Show when={supportsText(model()) && supportsVideo(model())}>
          <InspectorRow label="Input" onReset={() => setMode("videoToMusic")}>
            <DropdownMenuButton items={() => [
              { kind: "item", label: "Video to Music", onSelect: () => setMode("videoToMusic") },
              { kind: "item", label: "Text to Music", onSelect: () => setMode("textToMusic") },
            ]}><EditorMenuValue text={isText() ? "Text to Music" : "Video to Music"} expanded /></DropdownMenuButton>
          </InspectorRow>
        </Show>
        <Show
          when={isText()}
          fallback={<InspectorRow label="Video" help="Uses the whole timeline by default. Mark a range on the timeline to score only that span."><span class="gen-label">{sourceSummary()}</span></InspectorRow>}
        >
          <InspectorRow label="Duration" help="Length of the generated music. It's placed at the playhead, or at the marked range start." onReset={() => setTextDuration(range()?.defaultValue ?? 90)}>
            <ScrubbableNumberField value={textDuration()} range={{ min: range()?.minimum ?? 1, max: range()?.maximum ?? 600 }} format="%.0f" valueSuffix=" s"
              dragValueAdjustment={Math.round} onChanged={(v) => setTextDuration(Math.round(v))} onCommit={(v) => setTextDuration(Math.round(v))} />
          </InspectorRow>
        </Show>
        <InspectorRow label="Model" onReset={() => setModelId(undefined)}>
          <DropdownMenuButton items={() => models().map((m) => ({ kind: "item" as const, label: isEntryUsable(m) ? m.displayName : `${m.displayName} (Add API key)`, onSelect: () => setModelId(m.id), checked: m.id === model()?.id }))}>
            <EditorMenuValue text={model()?.displayName ?? "None"} expanded />
          </DropdownMenuButton>
        </InspectorRow>
        <InspectorRow label="Prompt">
          <textarea class="editor-value-field" rows={3} style={{ width: "100%", resize: "vertical" }} placeholder={model() ? audioPromptLabel(model() as AudioEntry) : ""}
            value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} />
        </InspectorRow>
        <Show when={note() ?? validation()}>{(m) => <span style={{ color: "var(--status-error)", "font-size": "var(--fs-xs)" }}>{m()}</span>}</Show>
        <div style={{ display: "flex", "justify-content": "flex-end", gap: "var(--sp-sm)", "align-items": "center" }}>
          <Show when={cost() !== undefined}><span class="gen-cost">{formatUsd(cost())}</span></Show>
          <CapsuleButton variant="prominent" disabled={!locked() && (validation() !== undefined || busyLabel() !== undefined)} onClick={generate}>
            {locked() ? "Add API key" : "Generate"}
          </CapsuleButton>
        </div>
      </EditorPanelGroup>
      <Show when={busyLabel()}>
        {(label) => (
          <div style={{ position: "absolute", inset: 0, background: "rgb(0 0 0 / var(--op-prominent))" }}>
            <GeneratingOverlay label={label()} size="preview" />
          </div>
        )}
      </Show>
    </div>
  );
}

/** Media-panel `extraTabs` entry: pass to `MediaPanelView`. */
export function audioPanelTab(editor: Editor, onOpenSettings: () => void): MediaPanelExtraTab {
  return {
    id: "audio",
    icon: <AudioWaveform size={14} />,
    label: "Audio",
    render: () => (
      <div style={{ width: "100%", height: "100%", overflow: "auto", background: "var(--bg-surface)" }}>
        <MusicSection editor={editor} onOpenSettings={onOpenSettings} />
        <SpeakerSection editor={editor} />
      </div>
    ),
  };
}
