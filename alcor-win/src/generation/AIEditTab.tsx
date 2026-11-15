// Port of Inspector/Tabs/AIEditTab.swift (Enhance + Audio action grids). Not ported: Enhance Draft tile, paid-plan gating.
import ArrowRightLeft from "lucide-solid/icons/arrow-right-left";
import AudioWaveform from "lucide-solid/icons/audio-waveform";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Clapperboard from "lucide-solid/icons/clapperboard";
import Globe from "lucide-solid/icons/globe";
import AudioLines from "lucide-solid/icons/audio-lines";
import Plus from "lucide-solid/icons/plus";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Replace from "lucide-solid/icons/replace";
import Scissors from "lucide-solid/icons/scissors";
import Sparkles from "lucide-solid/icons/sparkles";
import WandSparkles from "lucide-solid/icons/wand-sparkles";
import { createSignal, For, Show, type JSX } from "solid-js";
import type { Editor } from "../editor/editor";
import {
  aiAudioPlacement, aiEditAllowed, aiEditTrimmedSource, beginAIAudioTransform, seedGenerationPanel,
} from "../editor/mutations/aiEdit";
import { clipTypeIsVisual, type MediaAsset } from "../model";
import { EditorPanelGroup } from "../ui/EditorPanel";
import { Toggle } from "../ui/Toggle";
import { ContextMenu } from "../ui/ContextMenu";
import { upscaleModelsFor, lipSyncVideoModel } from "./catalog";
import { audioTransformAvailability, audioTransformCopy, type AudioTransformEditKind } from "./edit/audioTransformEditKind";
import { editActionAvailability, type EditAction } from "./edit/editAction";
import {
  audioTransformSeed, createVideoSeed, editSeed, lipSyncSeed, reframeSeed, upscaleSeed, videoAudioSeed,
} from "./edit/editSubmitter";
import { videoToAudioKinds, type VideoToAudioEditKind } from "./edit/videoToAudioEditKind";
import { upscaleSupports } from "./modelConfig";
import { trimmedSourceDurationSeconds, type TrimmedSource } from "./trimmedSource";
import "./generation.css";

function Tile(props: { icon: JSX.Element; title: string; description: string; enabled: boolean; reason?: string; menu?: boolean; onClick: (e: MouseEvent) => void }) {
  return (
    <button type="button" class="gen-action" disabled={!props.enabled} title={props.enabled ? props.description : props.reason ?? props.description} onClick={props.onClick}>
      {props.icon}
      <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{props.title}</span>
      <Show when={props.menu}><ChevronDown size={9} /></Show>
    </button>
  );
}

function ScopeToggle(props: { icon: JSX.Element; label: string; help: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="gen-aiedit-scope" title={props.help}>
      {props.icon}
      <span style={{ flex: 1 }}>{props.label}</span>
      <Toggle checked={props.on} onChange={props.onChange} label={props.label} title={props.help} />
    </div>
  );
}

/** Inspector "AI Edit" tab for a media asset, or for a timeline clip when `clipId` is given. */
export function AIEditTab(props: { editor: Editor; asset: MediaAsset; clipId?: string }) {
  const editor = props.editor;
  const [replaceClipSource, setReplace] = createSignal(false);
  const [useTrimmedClip, setUseTrimmed] = createSignal(true);
  const [placeAudio, setPlaceAudio] = createSignal(true);
  const [createMenu, setCreateMenu] = createSignal<{ x: number; y: number }>();

  const clip = () => (props.clipId ? editor.clipFor(props.clipId) : null);
  const isVisualContext = () => (clip() ? clipTypeIsVisual(clip()?.mediaType ?? "video") : props.asset.type !== "audio");
  const trimAvailable = () => (props.clipId ? aiEditTrimmedSource(editor, props.clipId) !== null : false);
  const trim = (): TrimmedSource | null => (useTrimmedClip() && props.clipId ? aiEditTrimmedSource(editor, props.clipId) : null);
  const effectiveDuration = () => { const t = trim(); return t ? trimmedSourceDurationSeconds(t) : undefined; };
  const disabledReason = () => (aiEditAllowed() ? undefined : "Add an API key in Settings to use AI");
  const asset = () => props.asset;

  const actionTile = (action: EditAction, icon: JSX.Element, title: string, description: string, run: (e: MouseEvent) => void, menu = false): JSX.Element => {
    const a = () => editActionAvailability(action, asset(), effectiveDuration());
    const enabled = () => a().available && disabledReason() === undefined;
    const reason = () => disabledReason() ?? (() => { const x = a(); return x.available ? undefined : x.reason; })();
    return <Tile icon={icon} title={title} description={description} enabled={enabled()} reason={reason()} menu={menu} onClick={run} />;
  };

  const seed = (stored: ReturnType<typeof editSeed>, opts: { trimmed?: TrimmedSource | null; replacement?: boolean; audioPlacement?: ReturnType<typeof aiAudioPlacement> } = {}): void => {
    if (!stored) return;
    seedGenerationPanel(editor, asset(), stored, {
      ...(opts.replacement !== false && replaceClipSource() && props.clipId ? { replacementClipId: props.clipId } : {}),
      trimmedSource: opts.trimmed ?? null,
      audioPlacement: opts.audioPlacement ?? null,
    });
  };

  const present = (action: EditAction): void => {
    const t = trim();
    const a = asset();
    switch (action) {
      case "upscale": {
        if (a.type !== "image" && a.type !== "video") return;
        const model = upscaleModelsFor(a.type).find((m) => upscaleSupports(m, a)) ?? upscaleModelsFor(a.type)[0];
        if (model) seed(upscaleSeed(a, model, t ?? undefined), { trimmed: t });
        return;
      }
      case "reframe": return seed(reframeSeed(a, undefined, t ?? undefined), { trimmed: t });
      case "lipSync": return seed(lipSyncSeed(a, lipSyncVideoModel()), { trimmed: t });
      case "edit": return seed(editSeed(a), { trimmed: t });
      case "generateMusic": return presentVideoAudio("music");
      case "generateSFX": return presentVideoAudio("sfx");
      case "rerun": return seed(a.generationInput ? structuredClone(a.generationInput) : undefined);
      case "createVideo": return;
    }
  };
  const presentVideoAudio = (kind: VideoToAudioEditKind): void => {
    const placement = placeAudio() && props.clipId ? aiAudioPlacement(editor, props.clipId, trim(), videoToAudioKinds[kind].timelineActionName) : null;
    seed(videoAudioSeed(asset(), kind), { trimmed: trim(), replacement: false, audioPlacement: placement });
  };
  const presentTransform = (kind: AudioTransformEditKind): void => {
    if (props.clipId) beginAIAudioTransform(editor, props.clipId, kind, { useTrimmedClip: useTrimmedClip(), placeOnTimeline: placeAudio() });
    else seed(audioTransformSeed(asset(), kind), { replacement: false });
  };

  const transformTile = (kind: AudioTransformEditKind): JSX.Element => {
    const av = () => audioTransformAvailability(kind, asset(), effectiveDuration());
    const copy = audioTransformCopy[kind];
    return (
      <Tile icon={kind === "cleanup" ? <AudioWaveform size={14} /> : <Globe size={14} />} title={copy.title} description={copy.description}
        enabled={av().available && disabledReason() === undefined}
        reason={disabledReason() ?? (() => { const x = av(); return x.available ? undefined : x.reason; })()} onClick={() => presentTransform(kind)} />
    );
  };

  const insets = "var(--sp-xxs) var(--sp-sm-md) var(--sp-md)";
  return (
    <div class="gen-aiedit">
      <Show when={trimAvailable()}>
        <ScopeToggle icon={<Scissors size={14} class={useTrimmedClip() ? "on" : ""} />} label="Use trimmed portion only"
          help="Send only the visible clip range to the model, not the full source." on={useTrimmedClip()} onChange={setUseTrimmed} />
      </Show>
      <Show when={isVisualContext()}>
        <EditorPanelGroup title="AI Enhance" padding={insets} gap="var(--sp-sm-md)">
          <Show when={props.clipId}>
            <ScopeToggle icon={<Replace size={14} class={replaceClipSource() ? "on" : ""} />} label="Replace clip source"
              help="Swap the clip's media when generation completes. Speed, volume, trim, and transform are preserved." on={replaceClipSource()} onChange={setReplace} />
          </Show>
          <div class="gen-aiedit-grid">
            {actionTile("upscale", <Sparkles size={14} />, "Upscale", "Enhance resolution or frame rate with AI", () => present("upscale"))}
            {actionTile("edit", <WandSparkles size={14} />, "Edit", "Transform with a prompt or motion reference", () => present("edit"))}
            {actionTile("rerun", <RefreshCw size={14} />, "Rerun", "Regenerate with the same parameters", () => present("rerun"))}
            <Show when={asset().type === "video" && lipSyncVideoModel()}>
              {actionTile("lipSync", <ArrowRightLeft size={14} />, "Lip Sync", "Match mouth movement to replacement audio", () => present("lipSync"))}
            </Show>
            <Show when={asset().type === "video"}>
              {actionTile("reframe", <Clapperboard size={14} />, "Reframe", "Change aspect ratio and extend the frame with AI", () => present("reframe"))}
            </Show>
            <Show when={asset().type === "image"}>
              {actionTile("createVideo", <Plus size={14} />, "Create Video", "Use as first frame or reference", (e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setCreateMenu({ x: r.left, y: r.bottom + 2 });
              }, true)}
            </Show>
          </div>
        </EditorPanelGroup>
      </Show>
      <Show when={asset().type === "video" || asset().type === "audio"}>
        <EditorPanelGroup title="AI Audio" padding={insets} gap="var(--sp-sm-md)">
          <Show when={props.clipId}>
            <ScopeToggle icon={<Plus size={14} class={placeAudio() ? "on" : ""} />} label="Place on timeline"
              help="Add generated audio to an audio track at this clip's start." on={placeAudio()} onChange={setPlaceAudio} />
          </Show>
          <div class="gen-aiedit-grid">
            <Show when={asset().type === "audio"}>
              {actionTile("rerun", <RefreshCw size={14} />, "Rerun", "Regenerate with the same parameters", () => present("rerun"))}
            </Show>
            <For each={["cleanup", "dubbing"] as AudioTransformEditKind[]}>{transformTile}</For>
            <Show when={isVisualContext() && asset().type === "video"}>
              {actionTile("generateMusic", <AudioLines size={14} />, videoToAudioKinds.music.title, videoToAudioKinds.music.description, () => present("generateMusic"))}
              {actionTile("generateSFX", <AudioWaveform size={14} />, videoToAudioKinds.sfx.title, videoToAudioKinds.sfx.description, () => present("generateSFX"))}
            </Show>
          </div>
        </EditorPanelGroup>
      </Show>
      <Show when={createMenu()}>
        {(m) => (
          <ContextMenu x={m().x} y={m().y} onClose={() => setCreateMenu(undefined)} items={[
            { kind: "item", label: "Set as first frame", onSelect: () => seed(createVideoSeed(asset(), false)) },
            { kind: "item", label: "Set as reference", onSelect: () => seed(createVideoSeed(asset(), true)) },
          ]} />
        )}
      </Show>
    </div>
  );
}
