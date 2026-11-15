import { createEffect, createRoot, createSignal, on } from "solid-js";
import { Editor, makeEditorDocument, type EditorDocument } from "../editor/editor";
import {
  mediaAssetCanResumeGeneration, mediaAssetFromManifestEntry, mediaAssetIsRecoveringGeneration,
  mediaAssetToManifestEntry, mediaResolverExpectedPathMapFor, makeMediaManifest, makeProjectFile, Project,
  timelineTotalFrames, type MediaAsset, type MediaManifest, type ProjectFile, type TimelineViewState,
} from "../model";
import { appPaths } from "../platform/backend";
import { backendFileSystem, type FileSystem } from "./fileSystem";
import { projectErrors } from "./projectError";
import {
  manifestSnapshot, readProjectPackage, writeProjectPackage, type ChatSessionFile, type ProjectPackageContents,
  type ProjectPackageSnapshot,
} from "./projectPackage";
import { joinPath, normalizePath, pathKey, samePath } from "./projectPaths";
import {
  noteThumbnailSaved, renderProjectThumbnail, ThumbnailScheduler,
} from "./projectThumbnail";
import { sharedProjectRegistry, type ProjectRegistry } from "./projectRegistry";

/** Quiet period after the last edit before an autosave. NSDocument picks its own delay; this is ours. */
export const autosaveDebounceMs = 2000;

export interface ProjectDeps {
  fs: FileSystem;
  registry?: ProjectRegistry;
  /** Where `newProject` creates packages. Defaults to the registry's directory. */
  projectsDirectory?: string;
  autosaveDebounceMs?: number;
  /** Renders the project card thumbnail (JPEG); defaults to the offline compositor. Null skips the capture. */
  captureThumbnail?: (editor: Editor) => Promise<Uint8Array | null>;
}

async function resolveDeps(deps?: ProjectDeps): Promise<ProjectDeps> {
  if (deps) return deps;
  const registry = await sharedProjectRegistry();
  return { fs: backendFileSystem, registry, projectsDirectory: registry.projectsDirectory };
}

// MARK: - Snapshot

export interface SaveSnapshotOptions {
  /** media.json failed to decode on open; an empty manifest must not replace it. */
  manifestLoadFailed?: boolean;
  thumbnail?: Uint8Array | null;
  chatSessionFiles?: ChatSessionFile[];
}

/** `projectFileSnapshot()`: view states are pruned to timelines that still exist; the active one is stashed live. */
export function projectFileSnapshot(editor: Editor): ProjectFile {
  const doc = editor.store.committed;
  const ids = new Set(doc.timelines.map((t) => t.id));
  const viewStates: Record<string, TimelineViewState> = {
    ...editor.liveViewStates,
    [doc.activeTimelineId]: {
      playheadFrame: editor.ui.currentFrame,
      zoomScale: editor.ui.zoomScale,
      scrollOffsetX: editor.ui.timelineScrollOffsetX,
    },
  };
  for (const id of Object.keys(viewStates)) if (!ids.has(id)) delete viewStates[id];

  const referenced = new Set<string>();
  for (const t of doc.timelines) {
    for (const track of t.tracks) for (const clip of track.clips) if (clip.multicamGroupId) referenced.add(clip.multicamGroupId);
  }
  const groups = doc.multicamGroups.filter((g) => referenced.has(g.id));

  return makeProjectFile({
    timelines: doc.timelines,
    activeTimelineId: doc.activeTimelineId,
    openTimelineIds: doc.openTimelineIds,
    viewStates,
    speakers: doc.speakerRegistry.length === 0 ? undefined : doc.speakerRegistry,
    multicamGroups: groups.length === 0 ? undefined : groups,
  });
}

/** `captureSaveSnapshot()`: pure, synchronous capture of everything a save writes. */
export function snapshotForSave(editor: Editor, options: SaveSnapshotOptions = {}): ProjectPackageSnapshot {
  const manifest: MediaManifest | null = manifestSnapshot(
    editor.store.committed.mediaManifest,
    options.manifestLoadFailed ?? false,
  );
  const snapshot: ProjectPackageSnapshot = {
    timeline: JSON.stringify(projectFileSnapshot(editor)),
    manifest: manifest === null ? null : JSON.stringify(manifest),
    thumbnail: options.thumbnail ?? null,
  };
  if (options.chatSessionFiles !== undefined) snapshot.chatSessionFiles = options.chatSessionFiles;
  return snapshot;
}

// MARK: - Open

/** `applyProjectFile` + the sync half of `restoreAssetsFromManifest`. */
export function editorFromPackage(packagePath: string, contents: ProjectPackageContents): Editor {
  const { projectFile: file, manifest } = contents;
  const projectPath = normalizePath(packagePath);
  const ids = new Set(file.timelines.map((t) => t.id));
  const activeTimelineId =
    file.activeTimelineId !== undefined && ids.has(file.activeTimelineId) ? file.activeTimelineId : file.timelines[0].id;
  const openTimelineIds = (file.openTimelineIds ?? []).filter((id) => ids.has(id));
  if (!openTimelineIds.includes(activeTimelineId)) openTimelineIds.push(activeTimelineId);

  const mediaManifest = manifest ?? makeMediaManifest();
  const expected = mediaResolverExpectedPathMapFor(mediaManifest.entries, projectPath);
  const mediaAssets: MediaAsset[] = [];
  const missing = new Set<string>();
  for (const entry of mediaManifest.entries) {
    const path = expected.get(entry.id);
    if (path === undefined) {
      console.warn(`restore: could not resolve path for entry id=${entry.id} name=${entry.name}`);
      missing.add(entry.id);
      continue;
    }
    mediaAssets.push(mediaAssetFromManifestEntry(entry, path));
  }

  const doc: EditorDocument = {
    timelines: file.timelines,
    activeTimelineId,
    openTimelineIds,
    mediaManifest,
    mediaAssets,
    speakerRegistry: file.speakers ?? [],
    multicamGroups: file.multicamGroups ?? [],
  };
  const editor = new Editor(doc);
  editor.projectPath = projectPath;
  Object.assign(editor.liveViewStates, file.viewStates ?? {});
  editor.ui.missingMediaRefs = missing;

  const view = editor.liveViewStates[activeTimelineId];
  if (view) {
    const active = file.timelines.find((t) => t.id === activeTimelineId);
    editor.ui.zoomScale = view.zoomScale;
    editor.ui.currentFrame = Math.min(Math.max(0, view.playheadFrame), Math.max(0, active ? timelineTotalFrames(active) : 0));
    editor.ui.timelineScrollOffsetX = view.scrollOffsetX;
  }
  return editor;
}

/** `finishRestoredMediaScan` minus metadata loading: settle missing / interrupted media after checking the disk. */
export async function scanRestoredMedia(editor: Editor, fs: FileSystem): Promise<void> {
  const candidates = editor.mediaAssets.map((a) => ({ id: a.id, path: a.url }));
  const existing = new Set<string>();
  await Promise.all(candidates.map(async (c) => { if (await fs.exists(c.path)) existing.add(c.id); }));

  const missing = new Set(editor.ui.missingMediaRefs);
  editor.withoutRegistration(() => {
    const byId = new Map(editor.doc.mediaAssets.map((a) => [a.id, a]));
    const updates: MediaAsset[] = [];
    for (const c of candidates) {
      const asset = byId.get(c.id);
      if (!asset) continue;
      if (!existing.has(c.id)) {
        if (asset.importInput !== undefined) {
          if (asset.generationStatus.kind !== "failed") {
            asset.generationStatus = { kind: "failed", message: "Import interrupted" };
            updates.push(asset);
          }
          continue;
        }
        if (mediaAssetIsRecoveringGeneration(asset)) {
          asset.generationStatus = { kind: "generating" };
          updates.push(asset);
          continue;
        }
        console.warn(`restore: media file missing id=${c.id} path=${c.path}`);
        missing.add(c.id);
        continue;
      }
      if (asset.importInput !== undefined) {
        if (asset.generationStatus.kind === "failed") continue;
        asset.importInput = undefined;
        asset.generationStatus = { kind: "none" };
        updates.push(asset);
      }
      if (asset.generationStatus.kind !== "none" && !mediaAssetCanResumeGeneration(asset)) {
        asset.generationStatus = { kind: "none" };
        updates.push(asset);
      }
    }
    if (updates.length === 0) return;
    const entries = editor.doc.mediaManifest.entries;
    const index = new Map(entries.map((e, i) => [e.id, i]));
    for (const asset of updates) {
      const entry = mediaAssetToManifestEntry(asset, editor.projectPath ?? undefined);
      const i = index.get(asset.id);
      if (i === undefined) {
        index.set(asset.id, entries.length);
        entries.push(entry);
      } else entries[i] = entry;
    }
  });
  editor.ui.missingMediaRefs = missing;
}

// MARK: - Session

const sessions = new WeakMap<Editor, ProjectSession>();
const openSessions = new Map<string, ProjectSession>();

/** Paths of projects currently open in an editor (deletion must be refused for these). */
export function openProjectPaths(): string[] {
  return [...openSessions.values()].map((s) => s.path);
}

export function isProjectOpen(path: string): boolean {
  return openSessions.has(pathKey(path));
}

/** The editor's session, or undefined for editors that are not backed by a project package (dev pages). */
export function projectSessionIfOpen(editor: Editor): ProjectSession | undefined {
  return sessions.get(editor);
}

export function projectSession(editor: Editor): ProjectSession {
  const session = sessions.get(editor);
  if (!session) throw new Error("editor has no project session");
  return session;
}

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

/**
 * Owns persistence for one open editor: serialised saves, dirty tracking and autosave.
 * Edits autosave after a quiet period; `requestCheckpoint` (Swift `onProjectCheckpointRequired`) saves on the next tick.
 */
export class ProjectSession {
  readonly editor: Editor;
  private readonly deps: ProjectDeps;
  private readonly debounceMs: number;
  private readonly disposeRoot: () => void;
  private readonly savedRevision = createSignal(-1);
  private readonly savingSignal = createSignal(false);
  private readonly errorSignal = createSignal<unknown>(null);
  private manifestLoadFailed: boolean;
  private thumbnail: Uint8Array | null = null;
  private chatSessionFiles: ChatSessionFile[] | undefined;
  private current: Promise<void> | null = null;
  private pending: Deferred | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private disposed = false;
  private packagePath: string;
  private readonly thumbnails: ThumbnailScheduler;

  constructor(editor: Editor, path: string, deps: ProjectDeps, manifestLoadFailed = false) {
    this.editor = editor;
    this.deps = deps;
    this.debounceMs = deps.autosaveDebounceMs ?? autosaveDebounceMs;
    this.packagePath = normalizePath(path);
    this.manifestLoadFailed = manifestLoadFailed;
    editor.projectPath = this.packagePath;
    const capture = deps.captureThumbnail ?? renderProjectThumbnail;
    this.thumbnails = new ThumbnailScheduler({
      capture: () => capture(editor),
      onCaptured: (jpeg) => this.setThumbnail(jpeg),
      isPlaying: () => editor.ui.isPlaying,
    });
    sessions.set(editor, this);
    openSessions.set(pathKey(this.packagePath), this);
    this.disposeRoot = createRoot((dispose) => {
      createEffect(on(() => editor.store.revision, () => this.onEdited(), { defer: true }));
      return dispose;
    });
  }

  get path(): string {
    return this.packagePath;
  }

  /** The document changed since the last successful save. */
  dirty(): boolean {
    return this.editor.store.revision !== this.savedRevision[0]();
  }

  saving(): boolean {
    return this.savingSignal[0]();
  }

  /** The last failed save, cleared by the next success. */
  lastError(): unknown {
    return this.errorSignal[0]();
  }

  /** Marks the current document as already persisted (just opened, or just created and saved). */
  markClean(): void {
    this.savedRevision[1](this.editor.store.revision);
  }

  setThumbnail(jpeg: Uint8Array): void {
    this.thumbnail = jpeg;
    this.requestCheckpoint();
  }

  setChatSessionFiles(files: ChatSessionFile[]): void {
    this.chatSessionFiles = files;
    this.requestCheckpoint();
  }

  /** Something outside the undoable document changed and should reach disk soon. */
  requestCheckpoint(): void {
    this.savedRevision[1](-1);
    if (this.disposed || this.closing || this.checkpointTimer !== null) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      this.autosave();
    }, 0);
  }

  private onEdited(): void {
    if (this.disposed || this.closing || !this.dirty()) return;
    this.thumbnails.request();
    if (this.editTimer !== null) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.autosave();
    }, this.debounceMs);
  }

  private clearTimers(): void {
    if (this.editTimer !== null) clearTimeout(this.editTimer);
    if (this.checkpointTimer !== null) clearTimeout(this.checkpointTimer);
    this.editTimer = null;
    this.checkpointTimer = null;
  }

  private autosave(): void {
    if (this.disposed || this.closing || !this.dirty()) return;
    this.save().catch((error) => console.error("project autosave failed", error));
  }

  /** Saves in place. Requests made while a save runs coalesce into exactly one follow-up save. */
  save(): Promise<void> {
    if (this.current === null) return this.start();
    this.pending ??= deferred();
    return this.pending.promise;
  }

  /** Writes the project to `path` and makes it the open project's location. */
  async saveAs(path: string): Promise<void> {
    while (this.current !== null) await this.current.catch(() => {});
    await this.start(normalizePath(path));
  }

  private start(target?: string): Promise<void> {
    const run = (async () => {
      try {
        await this.write(target);
      } finally {
        this.finish();
      }
    })();
    this.current = run;
    this.savingSignal[1](true);
    return run;
  }

  private finish(): void {
    this.current = null;
    this.savingSignal[1](false);
    const next = this.pending;
    this.pending = null;
    if (next) this.start().then(next.resolve, next.reject);
    else if (this.errorSignal[0]() === null) this.onEdited();
  }

  private async write(target?: string): Promise<void> {
    const revision = this.editor.store.revision;
    const snapshot = snapshotForSave(this.editor, {
      manifestLoadFailed: this.manifestLoadFailed,
      thumbnail: this.thumbnail,
      chatSessionFiles: this.chatSessionFiles,
    });
    const source = this.packagePath;
    const destination = target ?? source;
    try {
      await writeProjectPackage(snapshot, destination, source, this.deps.fs);
    } catch (error) {
      this.errorSignal[1](() => error);
      throw error;
    }
    this.errorSignal[1](null);
    if (snapshot.thumbnail !== null) noteThumbnailSaved(destination);
    // A real manifest was just written, so the unreadable original is gone; stop preserving it.
    if (snapshot.manifest !== null) this.manifestLoadFailed = false;
    this.savedRevision[1](revision);
    if (target !== undefined && !samePath(target, source)) await this.relocate(source, target);
  }

  private async relocate(oldPath: string, newPath: string): Promise<void> {
    openSessions.delete(pathKey(oldPath));
    this.packagePath = newPath;
    openSessions.set(pathKey(newPath), this);
    const oldKey = pathKey(oldPath) + "/";
    const revision = this.editor.store.revision;
    this.editor.withoutRegistration(() => {
      for (const asset of this.editor.doc.mediaAssets) {
        if (pathKey(asset.url).startsWith(oldKey)) asset.url = joinPath(newPath, normalizePath(asset.url).slice(oldKey.length));
      }
    });
    this.editor.projectPath = newPath;
    // Asset urls are not persisted (manifest paths are relative), so the rebase leaves nothing unsaved.
    if (this.savedRevision[0]() === revision) this.savedRevision[1](this.editor.store.revision);
    await this.deps.registry?.updatePath(oldPath, newPath);
  }

  /** Close / quit: waits for the in-flight save, then saves once more and repeats until nothing is unsaved. */
  async flush(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    try {
      await this.thumbnails.flush();
      do {
        await this.save();
      } while (this.dirty());
    } finally {
      this.closing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.thumbnails.dispose();
    this.clearTimers();
    this.disposeRoot();
    if (openSessions.get(pathKey(this.packagePath)) === this) openSessions.delete(pathKey(this.packagePath));
  }
}

// MARK: - Entry points

/** `AppState.openProjectAsync`: an already-open project is returned as is. */
export async function openProject(path: string, deps?: ProjectDeps, register = true): Promise<Editor> {
  const d = await resolveDeps(deps);
  const existing = openSessions.get(pathKey(path));
  if (existing) {
    if (register) await d.registry?.register(existing.path);
    return existing.editor;
  }
  const contents = await readProjectPackage(path, d.fs);
  const editor = editorFromPackage(path, contents);
  await scanRestoredMedia(editor, d.fs);
  const session = new ProjectSession(editor, path, d, contents.manifestUnreadable);
  session.markClean();
  if (register) await d.registry?.register(session.path);
  return editor;
}

export async function saveProject(editor: Editor): Promise<void> {
  await projectSession(editor).save();
}

export async function saveProjectAs(editor: Editor, path: string): Promise<void> {
  await projectSession(editor).saveAs(path);
}

/** Final save, then release the session. Throws (leaving the project open) if the save fails. */
export async function closeProject(editor: Editor): Promise<void> {
  const session = projectSession(editor);
  await session.flush();
  session.dispose();
}

const invalidNameChars = /[\\/:*?"<>|]/;

export function validateProjectName(name: string): void {
  if (invalidNameChars.test(name) || name === "." || name === ".." || /[. ]$/.test(name)) {
    throw projectErrors.invalidName(name);
  }
}

function packagePathFor(directory: string, name: string): string {
  return joinPath(directory, `${name}.${Project.fileExtension}`);
}

/** "Untitled Project", then "Untitled Project 2", "Untitled Project 3"… */
export async function uniqueProjectName(directory: string, fs: FileSystem, base: string = Project.defaultProjectName): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (!(await fs.exists(packagePathFor(directory, candidate)))) return candidate;
  }
}

/**
 * `AppState.createProject(named:)`. Without a name the project gets the next free "Untitled Project" name;
 * an explicit name that is invalid or taken is an error.
 */
export async function newProject(name?: string, deps?: ProjectDeps): Promise<Editor> {
  const d = await resolveDeps(deps);
  const directory = d.projectsDirectory ?? d.registry?.projectsDirectory ?? (await appPaths()).projects;
  await d.fs.mkdir(directory);

  const trimmed = name?.trim() ?? "";
  let base: string;
  if (trimmed === "") {
    base = await uniqueProjectName(directory, d.fs);
  } else {
    validateProjectName(trimmed);
    base = trimmed;
    if (await d.fs.exists(packagePathFor(directory, base))) throw projectErrors.nameTaken(base);
  }
  const path = packagePathFor(directory, base);

  const editor = new Editor(makeEditorDocument());
  const session = new ProjectSession(editor, path, d);
  try {
    await session.save();
  } catch (error) {
    session.dispose();
    await d.fs.remove(path).catch(() => {});
    throw error;
  }
  await d.registry?.register(path);
  return editor;
}

/** `AppState.deleteProjects` guard: refuses while any entry is open in an editor. */
export function assertNoneOpen(entries: { path: string; name: string }[]): void {
  const open = entries.filter((e) => isProjectOpen(e.path));
  if (open.length > 0) throw projectErrors.openProjects(open.map((e) => e.name));
}
