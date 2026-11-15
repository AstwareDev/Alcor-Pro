import {
  fsCopy, fsExists, fsList, fsMkdir, fsReadText, fsRemove, fsRename, fsStat, fsWriteBytes, fsWriteText,
} from "../platform/backend";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** The slice of file access project persistence needs. `writeText`/`writeBytes` are atomic and create parents. */
export interface FileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  list(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  /** Copies one file; creates the destination's parent directories. */
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive; a missing path is not an error. */
  remove(path: string): Promise<void>;
}

export const backendFileSystem: FileSystem = {
  readText: fsReadText,
  writeText: fsWriteText,
  writeBytes: fsWriteBytes,
  exists: fsExists,
  isDirectory: async (path) => (await fsStat(path))?.isDir === true,
  list: async (path) => (await fsList(path)).map((e) => ({ name: e.name, path: e.path, isDir: e.isDir })),
  mkdir: fsMkdir,
  copy: fsCopy,
  rename: fsRename,
  remove: fsRemove,
};
