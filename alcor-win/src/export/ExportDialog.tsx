import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import Clock from "lucide-solid/icons/clock";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import Circle from "lucide-solid/icons/circle";
import CircleArrowUp from "lucide-solid/icons/circle-arrow-up";
import CircleCheck from "lucide-solid/icons/circle-check";
import CircleX from "lucide-solid/icons/circle-x";
import File from "lucide-solid/icons/file";
import Folder from "lucide-solid/icons/folder";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Package from "lucide-solid/icons/package";
import Square from "lucide-solid/icons/square";
import Trash from "lucide-solid/icons/trash";
import X from "lucide-solid/icons/x";
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Editor } from "../editor/editor";
import { Project } from "../model/constants";
import { timelineTotalFrames } from "../model/timeline";
import { projectNameFromPath } from "../project/projectPaths";
import { CapsuleButton } from "../ui/CapsuleButton";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import type { MenuItem } from "../ui/Menu";
import { RadioIndicator } from "../ui/RadioIndicator";
import { Toggle } from "../ui/Toggle";
import { formatTimecode } from "../util/timeFormatting";
import "./ExportDialog.css";
import {
  exportEstimatedFileBytes, exportFormatFileExtension, exportResolutionRenderSize, exportResolutions, formatFileSize,
  hdrTransferDefault, hdrTransferDisplayName, hdrTransfers, videoCodecContainerLabel, videoCodecExportFormat, videoCodecIsHDR,
  videoCodecs, type ExportResolution, type HdrTransfer, type VideoCodec,
} from "./exportOptions";
import { exportStatusIsFinished, exportStatusIsPending, sharedExportQueue, type ExportJob, type ExportJobStatus } from "./exportQueue";
import {
  enqueuePalmierExport, enqueueTimelineExport, enqueueVideoExport, exportTimelineFor, palmierProjectSummary, projectQueueID,
  type PalmierSummary, type TimelineExportFormat,
} from "./exportRunner";
import { fcpxmlTargetDefault, fcpxmlTargetDisplayName, fcpxmlTargets, fcpxmlVersionCompatibilityNote, fcpxmlVersionDefault, fcpxmlVersions, type FCPXMLTarget, type FCPXMLVersion } from "./fcpxmlExporter";
import { supportedHdrCodecs } from "./hdrExport";
import { useExportJobs } from "./useExportJobs";

type ExportDestination = "Video" | "Timeline" | "Alcor Project";

const destinations: readonly ExportDestination[] = ["Video", "Timeline", "Alcor Project"];

const timelineFormats: readonly TimelineExportFormat[] = ["xmeml", "fcpxml"];

const timelineFormatInfo: Record<TimelineExportFormat, { label: string; extension: string; version: string; summary: string; compatibility: string; fileExtension: string }> = {
  xmeml: {
    label: "XMEML",
    extension: ".xml",
    version: "v4",
    fileExtension: "xml",
    summary: "Older interchange format, best when Premiere Pro is the destination. Supports basic edits and keyframes, but not text, color, effects, edge softness, or edge rounding.",
    compatibility: "Premiere Pro and DaVinci Resolve",
  },
  fcpxml: {
    label: "FCPXML",
    extension: ".fcpxml",
    version: "",
    fileExtension: "fcpxml",
    summary: "Newer timeline format with better support for DaVinci Resolve and Final Cut Pro. Supports basic edits, keyframes, and text, but not color, effects, edge softness, or edge rounding.",
    compatibility: "DaVinci Resolve and Final Cut Pro",
  },
};

const statusLabel: Record<ExportJobStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  rendering: "Rendering",
  canceling: "Canceling",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

const safeFileName = (name: string): string => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "Untitled";

/** Picker button + shared Menu (SwiftUI `Picker` with the menu style). */
function Picker<T extends string>(props: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void; small?: boolean }) {
  const items = (): MenuItem[] =>
    props.options.map((o) => ({ kind: "item", label: props.label(o), checked: o === props.value, onSelect: () => props.onChange(o) }));
  return (
    <DropdownMenuButton class={props.small ? "export-picker small" : "export-picker"} items={items}>
      <span class="export-picker-label">{props.label(props.value)}</span>
      <ChevronsUpDown size={10} />
    </DropdownMenuButton>
  );
}

function SettingRow(props: { label: string; children: JSX.Element }) {
  return (
    <div class="export-setting-row">
      <span class="export-setting-label">{props.label}</span>
      {props.children}
    </div>
  );
}

function IconButton(props: { icon: JSX.Element; help: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="export-icon-button" title={props.help} aria-label={props.help} disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

function StatusIcon(props: { status: ExportJobStatus }) {
  return (
    <>
      {props.status === "queued" && <Clock size={12} class="export-status-tertiary" />}
      {(props.status === "preparing" || props.status === "canceling") && <LoaderCircle size={12} class="export-spin" />}
      {props.status === "rendering" && <CircleArrowUp size={12} class="export-status-accent" />}
      {props.status === "completed" && <CircleCheck size={12} class="export-status-success" />}
      {props.status === "failed" && <CircleX size={12} class="export-status-error" />}
      {props.status === "canceled" && <CircleX size={12} class="export-status-muted" />}
    </>
  );
}

function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s left` : `${s}s left`;
}

function JobRow(props: { job: ExportJob; onCancel: () => void; onRemove: () => void }) {
  const job = () => props.job;
  const time = () => new Date(job().createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div class="export-log-row" title={job().error ?? job().outputPath}>
      <div class="export-log-main">
        <span class="export-log-time">{time()}</span>
        <span class="export-log-status" role="img" aria-label={statusLabel[job().status]}>
          <StatusIcon status={job().status} />
        </span>
        <span class="export-log-name">{job().filename}</span>
        <span class="export-log-bar">
          <Show when={job().status === "rendering"}>
            <span class="export-progress-track">
              <span class="export-progress-fill" style={{ width: `${Math.round(job().progress * 100)}%` }} />
            </span>
          </Show>
        </span>
        <span class="export-log-percent">
          <Show when={job().status === "rendering"}>{Math.floor(job().progress * 100)}%</Show>
        </span>
        <span class="export-log-action">
          {job().status === "queued" && <IconButton icon={<X size={12} />} help="Remove from Queue" onClick={props.onCancel} />}
          {(job().status === "preparing" || job().status === "rendering") && (
            <IconButton icon={<Square size={10} fill="currentColor" />} help="Cancel Export" onClick={props.onCancel} />
          )}
          {job().status === "completed" && (
            <IconButton icon={<Folder size={12} />} help="Reveal in File Explorer" onClick={() => void revealItemInDir(job().outputPath)} />
          )}
          {(job().status === "failed" || job().status === "canceled") && <IconButton icon={<X size={12} />} help="Dismiss" onClick={props.onRemove} />}
        </span>
      </div>
      <Show when={job().status === "rendering" && job().etaSeconds !== undefined}>
        <div class="export-log-note">{formatEta(job().etaSeconds ?? 0)}</div>
      </Show>
      <Show when={job().status === "failed" && job().error}>
        <div class="export-log-note error">{job().error}</div>
      </Show>
      <Show when={job().status === "completed" && job().warnings.length > 0}>
        <div class="export-log-note warning">{job().warnings.join(" ")}</div>
      </Show>
    </div>
  );
}

function ExportSheet(props: { editor: Editor }) {
  const editor = props.editor;
  const jobs = useExportJobs();
  const [destination, setDestination] = createSignal<ExportDestination>("Video");
  const [timelineFormat, setTimelineFormat] = createSignal<TimelineExportFormat>("fcpxml");
  const [fcpxmlVersion, setFcpxmlVersion] = createSignal<FCPXMLVersion>(fcpxmlVersionDefault);
  const [fcpxmlTarget, setFcpxmlTarget] = createSignal<FCPXMLTarget>(fcpxmlTargetDefault);
  const [codec, setCodec] = createSignal<VideoCodec>("H.264");
  const [resolution, setResolution] = createSignal<ExportResolution>("Match Timeline");
  const [hdrTransfer, setHdrTransfer] = createSignal<HdrTransfer>(hdrTransferDefault);
  const [hdrCodecs, setHdrCodecs] = createSignal<readonly VideoCodec[]>([]);
  // HDR codecs appear only once the runtime has confirmed it can encode them.
  const codecOptions = createMemo(() => videoCodecs.filter((c) => !videoCodecIsHDR(c) || hdrCodecs().includes(c)));
  const [selectedRangeOnly, setSelectedRangeOnly] = createSignal(false);
  const [submissionError, setSubmissionError] = createSignal<string | null>(null);
  const [palmierSummary, setPalmierSummary] = createSignal<PalmierSummary>({ collect: 0, missing: 0, bytes: 0 });
  const [selectedTimelineId, setSelectedTimelineId] = createSignal<string | null>(editor.doc.activeTimelineId);

  const exportTimeline = createMemo(() => exportTimelineFor(editor, selectedTimelineId()));
  const projectID = () => projectQueueID(editor);
  const projectJobs = createMemo(() => jobs().filter((j) => j.projectID === projectID()));
  const logJobs = createMemo(() => [...projectJobs()].reverse());
  const pendingCount = createMemo(() => projectJobs().filter((j) => exportStatusIsPending(j.status)).length);
  const hasActivity = createMemo(() => jobs().some((j) => exportStatusIsPending(j.status)));
  const range = () => editor.ui.selectedTimelineRange;

  const close = (): void => {
    editor.ui.showExportDialog = false;
  };

  onMount(() => {
    void palmierProjectSummary(editor).then(setPalmierSummary, () => undefined);
    void supportedHdrCodecs().then(setHdrCodecs, () => undefined);
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void startExport();
      }
    };
    document.addEventListener("keydown", key, true);
    onCleanup(() => document.removeEventListener("keydown", key, true));
  });

  async function startExport(): Promise<void> {
    setSubmissionError(null);
    if (destination() === "Alcor Project") return startPalmierExport();
    const timeline = exportTimeline();
    const tlFormat = timelineFormatInfo[timelineFormat()];
    const isVideo = destination() === "Video";
    const extension = isVideo ? exportFormatFileExtension(videoCodecExportFormat(codec())) : tlFormat.fileExtension;
    const filterName = isVideo ? videoCodecContainerLabel(codec()) : tlFormat.label;
    const path = await save({
      defaultPath: `${safeFileName(timeline.name)}.${extension}`,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!path) return;
    try {
      if (isVideo) {
        const r = range();
        enqueueVideoExport(editor, {
          timelineId: timeline.id,
          outputPath: path,
          options: {
            codec: codec(),
            resolution: resolution(),
            ...(videoCodecIsHDR(codec()) ? { hdrTransfer: hdrTransfer() } : {}),
            ...(selectedRangeOnly() && r && timeline.id === editor.doc.activeTimelineId ? { range: { startFrame: r.startFrame, endFrame: r.endFrame } } : {}),
          },
        });
      } else {
        await enqueueTimelineExport(editor, {
          timelineId: timeline.id,
          format: timelineFormat(),
          fcpxmlVersion: fcpxmlVersion(),
          fcpxmlTarget: fcpxmlTarget(),
          outputPath: path,
        });
      }
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function startPalmierExport(): Promise<void> {
    const base = editor.projectPath ? projectNameFromPath(editor.projectPath) : Project.defaultProjectName;
    const path = await save({
      defaultPath: `${safeFileName(base)}.${Project.fileExtension}`,
      filters: [{ name: "Alcor Project", extensions: [Project.fileExtension] }],
    });
    if (!path) return;
    try {
      await enqueuePalmierExport(editor, { outputPath: path });
    } catch (e) {
      setSubmissionError(e instanceof Error ? e.message : String(e));
    }
  }

  const outputSize = () => exportResolutionRenderSize(resolution(), { width: exportTimeline().width, height: exportTimeline().height });
  const totalFrames = () => timelineTotalFrames(exportTimeline());
  const estimatedSize = () =>
    formatFileSize(exportEstimatedFileBytes(codec(), resolution(), {
      totalFrames: totalFrames(), fps: exportTimeline().fps, width: exportTimeline().width, height: exportTimeline().height,
    }));

  return (
    <Portal>
      <div class="export-scrim">
        <div class="export-sheet" role="dialog" aria-modal="true" aria-label="Export">
          <div class="export-settings-column">
            <div class="export-header">Export</div>
            <div class="export-settings-panel">
              <div class="export-destination">
                <div class="export-destination-title">Destination</div>
                <div class="export-destination-options" role="radiogroup" aria-label="Destination">
                  <For each={destinations}>
                    {(option) => (
                      <button type="button" role="radio" aria-checked={destination() === option} class="export-destination-button" classList={{ selected: destination() === option }} onClick={() => setDestination(option)}>
                        <RadioIndicator selected={destination() === option} />
                        <span>{option}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="export-divider" />

              <Show when={editor.timelines.length > 1 && destination() !== "Alcor Project"}>
                <SettingRow label="Timeline">
                  <DropdownMenuButton
                    class="export-picker"
                    items={() => editor.timelines.map((t): MenuItem => ({ kind: "item", label: t.name, checked: t.id === exportTimeline().id, onSelect: () => setSelectedTimelineId(t.id) }))}
                  >
                    <span class="export-picker-label">{exportTimeline().name}</span>
                    <ChevronsUpDown size={10} />
                  </DropdownMenuButton>
                </SettingRow>
                <div class="export-divider" />
              </Show>

              <Show when={destination() === "Video"}>
                <SettingRow label="Codec">
                  <Picker value={codec()} options={codecOptions()} label={(c) => c} onChange={setCodec} />
                </SettingRow>
                <div class="export-divider" />
                <Show when={videoCodecIsHDR(codec())}>
                  <SettingRow label="HDR Transfer">
                    <Picker value={hdrTransfer()} options={hdrTransfers} label={hdrTransferDisplayName} onChange={setHdrTransfer} />
                  </SettingRow>
                  <div class="export-divider" />
                </Show>
                <SettingRow label="File Type">
                  <span class="export-setting-value">{videoCodecContainerLabel(codec())}</span>
                </SettingRow>
                <div class="export-divider" />
                <SettingRow label="Resolution">
                  <Picker value={resolution()} options={exportResolutions} label={(r) => r} onChange={setResolution} />
                </SettingRow>
                <div class="export-divider" />
                <SettingRow label="Frame Rate">
                  <span class="export-setting-value">{exportTimeline().fps} fps</span>
                </SettingRow>
                <Show when={range() && exportTimeline().id === editor.doc.activeTimelineId}>
                  <div class="export-divider" />
                  <SettingRow label="Selected Range Only">
                    <Toggle checked={selectedRangeOnly()} onChange={setSelectedRangeOnly} label="Selected Range Only" />
                  </SettingRow>
                </Show>
              </Show>

              <Show when={destination() === "Timeline"}>
                <div class="export-timeline-settings">
                  <div class="export-timeline-title">Timeline Format</div>
                  <For each={timelineFormats}>
                    {(format) => {
                      const info = timelineFormatInfo[format];
                      const selected = () => timelineFormat() === format;
                      return (
                        <div class="export-format-card" classList={{ selected: selected() }}>
                          <div class="export-format-main" onClick={() => setTimelineFormat(format)}>
                            <span class="export-format-check" classList={{ on: selected() }}>
                              {selected() ? <CircleCheck size={14} /> : <Circle size={14} />}
                            </span>
                            <div class="export-format-text">
                              <div class="export-format-name">
                                <strong>{info.label}</strong>
                                <span>{info.extension}</span>
                                <Show when={info.version}>
                                  <span>{info.version}</span>
                                </Show>
                              </div>
                              <div class="export-format-summary">{info.summary}</div>
                              <div class="export-format-compat">Compatibility: {info.compatibility}</div>
                            </div>
                          </div>
                          <Show when={selected() && format === "fcpxml"}>
                            <div class="export-divider" />
                            <div class="export-fcpxml-row">
                              <span class="export-hint">For</span>
                              <Picker value={fcpxmlTarget()} options={fcpxmlTargets} label={fcpxmlTargetDisplayName} onChange={setFcpxmlTarget} small />
                              <span class="export-hint">Version</span>
                              <Picker value={fcpxmlVersion()} options={fcpxmlVersions} label={(v) => v} onChange={setFcpxmlVersion} small />
                              <span class="export-hint export-nowrap">{fcpxmlVersionCompatibilityNote(fcpxmlVersion())}</span>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>

              <Show when={destination() === "Alcor Project"}>
                <div class="export-palmier-settings">
                  <div class="export-palmier-note">Saves a copy of this project with all media bundled inside, so it opens on any machine.</div>
                  <Show when={palmierSummary().missing > 0}>
                    <div class="export-error-text">
                      {palmierSummary().missing === 1
                        ? "1 media file is missing and will be skipped."
                        : `${palmierSummary().missing} media files are missing and will be skipped.`}
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={submissionError()}>
                <div class="export-submission-error">{submissionError()}</div>
              </Show>
            </div>

            <div class="export-bottom-bar">
              <div class="export-summary">
                <span class="export-summary-item">
                  <Clock size={12} />
                  {formatTimecode(totalFrames(), exportTimeline().fps)}
                </span>
                <Show when={destination() === "Video"}>
                  <span class="export-summary-item">
                    <File size={12} />~{estimatedSize()}
                  </span>
                  <span>{outputSize().width}×{outputSize().height}</span>
                  <span>{videoCodecContainerLabel(codec())}</span>
                </Show>
                <Show when={destination() === "Timeline"}>
                  <span>{exportTimeline().width}×{exportTimeline().height}</span>
                  <span>{timelineFormatInfo[timelineFormat()].extension}</span>
                </Show>
                <Show when={destination() === "Alcor Project"}>
                  <span class="export-summary-item">
                    <Package size={12} />~{formatFileSize(palmierSummary().bytes)}
                  </span>
                  <span>.{Project.fileExtension}</span>
                </Show>
              </div>
              <div class="export-bottom-buttons">
                <CapsuleButton size="regular" onClick={close}>Close</CapsuleButton>
                <CapsuleButton size="regular" variant="prominent" onClick={() => void startExport()}>
                  {hasActivity() ? "Add to Queue" : "Export"}
                </CapsuleButton>
              </div>
            </div>
          </div>

          <div class="export-log-column">
            <div class="export-log-header">
              <span class="export-log-title">Export Queue</span>
              <Show when={pendingCount() > 0}>
                <span class="export-log-count">{pendingCount()}</span>
              </Show>
              <span class="export-spacer" />
              <IconButton
                icon={<Trash size={14} />}
                help="Clear Finished"
                disabled={!projectJobs().some((j) => exportStatusIsFinished(j.status))}
                onClick={() => sharedExportQueue.clearFinished(projectID())}
              />
            </div>
            <div class="export-divider" />
            <div class="export-log-list">
              <Show when={projectJobs().length > 0} fallback={<div class="export-log-empty">No exports yet</div>}>
                <For each={logJobs()}>
                  {(job) => <JobRow job={job} onCancel={() => sharedExportQueue.cancel(job.id)} onRemove={() => sharedExportQueue.remove(job.id)} />}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** The export sheet; shown while `editor.ui.showExportDialog` is true. */
export function ExportDialog(props: { editor: Editor }) {
  return (
    <Show when={props.editor.ui.showExportDialog}>
      <ExportSheet editor={props.editor} />
    </Show>
  );
}
