import type { Editor } from "../../editor/editor";
import { enqueuePalmierExport, enqueueTimelineExport, enqueueVideoExport, projectQueueID } from "../../export/exportRunner";
import {
  exportFormatDisplayName, exportFormatFileExtension, videoCodecExportFormat, type ExportFormat, type ExportResolution,
  type VideoCodec,
} from "../../export/exportOptions";
import { sharedExportQueue, type ExportJob, type ExportQueue, type ExportQueueSubmission } from "../../export/exportQueue";
import { fcpxmlTargetDefault, fcpxmlTargets, fcpxmlVersionDefault, type FCPXMLTarget } from "../../export/fcpxmlExporter";
import { Project } from "../../model/constants";
import { timelineTotalFrames, type Timeline } from "../../model/timeline";
import { appPaths, fsStat, type FsEntry } from "../../platform/backend";
import { basename, dirname, nativePath, normalizePath, stem } from "../../project/projectPaths";
import { swiftRound } from "../../util/math";
import { jsonString } from "./jsonFormat";
import { ToolError, decodeToolArgs } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Export.swift.

/** Seams to the shared queue and the filesystem; tests replace fields. */
export const exportToolDeps: {
  queue: ExportQueue;
  stat: (path: string) => Promise<FsEntry | null>;
  downloadsDir: () => Promise<string>;
} = {
  queue: sharedExportQueue,
  stat: fsStat,
  downloadsDir: async () => (await appPaths()).downloads,
};

type ExportProjectMode = "video" | "xml" | "fcpxml" | "palmier";

interface ExportProjectArgs {
  mode?: string;
  codec?: string;
  resolution?: string;
  outputPath?: string;
  overwrite?: boolean;
  fcpxmlTarget?: string;
  timelineId?: string;
}

const normalizedExportOption = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, "").replace(/-/g, "").replace(/_/g, "");

function parseMode(raw: string | undefined): ExportProjectMode {
  if (raw === undefined) return "video";
  const mode = normalizedExportOption(raw);
  if (mode === "video" || mode === "xml" || mode === "fcpxml" || mode === "palmier") return mode;
  throw new ToolError("export_project: mode must be video, xml, fcpxml, or palmier");
}

function parseVideoCodec(raw: string | undefined): VideoCodec {
  if (raw === undefined) return "H.264";
  switch (normalizedExportOption(raw)) {
    case "h.264":
    case "h264": return "H.264";
    case "h.265":
    case "h265":
    case "hevc": return "H.265";
    case "prores":
      throw new ToolError("export_project: ProRes is not available in the Windows version. Use H.264 or H.265.");
    default:
      throw new ToolError("export_project: codec must be H.264, H.265, or ProRes");
  }
}

function parseResolution(raw: string | undefined): ExportResolution {
  if (raw === undefined) return "Match Timeline";
  switch (normalizedExportOption(raw)) {
    case "720p": return "720p";
    case "1080p": return "1080p";
    case "2k": return "2K";
    case "4k": return "4K";
    case "matchtimeline": return "Match Timeline";
    default:
      throw new ToolError("export_project: resolution must be 720p, 1080p, 2K, 4K, or Match Timeline");
  }
}

function modeFileExtension(mode: ExportProjectMode, format: ExportFormat | undefined): string {
  switch (mode) {
    case "video": return exportFormatFileExtension(format ?? "h264");
    case "xml": return "xml";
    case "fcpxml": return "fcpxml";
    case "palmier": return Project.fileExtension;
  }
}

function modeLabel(mode: ExportProjectMode, format: ExportFormat | undefined): string {
  switch (mode) {
    case "video": return format ? exportFormatDisplayName(format) : "Video";
    case "xml": return "XML";
    case "fcpxml": return "FCPXML";
    case "palmier": return "Alcor Project";
  }
}

/** Swift `pathExtension`: text after the last dot of the last component ("" for dotfiles). */
function pathExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

const isAbsolutePath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");

async function expandTilde(path: string): Promise<string> {
  if (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\")) return path;
  const home = dirname(await exportToolDeps.downloadsDir());
  return home + path.slice(1);
}

async function directExportPath(path: string, mode: ExportProjectMode, format: ExportFormat | undefined): Promise<string> {
  const expanded = await expandTilde(path);
  if (!isAbsolutePath(expanded)) throw new ToolError("export_project: outputPath must be absolute");

  const expectedExtension = modeFileExtension(mode, format);
  const rawExtension = pathExtension(expanded).toLowerCase();
  let url = normalizePath(expanded);
  if (rawExtension === "") url = `${url}.${expectedExtension}`;
  else if (rawExtension !== expectedExtension) {
    throw new ToolError(`export_project: ${modeLabel(mode, format)} exports must use .${expectedExtension}`);
  }

  const existing = await exportToolDeps.stat(expanded);
  if (existing?.isDir === true && !(mode === "palmier" && rawExtension === expectedExtension)) {
    throw new ToolError("export_project: outputPath must include a filename");
  }

  const parent = await exportToolDeps.stat(dirname(url));
  if (!parent?.isDir) throw new ToolError("export_project: output directory does not exist");
  return url;
}

async function uniqueExportPath(path: string): Promise<string> {
  const taken = async (p: string): Promise<boolean> =>
    (await exportToolDeps.stat(p)) !== null || exportToolDeps.queue.isDestinationReserved(p);
  if (!(await taken(path))) return path;
  const directory = dirname(path);
  const ext = pathExtension(path);
  const base = stem(path);
  for (let index = 2; ; index++) {
    const candidate = `${directory}/${ext === "" ? `${base} ${index}` : `${base} ${index}.${ext}`}`;
    if (!(await taken(candidate))) return candidate;
  }
}

async function downloadsExportPath(mode: ExportProjectMode, format: ExportFormat | undefined, editor: Editor): Promise<string> {
  const downloads = await exportToolDeps.downloadsDir();
  if (downloads === "") throw new ToolError("export_project: Downloads folder not found");
  const base = editor.projectPath !== null ? stem(editor.projectPath) : Project.defaultProjectName;
  return uniqueExportPath(`${normalizePath(downloads)}/${base}.${modeFileExtension(mode, format)}`);
}

async function exportDestination(
  outputPath: string | undefined, mode: ExportProjectMode, format: ExportFormat | undefined, editor: Editor, overwrite: boolean,
): Promise<string> {
  if (outputPath === undefined) return downloadsExportPath(mode, format, editor);
  const path = await directExportPath(outputPath, mode, format);
  if (!overwrite && (await exportToolDeps.stat(path)) !== null) throw new ToolError("export_project: output file already exists");
  return path;
}

function nestExportWarnings(editor: Editor, timeline: Timeline): string[] {
  const dropped = timeline.tracks.flatMap((t) => t.clips).filter((c) => {
    if (c.sourceClipType !== "sequence" || c.mediaType === "audio") return false;
    const nested = editor.timelines.find((t) => t.id === c.mediaRef);
    return (nested ? timelineTotalFrames(nested) : 0) === 0;
  }).length;
  if (dropped === 0) return [];
  const clips = dropped === 1 ? "clip was" : "clips were";
  return [`${dropped} nested timeline ${clips} skipped because the source timeline is empty or missing.`];
}

function submissionPayload(submission: ExportQueueSubmission, mode: ExportProjectMode, outputPath: string): Record<string, unknown> {
  return {
    status: submission.started ? "started" : "queued",
    jobId: submission.jobID,
    queuePosition: submission.queuePosition,
    mode,
    path: nativePath(outputPath),
    note: "The export is available in the Export dialog.",
  };
}

export async function exportProject(context: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const { editor } = context;
  const input = decodeToolArgs<ExportProjectArgs>(args, "export_project", {
    mode: { spec: "string" }, codec: { spec: "string" }, resolution: { spec: "string" }, outputPath: { spec: "string" },
    overwrite: { spec: "bool" }, fcpxmlTarget: { spec: "string" }, timelineId: { spec: "string" },
  });
  const mode = parseMode(input.mode);
  const overwrite = input.overwrite ?? true;

  if (mode !== "video") {
    if (input.codec !== undefined) throw new ToolError("export_project: codec only applies to video mode");
    if (input.resolution !== undefined) throw new ToolError("export_project: resolution only applies to video mode");
  }

  const codec = mode === "video" ? parseVideoCodec(input.codec) : undefined;
  const format = codec === undefined ? undefined : videoCodecExportFormat(codec);
  const resolution = mode === "video" ? parseResolution(input.resolution) : "Match Timeline";

  let timeline: Timeline;
  if (input.timelineId !== undefined) {
    if (mode === "palmier") {
      throw new ToolError("export_project: timelineId doesn't apply to palmier mode — the package carries every timeline");
    }
    const found = editor.timelines.find((t) => t.id === input.timelineId);
    if (!found) throw new ToolError(`export_project: no timeline with id '${input.timelineId}'. get_timeline lists the project's timelines.`);
    timeline = found;
  } else {
    timeline = editor.timeline;
  }

  const outputPath = await exportDestination(input.outputPath, mode, format, editor, overwrite);
  const queue = exportToolDeps.queue;

  if (mode === "palmier") {
    const submission = await enqueuePalmierExport(editor, { outputPath, queue, source: "agent" });
    return ok(jsonString(submissionPayload(submission, mode, outputPath)));
  }

  let exportFormat: ExportFormat;
  let submission: ExportQueueSubmission;
  let warnings: string[] = [];
  if (mode === "video") {
    if (format === undefined || codec === undefined) throw new ToolError("export_project: codec is required for video mode");
    if (timelineTotalFrames(timeline) <= 0) throw new ToolError("export_project: timeline is empty");
    exportFormat = format;
    submission = enqueueVideoExport(editor, {
      timelineId: timeline.id, options: { codec, resolution }, outputPath, queue, source: "agent",
    });
  } else {
    let target: FCPXMLTarget = fcpxmlTargetDefault;
    if (mode === "fcpxml" && input.fcpxmlTarget !== undefined) {
      if (!(fcpxmlTargets as readonly string[]).includes(input.fcpxmlTarget)) {
        throw new ToolError("export_project: fcpxmlTarget must be 'resolve' or 'fcp'");
      }
      target = input.fcpxmlTarget as FCPXMLTarget;
    }
    exportFormat = mode;
    warnings = nestExportWarnings(editor, timeline);
    submission = await enqueueTimelineExport(editor, {
      timelineId: timeline.id, format: mode === "xml" ? "xmeml" : "fcpxml", fcpxmlVersion: fcpxmlVersionDefault,
      fcpxmlTarget: target, outputPath, queue, source: "agent", warnings,
    });
  }

  const frames = timelineTotalFrames(timeline);
  const payload: Record<string, unknown> = {
    ...submissionPayload(submission, mode, outputPath),
    format: exportFormatDisplayName(exportFormat),
    timeline: timeline.name,
    durationFrames: frames,
    durationSeconds: frames / Math.max(1, timeline.fps),
    fps: timeline.fps,
  };
  if (warnings.length > 0) payload.warnings = warnings;
  return ok(jsonString(payload));
}

// MARK: - manage_exports

const uuidPattern = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export function manageExports(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  const input = decodeToolArgs<{ action: string; jobId?: string }>(args, "manage_exports", {
    action: { spec: "string", required: true }, jobId: { spec: "string" },
  });
  const queue = exportToolDeps.queue;
  const projectJobs = queue.jobsFor(projectQueueID(editor));

  switch (input.action) {
    case "list": {
      if (input.jobId !== undefined) throw new ToolError("manage_exports: jobId only applies to cancel");
      const waitingIDs = queue.jobs.filter((j) => j.status === "queued").map((j) => j.id);
      const exports = [...projectJobs].reverse().map((job: ExportJob) => {
        const row: Record<string, unknown> = {
          jobId: job.id,
          filename: job.filename,
          path: nativePath(job.outputPath),
          status: job.status,
          progress: swiftRound(job.progress * 100),
        };
        const index = waitingIDs.indexOf(job.id);
        if (index >= 0) row.queuePosition = index + 1;
        if (job.error !== undefined) row.error = job.error;
        if (job.warnings.length > 0) row.warnings = job.warnings;
        if (job.palmierReport) {
          row.result = {
            collectedMediaRefs: job.palmierReport.collected,
            copiedInternalMediaCount: job.palmierReport.copiedInternal,
            missingMedia: job.palmierReport.missing.map((m) => ({ id: m.id, name: m.name })),
            totalBytes: job.palmierReport.totalBytes,
          };
        }
        return row;
      });
      return ok(jsonString({ exports }));
    }
    case "cancel": {
      if (input.jobId === undefined || !uuidPattern.test(input.jobId)) {
        throw new ToolError("manage_exports: cancel requires a valid jobId");
      }
      const id = input.jobId.toUpperCase();
      const job = projectJobs.find((j) => j.id.toUpperCase() === id);
      if (!job) throw new ToolError("manage_exports: export not found in the current project");

      let responseStatus: string;
      let cancellationRequested: boolean;
      switch (job.status) {
        case "queued":
          queue.cancel(job.id);
          responseStatus = "removed";
          cancellationRequested = true;
          break;
        case "preparing":
        case "rendering":
          cancellationRequested = queue.cancel(job.id);
          responseStatus = cancellationRequested ? "canceling" : job.status;
          break;
        case "canceling":
          responseStatus = "canceling";
          cancellationRequested = true;
          break;
        default:
          responseStatus = job.status;
          cancellationRequested = false;
      }
      return ok(jsonString({ jobId: job.id, filename: job.filename, status: responseStatus, cancellationRequested }));
    }
    default:
      throw new ToolError("manage_exports: action must be list or cancel");
  }
}
