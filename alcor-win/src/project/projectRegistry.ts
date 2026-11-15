import { createSignal } from "solid-js";
import { Project, swiftDateNow, type SwiftDate } from "../model";
import { appPaths } from "../platform/backend";
import { newId } from "../util/id";
import { backendFileSystem, type FileSystem } from "./fileSystem";
import { joinPath, pathKey, stem } from "./projectPaths";

/** On disk: `{ id, path, createdDate, lastOpenedDate }`; dates use the Swift reference-date encoding. */
export interface ProjectEntry {
  id: string;
  path: string;
  createdDate: SwiftDate;
  lastOpenedDate: SwiftDate;
}

export interface ProjectDeletionResult {
  deletedIds: Set<string>;
  failedNames: string[];
}

export function projectEntryName(entry: ProjectEntry): string {
  return stem(entry.path);
}

export interface ProjectRegistryOptions {
  fs?: FileSystem;
  /** Directory holding the registry file (the projects dir). */
  directory: string;
  now?: () => SwiftDate;
}

type Mutation = (entries: ProjectEntry[]) => ProjectEntry[];

/** Port of ProjectRegistry. Call `load()` once; mutations made while loading are queued and replayed. */
export class ProjectRegistry {
  private readonly fs: FileSystem;
  private readonly now: () => SwiftDate;
  private readonly filePath: string;
  private readonly directory: string;
  private readonly entriesSignal = createSignal<ProjectEntry[]>([]);
  private isLoading = true;
  private pendingMutations: { apply: Mutation; done: { resolve: () => void; reject: (e: unknown) => void } }[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ProjectRegistryOptions) {
    this.fs = options.fs ?? backendFileSystem;
    this.now = options.now ?? swiftDateNow;
    this.directory = options.directory;
    this.filePath = joinPath(options.directory, Project.registryFilename);
  }

  get projectsDirectory(): string {
    return this.directory;
  }

  entries(): ProjectEntry[] {
    return this.entriesSignal[0]();
  }

  sortedEntries(): ProjectEntry[] {
    return [...this.entries()].sort((a, b) => b.lastOpenedDate - a.lastOpenedDate);
  }

  id(path: string): string | undefined {
    const key = pathKey(path);
    return this.entries().find((e) => pathKey(e.path) === key)?.id;
  }

  /** `entry.isAccessible`, evaluated off the UI path. */
  isAccessible(entry: ProjectEntry): Promise<boolean> {
    return this.fs.exists(entry.path);
  }

  // MARK: - Mutations

  register(path: string): Promise<void> {
    const key = pathKey(path);
    const resolved = joinPath(path, "");
    return this.mutate((entries) => {
      const now = this.now();
      const index = entries.findIndex((e) => pathKey(e.path) === key);
      if (index >= 0) return entries.map((e, i) => (i === index ? { ...e, lastOpenedDate: now } : e));
      return [...entries, { id: newId(), path: resolved, createdDate: now, lastOpenedDate: now }];
    });
  }

  remove(path: string): Promise<void> {
    const key = pathKey(path);
    return this.mutate((entries) => entries.filter((e) => pathKey(e.path) !== key));
  }

  updatePath(oldPath: string, newPath: string): Promise<void> {
    const oldKey = pathKey(oldPath);
    const resolved = joinPath(newPath, "");
    return this.mutate((entries) => {
      const now = this.now();
      return entries.map((e) => (pathKey(e.path) === oldKey ? { ...e, path: resolved, lastOpenedDate: now } : e));
    });
  }

  /** Deletes the project directories permanently (there is no Trash command yet); the UI confirms first. */
  async delete(entries: ProjectEntry[]): Promise<ProjectDeletionResult> {
    const results = await Promise.all(
      entries.map(async (entry) => ({ entry, deleted: await this.removeIfPresent(entry.path) })),
    );
    const deletedIds = new Set(results.filter((r) => r.deleted).map((r) => r.entry.id));
    if (deletedIds.size > 0) await this.mutate((current) => current.filter((e) => !deletedIds.has(e.id)));
    return {
      deletedIds,
      failedNames: results.filter((r) => !r.deleted).map((r) => projectEntryName(r.entry)),
    };
  }

  /** Renames the project directory on disk, then repoints the entry. Throws if the target exists. */
  async rename(entry: ProjectEntry, newPath: string): Promise<void> {
    if (await this.fs.exists(newPath)) throw new Error(`${newPath} already exists`);
    await this.fs.rename(entry.path, newPath);
    await this.updatePath(entry.path, newPath);
  }

  private async removeIfPresent(path: string): Promise<boolean> {
    try {
      await this.fs.remove(path);
      return true;
    } catch (error) {
      console.error("delete project failed", path, error);
      return false;
    }
  }

  // MARK: - Persistence

  async load(): Promise<void> {
    this.isLoading = true;
    await this.fs.mkdir(this.directory).catch(() => {});
    const loaded = await this.loadEntries();
    this.entriesSignal[1](loaded);
    this.isLoading = false;
    const queued = this.pendingMutations;
    this.pendingMutations = [];
    if (queued.length === 0) return;
    let next = loaded;
    for (const m of queued) next = m.apply(next);
    this.entriesSignal[1](next);
    try {
      await this.save(next);
      for (const m of queued) m.done.resolve();
    } catch (error) {
      for (const m of queued) m.done.reject(error);
    }
  }

  private async loadEntries(): Promise<ProjectEntry[]> {
    try {
      const json: unknown = JSON.parse(await this.fs.readText(this.filePath));
      if (!Array.isArray(json)) return [];
      return json.flatMap((raw): ProjectEntry[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const { id, path, createdDate, lastOpenedDate } = raw as Record<string, unknown>;
        const ok =
          typeof id === "string" && typeof path === "string" &&
          typeof createdDate === "number" && typeof lastOpenedDate === "number";
        return ok ? [{ id, path, createdDate, lastOpenedDate }] : [];
      });
    } catch {
      return [];
    }
  }

  private save(entries: ProjectEntry[]): Promise<void> {
    const text = JSON.stringify(entries);
    const write = this.writeChain.then(() => this.fs.writeText(this.filePath, text));
    this.writeChain = write.catch(() => {});
    return write;
  }

  private mutate(apply: Mutation): Promise<void> {
    if (this.isLoading) {
      return new Promise<void>((resolve, reject) => {
        this.pendingMutations.push({ apply, done: { resolve, reject } });
      });
    }
    const next = apply(this.entriesSignal[0]());
    this.entriesSignal[1](next);
    return this.save(next);
  }
}

let shared: Promise<ProjectRegistry> | undefined;

/** The app-wide registry in the projects directory; created and loaded on first use. */
export function sharedProjectRegistry(): Promise<ProjectRegistry> {
  shared ??= appPaths().then(async (paths) => {
    const registry = new ProjectRegistry({ directory: paths.projects });
    await registry.load();
    return registry;
  });
  return shared;
}
