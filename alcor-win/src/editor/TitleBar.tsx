import CircleHelp from "lucide-solid/icons/circle-question-mark";
import Cog from "lucide-solid/icons/cog";
import House from "lucide-solid/icons/house";
import Keyboard from "lucide-solid/icons/keyboard";
import PanelLeft from "lucide-solid/icons/panel-left";
import PanelRight from "lucide-solid/icons/panel-right";
import Check from "lucide-solid/icons/check";
import Save from "lucide-solid/icons/save";
import Share from "lucide-solid/icons/share";
import { ExportActivityDot } from "../export/ExportActivityDot";
import { exportStatusIsPending } from "../export/exportQueue";
import { useExportJobs } from "../export/useExportJobs";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { projectSessionIfOpen, saveProject } from "../project/projectSession";
import type { Editor } from "./editor";
import { WindowControls } from "../ui/WindowControls";
import { AlcorBrand } from "../ui/AlcorBrand";
import { openShortcutsSheet, ShortcutsSheetHost } from "../help/ShortcutsSheet";
import { ProjectActivityButton } from "./ProjectActivityButton";
import { tour } from "../tour/tour";
import {
  inspectorPanelVisible,
  mediaPanelVisible,
  setInspectorPanelVisible,
  setMediaPanelVisible,
} from "./workspace";

function PanelButton(props: { label: string; on: boolean; toggle: () => void; children: JSX.Element }) {
  return (
    <button
      class="titlebar-icon hover-highlight"
      classList={{ on: props.on }}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.on}
      onClick={props.toggle}
    >
      {props.children}
    </button>
  );
}

const savedFlashMs = 1500;

/** Save capsule: unsaved-changes dot while the project is dirty, brief "Saved" confirmation, errors as a toast. */
function SaveButton(props: { editor: Editor }) {
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let flash: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flash));
  const session = () => projectSessionIfOpen(props.editor);
  const dirty = (): boolean => session()?.dirty() ?? false;
  const saving = (): boolean => busy() || (session()?.saving() ?? false);
  const save = async (): Promise<void> => {
    if (saving()) return;
    setBusy(true);
    setSaved(false);
    try {
      await saveProject(props.editor);
      setSaved(true);
      clearTimeout(flash);
      flash = setTimeout(() => setSaved(false), savedFlashMs);
    } catch (error) {
      props.editor.showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const label = (): string => (saving() ? "Saving…" : saved() && !dirty() ? "Saved" : "Save");
  return (
    <button
      class="titlebar-capsule titlebar-save"
      title={dirty() ? "Save (Ctrl+S) - unsaved changes" : "Save (Ctrl+S)"}
      aria-label={dirty() ? "Save, unsaved changes" : "Save"}
      disabled={saving()}
      onClick={() => void save()}
    >
      <Show when={saved() && !dirty() && !saving()} fallback={<Save size={13} />}>
        <Check size={13} />
      </Show>
      {label()}
      <Show when={dirty()}>
        <span class="unsaved-dot" aria-hidden="true" />
      </Show>
    </button>
  );
}

export function TitleBar(props: { title: string; editor?: Editor; onExport: () => void; onHome?: () => void; onOpenSettings?: () => void }) {
  const jobs = useExportJobs();
  const exporting = () => jobs().some((j) => exportStatusIsPending(j.status));
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="titlebar-leading">
        <AlcorBrand compact />
        <Show when={props.onHome}>
          <PanelButton label="Home" on={true} toggle={() => props.onHome?.()}>
            <House size={15} />
          </PanelButton>
        </Show>
        <PanelButton label="Media Panel" on={mediaPanelVisible()} toggle={() => setMediaPanelVisible((v) => !v)}>
          <PanelLeft size={15} />
        </PanelButton>
        <PanelButton
          label="Inspector Panel"
          on={inspectorPanelVisible()}
          toggle={() => setInspectorPanelVisible((v) => !v)}
        >
          <PanelRight size={15} />
        </PanelButton>
      </div>
      <div class="titlebar-title">{props.title}</div>
      <div class="titlebar-trailing">
        <ShortcutsSheetHost />
        <Show when={props.editor}>
          <ProjectActivityButton editor={props.editor as Editor} />
        </Show>
        <button class="titlebar-icon hover-highlight" title="Quick Tour" aria-label="Quick Tour" onClick={() => tour.start()}>
          <CircleHelp size={15} />
        </button>
        <button class="titlebar-icon hover-highlight" title="Keyboard Shortcuts (?)" aria-label="Keyboard Shortcuts" onClick={openShortcutsSheet}>
          <Keyboard size={15} />
        </button>
        <Show when={props.onOpenSettings}>
          <button
            class="titlebar-icon hover-highlight"
            title="Settings (Ctrl+,)"
            aria-label="Settings"
            onClick={() => props.onOpenSettings?.()}
          >
            <Cog size={15} />
          </button>
        </Show>
        <Show when={props.editor && projectSessionIfOpen(props.editor)}>
          <SaveButton editor={props.editor as Editor} />
        </Show>
        <button class="titlebar-capsule" data-tour="export" title="Export (Ctrl+E)" onClick={props.onExport}>
          <Show when={exporting()} fallback={<Share size={13} />}>
            <ExportActivityDot />
          </Show>
          Export
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
