import { Project } from "../model/constants";
import { makeProjectSource, type MediaManifest, type MediaManifestEntry } from "../model/mediaManifest";
import type { ProjectFile } from "../model/projectFile";
import { basename, joinPath, pathKey } from "../project/projectPaths";

// Mirrors project/projectPackage.chatDirectoryName; not imported because that module pulls in the Tauri backend.
const chatDirectoryName = "chat";

export interface PalmierProjectExportMissing {
  id: string;
  name: string;
}

export interface PalmierProjectExportReport {
  /** Entry ids that were `.external` and are now bundled. */
  collected: string[];
  /** Already-internal media files copied across. */
  copiedInternal: number;
  /** Entries whose source file couldn't be found, so they couldn't be included. */
  missing: PalmierProjectExportMissing[];
  /** Total bytes copied into the new bundle. */
  totalBytes: number;
}

export function makePalmierProjectExportReport(): PalmierProjectExportReport {
  return { collected: [], copiedInternal: 0, missing: [], totalBytes: 0 };
}

export function palmierProjectExportReportWarnings(report: PalmierProjectExportReport): string[] {
  if (report.missing.length === 0) return [];
  const files = report.missing.length === 1 ? "media file was" : "media files were";
  return [`${report.missing.length} ${files} missing and could not be included.`];
}

export interface PalmierProjectExportInput {
  projectFile: ProjectFile;
  manifest: MediaManifest;
  /** The package being exported from; undefined for a project that was never saved. */
  sourceProjectPath: string | undefined;
  fileExists: (path: string) => boolean;
  /** Size in bytes of an existing source file. */
  fileSize: (path: string) => number;
}

export interface PalmierProjectExportCopy {
  /** Absolute source path. */
  from: string;
  /** Destination path relative to the new package root. */
  to: string;
}

export interface PalmierProjectExportTextFile {
  /** Destination path relative to the new package root. */
  path: string;
  contents: string;
}

/** What the host must do to materialize the package; the staging/atomic-replace step stays with the caller. */
export interface PalmierProjectExportPlan {
  report: PalmierProjectExportReport;
  /** Media files to copy; a failed copy must abort the export. */
  copies: PalmierProjectExportCopy[];
  /** Thumbnail and chat history: copy when present in the source package, ignore failures. */
  optionalCopies: PalmierProjectExportCopy[];
  textFiles: PalmierProjectExportTextFile[];
  /** The rewritten manifest, as serialized in `textFiles`. */
  manifest: MediaManifest;
}

function pathExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1);
}

function deletingPathExtension(name: string): string {
  const ext = pathExtension(name);
  return ext === "" ? name : name.slice(0, name.length - ext.length - 1);
}

function sourcePath(entry: MediaManifestEntry, projectPath: string | undefined): string | undefined {
  if ("external" in entry.source) return entry.source.external.absolutePath;
  return projectPath === undefined ? undefined : joinPath(projectPath, entry.source.project.relativePath);
}

function filename(entry: MediaManifestEntry, srcPath: string): string {
  if ("project" in entry.source) return basename(srcPath); // preserve existing internal name
  const ext = pathExtension(basename(srcPath));
  const base = `import-${Array.from(entry.id).slice(0, 8).join("")}`;
  return ext === "" ? base : `${base}.${ext}`;
}

/** Appends `-1`, `-2`, … to avoid clobbering an already-planned file of the same name (case-insensitive, like Windows). */
function uniqueName(used: Set<string>, preferredName: string): string {
  if (!used.has(preferredName.toLowerCase())) return preferredName;
  const base = deletingPathExtension(preferredName);
  const ext = pathExtension(preferredName);
  for (let n = 1; ; n++) {
    const name = ext === "" ? `${base}-${n}` : `${base}-${n}.${ext}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * Plans a self-contained `.palmier` package (`PalmierProjectExporter.export`): every resolvable media
 * reference is copied into the new bundle's `media/` directory and rewritten to a project-relative source.
 * `onProgress` receives the fraction of manifest entries processed.
 */
export function palmierProjectExporterPlan(
  input: PalmierProjectExportInput,
  onProgress?: (fraction: number) => void,
): PalmierProjectExportPlan {
  const { projectFile, manifest, sourceProjectPath } = input;
  const report = makePalmierProjectExportReport();
  const copies: PalmierProjectExportCopy[] = [];
  const newEntries: MediaManifestEntry[] = [];
  const relativePathBySource = new Map<string, string>(); // dedup: source path -> media/<file>
  const usedNames = new Set<string>();
  const total = Math.max(1, manifest.entries.length);

  manifest.entries.forEach((entry, index) => {
    const srcPath = sourcePath(entry, sourceProjectPath);
    if (srcPath === undefined || !input.fileExists(srcPath)) {
      report.missing.push({ id: entry.id, name: entry.name });
      newEntries.push(entry); // keep the (dangling) reference as-is
      onProgress?.((index + 1) / total);
      return;
    }

    const key = pathKey(srcPath);
    let relativePath = relativePathBySource.get(key);
    if (relativePath === undefined) {
      const name = uniqueName(usedNames, filename(entry, srcPath));
      usedNames.add(name.toLowerCase());
      relativePath = `${Project.mediaDirectoryName}/${name}`;
      copies.push({ from: srcPath, to: relativePath });
      relativePathBySource.set(key, relativePath);
      report.totalBytes += input.fileSize(srcPath);
      if ("project" in entry.source) report.copiedInternal += 1;
    }

    if ("external" in entry.source) report.collected.push(entry.id);
    newEntries.push({ ...entry, source: makeProjectSource(relativePath) });
    onProgress?.((index + 1) / total);
  });

  const newManifest: MediaManifest = { ...manifest, entries: newEntries };
  const textFiles: PalmierProjectExportTextFile[] = [
    { path: Project.timelineFilename, contents: JSON.stringify(projectFile) },
    { path: Project.manifestFilename, contents: JSON.stringify(newManifest) },
  ];

  const optionalCopies: PalmierProjectExportCopy[] = [];
  if (sourceProjectPath !== undefined) {
    for (const name of [Project.thumbnailFilename, chatDirectoryName]) {
      optionalCopies.push({ from: joinPath(sourceProjectPath, name), to: name });
    }
  }

  return { report, copies, optionalCopies, textFiles, manifest: newManifest };
}
