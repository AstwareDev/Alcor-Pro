import { Show, createEffect, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Editor } from "./editor/editor";
import { EditorView } from "./editor/EditorView";
import { HomeView } from "./home/HomeView";
import { MediaPanelView } from "./mediapanel/MediaPanelView";
import { PreviewView } from "./preview/PreviewView";
import { PromptBar } from "./promptbar/PromptBar";
import { TimelinePane } from "./timeline/view/TimelinePane";
import { InspectorView } from "./inspector/InspectorView";
import { ExportDialog } from "./export/ExportDialog";
import { GenerationPanel } from "./generation/GenerationPanel";
import { audioPanelTab } from "./generation/AudioPanelTabs";
import { aiEditClipMenuProvider } from "./generation/aiEditMenu";
import { getGenerationService } from "./generation/generationService";
import { clipMenuSectionProviders } from "./timeline/view/contextMenus";
import { multicamClipMenuProviders } from "./timeline/view/multicamMenus";
import { nestClipMenuProvider } from "./timeline/view/nestMenu";
import { installDeadAirWash } from "./deadair/deadAirService";
import { installEditorIntegrations } from "./appIntegrations";
import { beatClipMenuProvider } from "./beats/beatsMenu";
import { beatStore } from "./beats/beatState";
import { forgetDenoise, resetDenoiseSessionState, watchDenoise } from "./denoise/denoiseState";
import { onCacheCleared } from "./settings/storage";
import "./generation/providers";
import { submitJob, watchJob } from "./generation/providers/jobs";
import { setJobRunner } from "./generation/jobRunner";
import { applyStoredAppearance } from "./settings/appearance";
import { captionsPanelTab, transcriptPanelTab } from "./captions/panelTabs";
import { PreviewOverlays } from "./preview/overlays/PreviewOverlays";
import { libraryPanelTab } from "./library/LibraryTab";
import { parseSubtitleDuration } from "./captions/subtitleFileParser";
import { mediaHooks } from "./media/mediaHooks";
import { projectSessionAgentHost } from "./agent/tools/agentHost";
import { startAgentMcpBridge } from "./agent/mcpBridge";
import { canvasTextMeasurer } from "./preview/textRenderer";
import { SettingsView } from "./settings/SettingsView";
import { refreshProviderKeys } from "./settings/keys";
import { closeProject, openProject, saveProject } from "./project/projectSession";
import { stem } from "./project/projectPaths";
import { lutLoader } from "./platform/luts";
import { installAppServices } from "./appServices";
import { renderTimelineFrame } from "./agent/tools/renderTimelineFrame";
import type { PlaybackEngine } from "./preview/playback";

if (isTauri()) installAppServices();
setJobRunner({ submit: submitJob, watch: watchJob });
applyStoredAppearance();
mediaHooks.parseSubtitleDuration = parseSubtitleDuration;
mediaHooks.assetRelinked = (id) => {
  forgetDenoise(id);
  beatStore.invalidate(id);
};

/** `?dev=<feature>` renders `src/<feature>/dev.tsx` for in-browser checks without Tauri. */
const devPages = import.meta.glob<{ default: Component }>("./*/dev.tsx");
const devName = import.meta.env.DEV ? new URLSearchParams(location.search).get("dev") : null;

function Workspace() {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const editorListeners = new Set<() => void>();
  createEffect(() => {
    editor();
    for (const listener of editorListeners) listener();
  });
  const openSettings = () => setSettingsOpen(true);

  createEffect(() => {
    const current = editor();
    if (!current) return;
    const providers = [aiEditClipMenuProvider(current), nestClipMenuProvider(current), beatClipMenuProvider(current), ...multicamClipMenuProviders(current)];
    onCleanup(watchDenoise(current));
    onCleanup(onCacheCleared(() => {
      beatStore.reset();
      resetDenoiseSessionState(current);
    }));
    onCleanup(installDeadAirWash(current));
    onCleanup(installEditorIntegrations(current));
    clipMenuSectionProviders.push(...providers);
    getGenerationService().resumePendingGenerations(current);
    onCleanup(() => {
      for (const provide of providers) {
        const index = clipMenuSectionProviders.indexOf(provide);
        if (index >= 0) clipMenuSectionProviders.splice(index, 1);
      }
    });
  });

  const open = async (path: string) => {
    try {
      setEditor(await openProject(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const close = async () => {
    const current = editor();
    if (!current) return;
    await closeProject(current);
    setEditor(null);
  };

  onMount(() => {
    if (isTauri()) {
      const host = projectSessionAgentHost({
        getEditor: editor,
        setEditor,
        displayName: (e) => stem(e.projectPath ?? "Untitled Project"),
        onCurrentEditorChange: (listener) => {
          editorListeners.add(listener);
          return () => editorListeners.delete(listener);
        },
        measureText: canvasTextMeasurer,
        renderTimelineFrame,
      });
      startAgentMcpBridge(host).catch((err) => console.error("MCP bridge", err));
    }
    if (isTauri()) refreshProviderKeys().catch((err) => console.error("refreshProviderKeys", err));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      const current = editor();
      if (current && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        current.ui.showExportDialog = true;
        return;
      }
      if (current && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveProject(current).catch((err) => current.showToast(String(err), "error"));
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    if (!isTauri()) return;
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await close();
      } finally {
        await win.destroy();
      }
    });
    onCleanup(() => void unlisten.then((off) => off()));
  });

  return (
    <>
    <Show when={settingsOpen()}>
      <div class="app-settings">
        <SettingsView onClose={() => setSettingsOpen(false)} />
      </div>
    </Show>
    <Show
      when={editor()}
      keyed
      fallback={
        <>
          <HomeView onOpenProject={open} onOpenSettings={openSettings} />
          <Show when={error()}>{(message) => <div class="app-error">{message()}</div>}</Show>
        </>
      }
    >
      {(current) => (
        <>
        <EditorView
          editor={current}
          title={stem(current.projectPath ?? "Untitled Project")}
          onExport={() => (current.ui.showExportDialog = true)}
          onHome={close}
          onOpenSettings={openSettings}
          panels={{
            media: () => (
              <MediaPanelView
                editor={current}
                onGenerate={() => (current.ui.showGenerationPanel = !current.ui.showGenerationPanel)}
                generationPanel={() => <GenerationPanel editor={current} onOpenSettings={openSettings} />}
                extraTabs={[
                  captionsPanelTab(current, openSettings),
                  audioPanelTab(current, openSettings),
                  transcriptPanelTab(current, openSettings),
                  libraryPanelTab(current, openSettings),
                ]}
              />
            ),
            preview: () => {
              let engine: PlaybackEngine | undefined;
              const loadLut = lutLoader(() => engine?.invalidate());
              return (
                <div class="app-preview-column">
                  <PreviewView
                    editor={current}
                    loadLut={loadLut}
                    onEngine={(e) => (engine = e)}
                    overlay={(canvas, size) => <PreviewOverlays editor={current} canvas={canvas} size={size} engine={() => engine} />}
                  />
                  <PromptBar editor={current} onOpenSettings={openSettings} />
                </div>
              );
            },
            inspector: () => <InspectorView editor={current} />,
            timeline: () => <TimelinePane editor={current} />,
          }}
        />
        <ExportDialog editor={current} />
        </>
      )}
    </Show>
    </>
  );
}

export default function App() {
  const loader = devName ? devPages[`./${devName}/dev.tsx`] : undefined;
  if (loader) {
    const [page] = createResource(() => loader().then((m) => m.default));
    return <Show when={page()}>{(component) => <Dynamic component={component()} />}</Show>;
  }
  return <Workspace />;
}
