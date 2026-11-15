import { fsExists, fsList, fsReadText, fsRemove, fsWriteText } from "../../platform/backend";

/** The file operations the skill store needs; the real one goes through platform commands, tests use `memorySkillFs`. */
export interface SkillFs {
  /** Undefined when the file is missing or unreadable. */
  readText(path: string): Promise<string | undefined>;
  /** Atomic; creates parent directories. */
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Names of the immediate subdirectories; empty when the directory is missing. */
  listDirs(path: string): Promise<string[]>;
  /** Recursive; throws when the path does not exist. */
  remove(path: string): Promise<void>;
}

export const joinPath = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

export const platformSkillFs: SkillFs = {
  async readText(path) {
    try {
      return (await fsExists(path)) ? await fsReadText(path) : undefined;
    } catch {
      return undefined;
    }
  },
  writeText: (path, text) => fsWriteText(path, text),
  exists: (path) => fsExists(path),
  async listDirs(path) {
    try {
      return (await fsList(path)).filter((e) => e.isDir).map((e) => e.name);
    } catch {
      return [];
    }
  },
  async remove(path) {
    if (!(await fsExists(path))) throw new Error(`No such file or directory: ${path}`);
    await fsRemove(path);
  },
};

export interface MemorySkillFs extends SkillFs {
  readonly files: Map<string, string>;
  /** Writes to these exact paths throw. */
  readonly blockedWrites: Set<string>;
}

/** In-memory fake; directories exist implicitly as the parents of files. */
export function memorySkillFs(): MemorySkillFs {
  const files = new Map<string, string>();
  const blockedWrites = new Set<string>();
  const isDir = (path: string): boolean => [...files.keys()].some((f) => f.startsWith(`${path}/`));
  return {
    files,
    blockedWrites,
    async readText(path) {
      return files.get(path);
    },
    async writeText(path, text) {
      if (blockedWrites.has(path)) throw new Error(`Cannot write ${path}`);
      files.set(path, text);
    },
    async exists(path) {
      return files.has(path) || isDir(path);
    },
    async listDirs(path) {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash > 0) names.add(rest.slice(0, slash));
      }
      return [...names];
    },
    async remove(path) {
      if (!files.has(path) && !isDir(path)) throw new Error(`No such file or directory: ${path}`);
      for (const f of [...files.keys()]) if (f === path || f.startsWith(`${path}/`)) files.delete(f);
    },
  };
}
