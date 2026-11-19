import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { MediaAsset } from "../../model";
import type { Editor } from "../../editor/editor";
import { placeDroppedAssets } from "../../editor/mutations/linking";
import { addClipsWithSettingsPrompt } from "../../editor/mutations/settingsMismatchPrompt";
import { focusedPanel } from "../../editor/workspace";
import { SettingsMismatchDialog } from "../../project/SettingsMismatchDialog";
import { ToolbarView } from "../../toolbar/ToolbarView";
import { makeTimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { clampedHeaderWidth, HeaderMetrics } from "./headerLayout";
import { MarkerEditorPopover } from "./MarkerEditorPopover";
import { isTextInputTarget, matchShortcut, runShortcut } from "./shortcuts";
import { AudioMeterView } from "./AudioMeterView";
import { TimelineCanvas, type TimelineRenderStats, type TimelineSurface } from "./TimelineCanvas";
import { TimelineHeaders } from "./TimelineHeaders";
import { TimelineTabBar } from "./TimelineTabBar";
import { isTimelineTabBarExpanded } from "./timelineTabs";
import type { TimelineVisualSource } from "./visualSource";
import "./TimelinePane.css";

/** Port of TimelinePaneView + TimelineContainerView: tab bar, toolbar, track headers and the canvas timeline. */
export function TimelinePane(props: {
  editor: Editor;
  /** Thumbnails / waveforms; defaults to src/media. */
  visuals?: TimelineVisualSource;
  /** Shortcuts scoped to the timeline (copy/paste, select forward, Tab) need this; defaults to the focused panel. */
  timelineFocused?: () => boolean;
  onRenderStats?: (stats: TimelineRenderStats) => void;
  onSettingsMismatch?: (assets: readonly MediaAsset[], proceed: () => void) => void;
}) {
  const editor = props.editor;
  // Swift addClipsWithSettingsCheck: the first video with different fps / resolution asks before placing.
  const onSettingsMismatch = (assets: readonly MediaAsset[], proceed: () => void) =>
    props.onSettingsMismatch ? props.onSettingsMismatch(assets, proceed) : addClipsWithSettingsPrompt(editor, assets, proceed);
  const laneState = makeTimelineKeyframeLaneState();
  const [laneRevision, setLaneRevision] = createSignal(0);
  const [headerWidth, setHeaderWidth] = createSignal<number>(HeaderMetrics.defaultWidth);
  const [scrollY, setScrollY] = createSignal(0);
  const [surface, setSurface] = createSignal<TimelineSurface>();
  const [markerEditor, setMarkerEditor] = createSignal<{ id: string; anchor: { x: number; y: number } } | null>(null);
  laneState.onChange = () => {
    if (laneState.expandedTrackIds.size > 0) setHeaderWidth((w) => clampedHeaderWidth(w, true));
    surface()?.controller.cancelActiveDrag();
    setLaneRevision(laneState.revision);
  };

  const timelineFocused = () => (props.timelineFocused ? props.timelineFocused() : focusedPanel() === "timeline");

  const presentMarkerEditor = (id: string, anchor?: { x: number; y: number }) => {
    setMarkerEditor({ id, anchor: anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 } });
  };

  const importOsFiles = async (paths: string[], cursor: { kind: "existingTrack" | "newTrackAt"; index: number }, frame: number, ripple: boolean) => {
    const { importFinderItems, finalizeImportedAsset } = await import("../../media/mediaLibrary");
    const summary = await importFinderItems(editor, paths, editor.ui.mediaPanelCurrentFolderId ?? undefined, { finalize: false });
    const placeable: MediaAsset[] = [];
    for (const asset of summary.assets) {
      if (await finalizeImportedAsset(editor, asset.id, { batchManifestUpdate: true })) {
        const current = editor.mediaAsset(asset.id);
        if (current && current.type !== "subtitle") placeable.push(current);
      }
    }
    if (placeable.length === 0) return;
    const place = () => placeDroppedAssets(editor, placeable, cursor, frame, { ripple });
    onSettingsMismatch(placeable, place);
  };

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTextInputTarget(e.target as HTMLElement | null)) return;
      const binding = matchShortcut(e, { timelineFocused: timelineFocused() });
      if (!binding) return;
      if ((binding.command === "delete" || binding.command === "rippleDelete") && focusedPanel() === "media") return;
      const s = surface();
      const handled = runShortcut(binding.command, {
        editor,
        cancelDrag: () => s?.controller.cancelActiveDrag() ?? false,
        zoomBy: (f) => s?.zoomBy(f),
        zoomToFit: () => s?.zoomToFit(),
        presentMarkerEditor: (id) => s?.controller.host.presentMarkerEditor(id),
      });
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  let resizeStart: { x: number; width: number } | undefined;

  return (
    <div class="timeline-pane" data-tour="timeline">
      <Show when={isTimelineTabBarExpanded(editor)}>
        <TimelineTabBar editor={editor} />
      </Show>
      <ToolbarView editor={editor} presentMarkerEditor={(id) => surface()?.controller.host.presentMarkerEditor(id)} />
      <div class="timeline-body">
        <TimelineHeaders
          editor={editor}
          controller={() => surface()?.controller}
          laneState={laneState}
          laneRevision={laneRevision}
          width={headerWidth()}
          scrollY={scrollY}
          onChanged={() => surface()?.invalidate()}
        />
        <div
          class="timeline-header-resize"
          style={{ left: `${headerWidth()}px` }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            resizeStart = { x: e.clientX, width: headerWidth() };
          }}
          onPointerMove={(e) => {
            if (!resizeStart) return;
            setHeaderWidth(clampedHeaderWidth(resizeStart.width + e.clientX - resizeStart.x, laneState.expandedTrackIds.size > 0));
          }}
          onPointerUp={() => (resizeStart = undefined)}
        />
        <TimelineCanvas
          editor={editor}
          laneState={laneState}
          laneRevision={laneRevision}
          visuals={props.visuals}
          onReady={setSurface}
          onScrollY={setScrollY}
          onRenderStats={props.onRenderStats}
          onPresentMarkerEditor={presentMarkerEditor}
          onSettingsMismatch={onSettingsMismatch}
          importOsFiles={(paths, cursor, frame, ripple) => void importOsFiles(paths, cursor, frame, ripple)}
        />
        <AudioMeterView editor={editor} />
      </div>
      <SettingsMismatchDialog />
      <Show when={markerEditor()}>
        {(m) => {
          const marker = editor.timeline.markers.find((x) => x.id === m().id);
          return marker ? <MarkerEditorPopover editor={editor} marker={marker} anchor={m().anchor} onDismiss={() => setMarkerEditor(null)} /> : null;
        }}
      </Show>
    </div>
  );
}
