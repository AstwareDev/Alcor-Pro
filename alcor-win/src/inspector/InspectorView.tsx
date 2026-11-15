import AudioLines from "lucide-solid/icons/audio-lines";
import Clapperboard from "lucide-solid/icons/clapperboard";
import Diamond from "lucide-solid/icons/diamond";
import Info from "lucide-solid/icons/info";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import TextAlignStart from "lucide-solid/icons/text-align-start";
import Video from "lucide-solid/icons/video";
import WandSparkles from "lucide-solid/icons/wand-sparkles";
import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { clipSupportsRetiming, timelineTotalFrames, type MediaAsset } from "../model";
import type { Editor } from "../editor/editor";
import { cancelChromaKeySampling } from "../editor/mutations/chromaKey";
import { applyTimelineSettings, canvasPresetResolution, canvasPresets, customFrameRateRange, parseCustomFrameRate } from "../editor/mutations/projectSettings";
import type { MenuItem } from "../ui/Menu";
import { CapsuleButton } from "../ui/CapsuleButton";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup } from "../ui/EditorPanel";
import { TitleTabBar, type TitleTabItem } from "../ui/TitleTabBar";
import { linkedPartnerIds } from "../editor/mutations/linking";
import { AIEditTab } from "../generation/AIEditTab";
import { GenerationReferencesStrip, hasResolvableReferences } from "../generation/GenerationReferencesStrip";
import { multicamGroupById } from "../editor/mutations/multicamRules";
import { AdjustmentLayerSection } from "./AdjustmentLayerSection";
import { AdjustTab } from "./AdjustTab";
import { AudioTab } from "./AudioTab";
import { idsMemo } from "./fields";
import {
  activeTab, aiEditEligible, aspectDisplayLabel, aspectPresets, availableTabs, aspectRatioErrorMessages, clipTabTitles, formatDuration,
  frameRatePresets, inspectorClipCount, preferredTabAfterSelection, qualityPresets, qualityResolution,
  resolutionForAspectText, resolveInspectorSelection, selectedMulticamGroupId, type ClipTab,
} from "./inspectorLogic";
import { MulticamTab } from "./MulticamTab";
import { inspectorServices } from "./services";
import { TextAnimateTab, TextTab } from "./TextTab";
import { TransitionSection } from "./TransitionSection";
import { VideoTab } from "./VideoTab";
import "./inspector.css";

const tabIcons: Record<ClipTab, JSX.Element> = {
  text: <TextAlignStart size={12} />,
  textAnimate: <Diamond size={12} />,
  video: <Video size={12} />,
  effects: <SlidersHorizontal size={12} />,
  audio: <AudioLines size={12} />,
  multicam: <LayoutGrid size={12} />,
  ai: <WandSparkles size={12} />,
};

/** Right-hand inspector: clip tabs, media-asset info, or project settings . */
export function InspectorView(props: { editor: Editor }) {
  const { editor } = props;
  const [preferredTab, setPreferredTab] = createSignal<ClipTab>("video");

  const selection = createMemo(() => resolveInspectorSelection(editor.timeline, editor.ui.selectedClipIds));
  const textIds = idsMemo(() => selection().textClips.map((c) => c.id));
  const visualIds = idsMemo(() => selection().nonTextVisualClips.map((c) => c.id));
  const audioIds = idsMemo(() => selection().audioClips.map((c) => c.id));
  const retimableIds = idsMemo(() => [...selection().nonTextVisualClips, ...selection().audioClips].filter(clipSupportsRetiming).map((c) => c.id));
  const clipCount = createMemo(() => inspectorClipCount(selection()));
  const adjustmentOnly = createMemo(() => selection().nonTextVisualClips.length > 0 && selection().nonTextVisualClips.every((c) => c.adjustment === true));
  const multicamGroupId = createMemo(() => selectedMulticamGroupId(selection(), (id) => multicamGroupById(editor, id) !== undefined));
  const clipAsset = createMemo<MediaAsset | undefined>(() => {
    const clip = selection().firstVisualClip ?? selection().firstAudioClip;
    return clip === undefined ? undefined : editor.mediaAssets.find((a) => a.id === clip.mediaRef);
  });
  const aiClipId = () => selection().firstVisualClip?.id ?? selection().firstAudioClip?.id;
  const aiEligible = createMemo(() => aiEditEligible(selection(), clipAsset() !== undefined, (id) => linkedPartnerIds(editor, id)));
  const tabs = createMemo(() => availableTabs(selection(), multicamGroupId(), aiEligible()), [], { equals: (a, b) => a.join() === b.join() });
  const selected = createMemo(() => activeTab(tabs(), preferredTab()));

  const selectedAsset = createMemo<MediaAsset | undefined>(() => {
    const ids = editor.ui.selectedMediaAssetIds;
    const id = ids.size === 1 ? [...ids][0] : undefined;
    return id === undefined ? undefined : editor.mediaAssets.find((a) => a.id === id);
  });

  createEffect(
    on(
      () => editor.ui.selectedClipIds,
      (ids) => {
        cancelChromaKeySampling(editor);
        if (editor.ui.isMarqueeSelecting) return;
        const types = [...ids].flatMap((id) => editor.clipFor(id)?.mediaType ?? []);
        setPreferredTab((cur) => preferredTabAfterSelection(types, cur));
        editor.ui.cropEditingActive = false;
      },
      { defer: true },
    ),
  );
  createEffect(on(selected, (tab) => { if (tab !== "video") editor.ui.cropEditingActive = false; }, { defer: true }));

  const tabItems = (): TitleTabItem[] => tabs().map((t) => ({ id: t, title: clipTabTitles[t], icon: tabIcons[t] }));

  return (
    <div class="inspector">
      <Show
        when={!editor.ui.isMarqueeSelecting}
        fallback={<div class="inspector-center">{editor.ui.selectedClipIds.size} selected</div>}
      >
        <Show
          when={clipCount() > 0}
          fallback={
            <TransitionSection editor={editor} fallback={
              <Show when={selectedAsset()} fallback={<ProjectSettings editor={editor} />}>
                {(asset) => <MediaAssetInspector editor={editor} asset={asset()} />}
              </Show>
            } />
          }
        >
          <Show when={tabs().length > 1}>
            <TitleTabBar items={tabItems()} selected={selected()} onSelect={(id) => setPreferredTab(id as ClipTab)} />
          </Show>
          <div class="inspector-scroll">
            <Show when={selected() === "ai" ? clipAsset() : undefined}>
              {(asset) => <AIEditTab editor={editor} asset={asset()} clipId={aiClipId()} />}
            </Show>
            <Show when={selected() === "text"}><TextTab editor={editor} ids={textIds} /></Show>
            <Show when={selected() === "textAnimate"}><TextAnimateTab editor={editor} ids={textIds} /></Show>
            <Show when={selected() === "video"}><VideoTab editor={editor} visualIds={visualIds} retimableIds={retimableIds} /></Show>
            <Show when={selected() === "effects"}>
              <Show when={adjustmentOnly()}><AdjustmentLayerSection editor={editor} ids={visualIds} /></Show>
              <AdjustTab editor={editor} ids={visualIds} />
            </Show>
            <Show when={selected() === "audio"}><AudioTab editor={editor} audioIds={audioIds} hasVisual={visualIds().length > 0} /></Show>
            <Show when={selected() === "multicam" ? multicamGroupId() : undefined}>{(groupId) => <MulticamTab editor={editor} groupId={groupId()} />}</Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function PanelHeader(props: { icon: JSX.Element; title: string; trailing?: JSX.Element }) {
  return (
    <div class="panel-header inspector-header">
      <span class="inspector-header-icon">{props.icon}</span>
      <span class="inspector-header-title">{props.title}</span>
      <span class="inspector-header-spacer" />
      {props.trailing}
    </div>
  );
}

function MetadataMenuRow(props: { label: string; value: string; items: () => MenuItem[] }) {
  return (
    <div class="metadata-row">
      <span class="metadata-label">{props.label}</span>
      <DropdownMenuButton items={props.items}>
        <EditorMenuValue text={props.value} />
      </DropdownMenuButton>
    </div>
  );
}

function menuItem(label: string, checked: boolean, onSelect: () => void): MenuItem {
  return { kind: "item", label, checked, onSelect };
}

function ProjectSettings(props: { editor: Editor }) {
  const { editor } = props;
  const [customOpen, setCustomOpen] = createSignal(false);
  const [customFpsOpen, setCustomFpsOpen] = createSignal(false);
  const t = () => editor.timeline;
  const apply = (fps: number, width: number, height: number): void => applyTimelineSettings(editor, fps, width, height);
  const duration = () => formatDuration(timelineTotalFrames(t()) / t().fps);
  return (
    <>
      <PanelHeader icon={<Clapperboard size={13} />} title="Project Settings" trailing={<span class="inspector-header-duration">{duration()}</span>} />
      <div class="inspector-scroll">
        <EditorPanelGroup title="Canvas" gap="var(--sp-sm)">
          <MetadataMenuRow
            label="Resolution"
            value={`${t().width} × ${t().height}`}
            items={() =>
              qualityPresets.map((p) => {
                const r = qualityResolution(p.shortEdge, t().width, t().height);
                return menuItem(p.label, Math.min(t().width, t().height) === p.shortEdge, () => apply(t().fps, r.width, r.height));
              })
            }
          />
          <MetadataMenuRow
            label="Frame Rate"
            value={`${t().fps} fps`}
            items={() => [
              ...frameRatePresets.map((fps) => menuItem(`${fps} fps`, t().fps === fps, () => apply(fps, t().width, t().height))),
              { kind: "divider" } satisfies MenuItem,
              { kind: "item", label: "Custom…", checked: !frameRatePresets.includes(t().fps), onSelect: () => setCustomFpsOpen(true) } satisfies MenuItem,
            ]}
          />
          <MetadataMenuRow
            label="Aspect Ratio"
            value={aspectDisplayLabel(t().width, t().height)}
            items={() => [
              ...aspectPresets.map((p) => menuItem(p.label, p.width === t().width && p.height === t().height, () => apply(t().fps, p.width, p.height))),
              { kind: "divider" } satisfies MenuItem,
              ...canvasPresets.map((p) => {
                const r = canvasPresetResolution(p);
                return menuItem(`${p.label} (${r.width}×${r.height})`, r.width === t().width && r.height === t().height, () => apply(t().fps, r.width, r.height));
              }),
              { kind: "divider" } satisfies MenuItem,
              { kind: "item", label: "Custom…", onSelect: () => setCustomOpen(true) } satisfies MenuItem,
            ]}
          />
        </EditorPanelGroup>
      </div>
      <Show when={customOpen()}>
        <CustomAspectRatioSheet editor={editor} onClose={() => setCustomOpen(false)} />
      </Show>
      <Show when={customFpsOpen()}>
        <CustomFrameRateSheet editor={editor} onClose={() => setCustomFpsOpen(false)} />
      </Show>
    </>
  );
}

function CustomFrameRateSheet(props: { editor: Editor; onClose: () => void }) {
  const { editor } = props;
  const [text, setText] = createSignal(String(editor.timeline.fps));
  const fps = () => parseCustomFrameRate(text());
  const changed = (): boolean => fps() !== undefined && fps() !== editor.timeline.fps;
  const apply = (): void => {
    const value = fps();
    if (value === undefined || !changed()) return;
    applyTimelineSettings(editor, value, editor.timeline.width, editor.timeline.height);
    props.onClose();
  };
  return (
    <Portal>
      <div class="dialog-scrim" onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); else if (e.key === "Enter") apply(); }}>
        <div class="dialog aspect-sheet" role="dialog" aria-label="Custom Frame Rate">
          <div class="dialog-title">Custom Frame Rate</div>
          <div class="dialog-message">Whole frames per second, {customFrameRateRange.min}–{customFrameRateRange.max}. Clips are rescaled to the new rate.</div>
          <label class="aspect-field">
            <span>Frames per second</span>
            <input class="editor-value-field" aria-label="Frames per second" inputMode="numeric" value={text()} onInput={(e) => setText(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.select())} />
          </label>
          <Show when={fps() === undefined}>
            <div class="editor-footer-error">Enter a whole number from {customFrameRateRange.min} to {customFrameRateRange.max}.</div>
          </Show>
          <div class="dialog-buttons">
            <CapsuleButton size="regular" onClick={props.onClose}>Cancel</CapsuleButton>
            <CapsuleButton size="regular" variant="prominent" disabled={!changed()} onClick={apply}>Apply</CapsuleButton>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function CustomAspectRatioSheet(props: { editor: Editor; onClose: () => void }) {
  const { editor } = props;
  const initial = { id: editor.timeline.id, width: editor.timeline.width, height: editor.timeline.height };
  const parts = aspectDisplayLabel(initial.width, initial.height).split(":");
  const [h, setH] = createSignal(parts[0] ?? "");
  const [v, setV] = createSignal(parts[1] ?? "");
  const changed = (): boolean => h() !== parts[0] || v() !== parts[1];
  const validation = () => {
    const t = editor.timeline;
    if (t.id !== initial.id || t.width !== initial.width || t.height !== initial.height) {
      return { message: "The timeline settings changed. Close this sheet and try again." } as const;
    }
    if (!changed()) return { resolution: { width: initial.width, height: initial.height } } as const;
    const r = resolutionForAspectText(`${h()}:${v()}`, Math.min(initial.width, initial.height));
    return r.ok ? ({ resolution: r.value } as const) : ({ message: aspectRatioErrorMessages[r.code] } as const);
  };
  const resolution = () => {
    const val = validation();
    return "resolution" in val ? val.resolution : undefined;
  };
  const apply = (): void => {
    const r = resolution();
    if (!r || !changed()) return;
    applyTimelineSettings(editor, editor.timeline.fps, r.width, r.height);
    props.onClose();
  };
  const field = (label: string, value: () => string, set: (s: string) => void) => (
    <label class="aspect-field">
      <span>{label}</span>
      <input class="editor-value-field" aria-label={`Aspect ratio: ${label}`} value={value()} onInput={(e) => set(e.currentTarget.value)} />
    </label>
  );
  return (
    <Portal>
      <div class="dialog-scrim" onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); else if (e.key === "Enter") apply(); }}>
        <div class="dialog aspect-sheet" role="dialog" aria-label="Custom Aspect Ratio">
          <div class="dialog-title">Custom Aspect Ratio</div>
          <div class="dialog-message">Changing the ratio preserves the shorter edge.</div>
          <div class="aspect-fields">
            {field("Width", h, setH)}
            <span class="aspect-colon">:</span>
            {field("Height", v, setV)}
          </div>
          <Show when={resolution()} fallback={<div class="editor-footer-error">{"message" in validation() ? (validation() as { message: string }).message : ""}</div>}>
            {(r) => <div class="aspect-resolution">Resolution <span>{r().width} × {r().height}</span></div>}
          </Show>
          <div class="dialog-buttons">
            <CapsuleButton size="regular" onClick={props.onClose}>Cancel</CapsuleButton>
            <CapsuleButton size="regular" variant="prominent" disabled={resolution() === undefined || !changed()} onClick={apply}>Apply</CapsuleButton>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function MediaAssetInspector(props: { editor: Editor; asset: MediaAsset }) {
  const [info, setInfo] = createSignal(false);
  const [size, setSize] = createSignal<string | undefined>(undefined);
  createEffect(() => {
    const path = props.asset.url;
    setSize(undefined);
    if (info()) void inspectorServices.fileSize?.(path).then(setSize);
  });
  const row = (label: string, value: string): JSX.Element => (
    <div class="plain-row">
      <span class="plain-label">{label}</span>
      <span class="plain-value" title={value}>{value}</span>
    </div>
  );
  const a = (): MediaAsset => props.asset;
  return (
    <>
      <PanelHeader
        icon={<Video size={13} />}
        title={a().name}
        trailing={
          <button type="button" class="inspector-info-button" classList={{ on: info() }} aria-label={info() ? "Hide Info" : "Show Info"} title={info() ? "Hide Info" : "Show Info"} onClick={() => setInfo(!info())}>
            <Info size={14} />
          </button>
        }
      />
      <div class="inspector-scroll">
        <Show when={info()}>
          <div class="asset-info">
            {row("Type", a().type)}
            <Show when={a().type !== "audio" && a().sourceWidth !== undefined && a().sourceHeight !== undefined}>
              {row("Dimensions", `${a().sourceWidth} × ${a().sourceHeight}`)}
            </Show>
            <Show when={(a().sourceFPS ?? 0) > 0}>{row("FPS", `${Math.round((a().sourceFPS ?? 0) * 1000) / 1000} fps`)}</Show>
            <Show when={a().duration > 0 && a().type !== "image"}>{row("Duration", formatDuration(a().duration))}</Show>
            <Show when={size()}>{(s) => row("Size", s())}</Show>
            {row("Path", a().url)}
          </div>
        </Show>
        <Show when={a().generationInput}>
          {(gen) => (
            <Show when={hasResolvableReferences(gen(), props.editor.mediaAssets)}>
              <EditorPanelGroup title="Generation Input" padding="var(--sp-xxs) var(--sp-sm-md) var(--sp-md)">
                <GenerationReferencesStrip editor={props.editor} generationInput={gen()} />
              </EditorPanelGroup>
            </Show>
          )}
        </Show>
        <AIEditTab editor={props.editor} asset={a()} />
      </div>
    </>
  );
}
