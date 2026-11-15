import { decodeMediaManifest, decodeProjectFileText, Project, type MediaManifest, type ProjectFile } from "../model";
import { backendFileSystem, type FileSystem } from "./fileSystem";
import { projectErrors } from "./projectError";
import { joinPath, samePath } from "./projectPaths";

/** Directory of agent chat sessions (`ChatSessionStore.dirName`). */
export const chatDirectoryName = "chat";

export interface ProjectPackageContents {
  projectFile: ProjectFile;
  manifest: MediaManifest | null;
  /** media.json existed but failed to decode; saves must preserve it instead of clobbering. */
  manifestUnreadable: boolean;
}

export interface ChatSessionFile {
  name: string;
  data: string;
}

/** Encoded, ready to write. `null` manifest/thumbnail mean "keep what the source package has". */
export interface ProjectPackageSnapshot {
  timeline: string;
  manifest: string | null;
  thumbnail: Uint8Array | null;
  /** Rewrites the chat directory. `undefined` leaves existing chat files alone (no chat model to snapshot yet). */
  chatSessionFiles?: ChatSessionFile[];
}

const knownEntries = new Set(
  [Project.timelineFilename, Project.manifestFilename, Project.thumbnailFilename, Project.mediaDirectoryName, chatDirectoryName]
    .map((n) => n.toLowerCase()),
);

/** `VideoProject.readProjectPackage(at:)` */
export async function readProjectPackage(
  packagePath: string,
  fs: FileSystem = backendFileSystem,
): Promise<ProjectPackageContents> {
  let timelineText: string;
  try {
    timelineText = await fs.readText(joinPath(packagePath, Project.timelineFilename));
  } catch (error) {
    throw projectErrors.missingTimeline(packagePath, error);
  }
  const projectFile = decodeProjectFileText(timelineText);

  const manifestPath = joinPath(packagePath, Project.manifestFilename);
  if (!(await fs.exists(manifestPath))) return { projectFile, manifest: null, manifestUnreadable: false };
  const manifestText = await fs.readText(manifestPath);
  try {
    return { projectFile, manifest: decodeMediaManifest(JSON.parse(manifestText)), manifestUnreadable: false };
  } catch (error) {
    // A bad manifest must not lose the project; degrade to "media offline" and keep the file for recovery.
    console.error("read manifest decode failed; opening with empty manifest", error);
    return { projectFile, manifest: null, manifestUnreadable: true };
  }
}

/** `VideoProject.manifestSnapshot`: never overwrite a recoverable original with an empty manifest. */
export function manifestSnapshot(manifest: MediaManifest, loadFailed: boolean): MediaManifest | null {
  if (loadFailed && manifest.entries.length === 0 && manifest.folders.length === 0) return null;
  return manifest;
}

/** `VideoProject.writeProjectPackage`. `sourcePath` is the package being saved from (differs on Save As). */
export async function writeProjectPackage(
  snapshot: ProjectPackageSnapshot,
  packagePath: string,
  sourcePath?: string,
  fs: FileSystem = backendFileSystem,
): Promise<void> {
  const source = sourcePath !== undefined && !samePath(sourcePath, packagePath) ? sourcePath : undefined;

  await createPackageDirectory(packagePath, fs);
  await fs.writeText(joinPath(packagePath, Project.timelineFilename), snapshot.timeline);
  if (snapshot.manifest !== null) {
    await fs.writeText(joinPath(packagePath, Project.manifestFilename), snapshot.manifest);
  } else if (source !== undefined) {
    await copyPreservedFile(Project.manifestFilename, source, packagePath, fs);
  }
  if (snapshot.thumbnail !== null) {
    await fs.writeBytes(joinPath(packagePath, Project.thumbnailFilename), snapshot.thumbnail);
  } else if (source !== undefined) {
    await copyPreservedFile(Project.thumbnailFilename, source, packagePath, fs);
  }
  if (snapshot.chatSessionFiles !== undefined) {
    await writeChatDirectory(snapshot.chatSessionFiles, packagePath, fs);
  } else if (source !== undefined) {
    await copyDirectoryIfPresent(chatDirectoryName, source, packagePath, fs);
  }
  if (source !== undefined) {
    await copyMediaDirectory(source, packagePath, fs);
    await copyUnknownEntries(source, packagePath, fs);
  }
  await fs.mkdir(joinPath(packagePath, Project.mediaDirectoryName));
}

async function createPackageDirectory(path: string, fs: FileSystem): Promise<void> {
  if (await fs.exists(path)) {
    if (await fs.isDirectory(path)) return;
    await fs.remove(path);
  }
  await fs.mkdir(path);
}

async function writeChatDirectory(files: ChatSessionFile[], packagePath: string, fs: FileSystem): Promise<void> {
  const chat = joinPath(packagePath, chatDirectoryName);
  if (await fs.exists(chat)) await fs.remove(chat);
  await fs.mkdir(chat);
  for (const file of files) await fs.writeText(joinPath(chat, file.name), file.data);
}

async function copyPreservedFile(name: string, source: string, packagePath: string, fs: FileSystem): Promise<void> {
  const from = joinPath(source, name);
  if (!(await fs.exists(from))) return;
  await fs.copy(from, joinPath(packagePath, name));
}

async function copyTree(from: string, to: string, fs: FileSystem): Promise<void> {
  await fs.mkdir(to);
  for (const entry of await fs.list(from)) {
    const target = joinPath(to, entry.name);
    if (entry.isDir) await copyTree(entry.path, target, fs);
    else await fs.copy(entry.path, target);
  }
}

/** Copies into a sibling first so a failed copy never leaves a half-replaced destination. */
async function replaceDirectory(from: string, to: string, fs: FileSystem): Promise<void> {
  const staged = `${to}.copying-${crypto.randomUUID()}`;
  try {
    await copyTree(from, staged, fs);
    await fs.remove(to);
    await fs.rename(staged, to);
  } catch (error) {
    await fs.remove(staged).catch(() => {});
    throw error;
  }
}

async function copyMediaDirectory(source: string, packagePath: string, fs: FileSystem): Promise<void> {
  const from = joinPath(source, Project.mediaDirectoryName);
  const to = joinPath(packagePath, Project.mediaDirectoryName);
  if (!(await fs.exists(from))) {
    await fs.remove(to);
    return;
  }
  await replaceDirectory(from, to, fs);
}

async function copyDirectoryIfPresent(name: string, source: string, packagePath: string, fs: FileSystem): Promise<void> {
  const from = joinPath(source, name);
  if (await fs.exists(from)) await replaceDirectory(from, joinPath(packagePath, name), fs);
}

/** Files other tools left in the package (not part of the Swift format) travel with Save As. */
async function copyUnknownEntries(source: string, packagePath: string, fs: FileSystem): Promise<void> {
  for (const entry of await fs.list(source)) {
    if (knownEntries.has(entry.name.toLowerCase())) continue;
    const target = joinPath(packagePath, entry.name);
    if (entry.isDir) await replaceDirectory(entry.path, target, fs);
    else await fs.copy(entry.path, target);
  }
}
