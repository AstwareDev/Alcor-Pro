import type { Editor } from "../editor/editor";
import { mediaUrl } from "../media/mediaUrl";
import { makeMediaAsset } from "../model/mediaAsset";
import { mediaResolverExpectedPathMapFor, type MediaResolver } from "../model/mediaResolver";
import type { Timeline } from "../model/timeline";
import { fsCopy, fsList, fsMkdir, fsRemove, fsRename, fsStat, fsWriteText } from "../platform/backend";
import { joinPath } from "../project/projectPaths";
import { projectFileSnapshot } from "../project/projectSession";
import { attachWetAudio } from "../denoise/exportWet";
import { exportVideoToFile } from "./exportEngine";
import type { VideoExportOptions } from "./exportOptions";
import {
  exportQueueProjectID, sharedExportQueue, type ExportJobSource, type ExportQueue, type ExportQueueSubmission, type ExportService,
} from "./exportQueue";
import type { ExportJobSpec } from "./exportTypes";
import { fcpxmlExporterRender, type FCPXMLTarget, type FCPXMLVersion } from "./fcpxmlExporter";
import {
  palmierProjectExporterPlan, palmierProjectExportReportWarnings, type PalmierProjectExportPlan,
} from "./palmierProjectExporter";
import { xmlExporterRender } from "./xmlExporter";

/* Glue between the editor document, the export queue and the engines. */

export function projectQueueID(editor: Editor): string {
  return exportQueueProjectID(editor.projectPath);
}

export function exportTimelineFor(editor: Editor, timelineId: string | null | undefined): Timeline {
  return editor.timelines.find((t) => t.id === timelineId) ?? editor.timeline;
}

/** Plain-data snapshot of the document for the export worker. */
export function buildVideoJobSpec(editor: Editor, timelineId: string, options: VideoExportOptions): ExportJobSpec {
  return {
    timelines: structuredClone(editor.timelines),
    mediaAssets: editor.mediaAssets.map((a) => {
      const slim = makeMediaAsset({
        id: a.id, url: mediaUrl(a.url), type: a.type, name: a.name, duration: a.duration,
      });
      slim.hasAudio = a.hasAudio;
      if (a.sourceWidth !== undefined) slim.sourceWidth = a.sourceWidth;
      if (a.sourceHeight !== undefined) slim.sourceHeight = a.sourceHeight;
      if (a.sourceFPS !== undefined) slim.sourceFPS = a.sourceFPS;
      return slim;
    }),
    timelineId,
    missingMediaRefs: [...editor.ui.missingMediaRefs],
    options,
  };
}

export function enqueueVideoExport(
  editor: Editor,
  request: {
    timelineId: string; options: VideoExportOptions; outputPath: string; queue?: ExportQueue;
    source?: ExportJobSource; warnings?: string[];
  },
): ExportQueueSubmission {
  const spec = buildVideoJobSpec(editor, request.timelineId, request.options);
  return (request.queue ?? sharedExportQueue).enqueue({
    outputPath: request.outputPath,
    projectID: projectQueueID(editor),
    source: request.source ?? "manual",
    ...(request.warnings ? { warnings: request.warnings } : {}),
    operation: async (service) => {
      service.setPhase("preparing");
      await attachWetAudio(editor, spec, service.signal);
      const report = await exportVideoToFile(spec, request.outputPath, {
        signal: service.signal,
        onProgress: (p) => {
          if (p.phase === "rendering") service.setPhase("exporting");
          service.setProgress(p.fraction, p.etaSeconds);
        },
      });
      service.warnings = report.warnings;
      service.commit();
    },
  });
}

// MARK: - Media facts (filesystem answers are async; the pure exporters take sync lookups)

interface FileFacts {
  sizes: Map<string, number>;
}

async function gatherFileFacts(editor: Editor): Promise<FileFacts> {
  const expected = mediaResolverExpectedPathMapFor(editor.doc.mediaManifest.entries, editor.projectPath ?? undefined);
  const sizes = new Map<string, number>();
  await Promise.all([...expected.values()].map(async (path) => {
    if (path === undefined) return;
    const stat = await fsStat(path).catch(() => null);
    if (stat && !stat.isDir) sizes.set(path, stat.size);
  }));
  return { sizes };
}


export type TimelineExportFormat = "xmeml" | "fcpxml";

export async function enqueueTimelineExport(
  editor: Editor,
  request: {
    timelineId: string;
    format: TimelineExportFormat;
    fcpxmlVersion: FCPXMLVersion;
    fcpxmlTarget: FCPXMLTarget;
    outputPath: string;
    queue?: ExportQueue;
    source?: ExportJobSource;
    warnings?: string[];
  },
): Promise<ExportQueueSubmission> {
  const timeline = exportTimelineFor(editor, request.timelineId);
  const timelines = structuredClone(editor.timelines);
  const facts = await gatherFileFacts(editor);
  const manifest = structuredClone(editor.doc.mediaManifest);
  const projectPath = editor.projectPath ?? undefined;
  const resolver: MediaResolver = {
    manifest: () => manifest,
    projectPath: () => projectPath,
    fileExists: (path) => facts.sizes.has(path),
  };
  const resolveTimeline = (id: string): Timeline | undefined => timelines.find((t) => t.id === id);
  return (request.queue ?? sharedExportQueue).enqueue({
    outputPath: request.outputPath,
    projectID: projectQueueID(editor),
    source: request.source ?? "manual",
    ...(request.warnings ? { warnings: request.warnings } : {}),
    operation: async (service) => {
      service.setPhase("exporting");
      const exportTimeline = timelines.find((t) => t.id === timeline.id) ?? timeline;
      const text = request.format === "xmeml"
        ? xmlExporterRender({ timeline: exportTimeline, resolver, resolveTimeline })
        : fcpxmlExporterRender({
          timeline: exportTimeline, resolver, resolveTimeline, version: request.fcpxmlVersion, target: request.fcpxmlTarget,
        });
      if (service.signal.aborted) return;
      await fsWriteText(request.outputPath, text);
      service.setProgress(1);
      service.commit();
    },
  });
}

// MARK: - Palmier project

export interface PalmierSummary {
  collect: number;
  missing: number;
  bytes: number;
}

/** `ExportView.computePalmierSummary`: how many external files get bundled, how many are missing, total size. */
export async function palmierProjectSummary(editor: Editor): Promise<PalmierSummary> {
  const facts = await gatherFileFacts(editor);
  const expected = mediaResolverExpectedPathMapFor(editor.doc.mediaManifest.entries, editor.projectPath ?? undefined);
  let collect = 0, missing = 0, bytes = 0;
  for (const entry of editor.doc.mediaManifest.entries) {
    const path = expected.get(entry.id);
    const size = path === undefined ? undefined : facts.sizes.get(path);
    if (size === undefined) {
      missing += 1;
      continue;
    }
    if ("external" in entry.source) collect += 1;
    bytes += size;
  }
  return { collect, missing, bytes };
}

async function copyTree(from: string, to: string): Promise<void> {
  const stat = await fsStat(from);
  if (!stat) return;
  if (!stat.isDir) {
    await fsCopy(from, to);
    return;
  }
  await fsMkdir(to);
  for (const child of await fsList(from)) await copyTree(child.path, joinPath(to, child.name));
}

async function writePalmierPackage(plan: PalmierProjectExportPlan, outputPath: string, service: ExportService): Promise<void> {
  const staging = `${outputPath}.partial`;
  await fsRemove(staging);
  await fsMkdir(staging);
  try {
    const total = plan.copies.length + plan.textFiles.length + 1;
    let done = 0;
    const step = (): void => service.setProgress(Math.min(0.99, ++done / total));
    for (const copy of plan.copies) {
      if (service.signal.aborted) throw new DOMException("cancelled", "AbortError");
      await fsCopy(copy.from, joinPath(staging, copy.to));
      step();
    }
    for (const file of plan.textFiles) {
      await fsWriteText(joinPath(staging, file.path), file.contents);
      step();
    }
    for (const copy of plan.optionalCopies) await copyTree(copy.from, joinPath(staging, copy.to)).catch(() => undefined);
    if (service.signal.aborted) throw new DOMException("cancelled", "AbortError");
    await fsRemove(outputPath);
    await fsRename(staging, outputPath);
  } catch (e) {
    await fsRemove(staging).catch(() => undefined);
    throw e;
  }
}

export async function enqueuePalmierExport(
  editor: Editor,
  request: { outputPath: string; queue?: ExportQueue; source?: ExportJobSource },
): Promise<ExportQueueSubmission> {
  const facts = await gatherFileFacts(editor);
  const projectFile = structuredClone(projectFileSnapshot(editor));
  const manifest = structuredClone(editor.doc.mediaManifest);
  const sourceProjectPath = editor.projectPath ?? undefined;
  return (request.queue ?? sharedExportQueue).enqueue({
    outputPath: request.outputPath,
    projectID: projectQueueID(editor),
    source: request.source ?? "manual",
    operation: async (service) => {
      service.setPhase("exporting");
      const plan = palmierProjectExporterPlan({
        projectFile,
        manifest,
        sourceProjectPath,
        fileExists: (path) => facts.sizes.has(path),
        fileSize: (path) => facts.sizes.get(path) ?? 0,
      });
      await writePalmierPackage(plan, request.outputPath, service);
      service.warnings = palmierProjectExportReportWarnings(plan.report);
      service.palmierReport = plan.report;
      service.setProgress(1);
      service.commit();
    },
  });
}

