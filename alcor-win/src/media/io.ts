export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

/** Filesystem surface the media layer needs; tests substitute an in-memory implementation. */
export interface MediaIo {
  stat(path: string): Promise<FsEntry | null>;
  /** Rejects when the directory cannot be read. */
  list(path: string): Promise<FsEntry[]>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Up to `length` bytes from the start of the file. */
  readHead(path: string, length: number): Promise<Uint8Array>;
  /** Whole file as bytes (small cache files only). */
  readAll(path: string): Promise<Uint8Array>;
  copy(from: string, to: string): Promise<void>;
  /** Atomic move on one volume; replaces an existing destination file. */
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  cacheDir(): Promise<string>;
  tempDir(): Promise<string>;
}

let override: MediaIo | undefined;

export function setMediaIo(io: MediaIo | undefined): void {
  override = io;
}

export async function mediaIo(): Promise<MediaIo> {
  if (override) return override;
  return (await import("./backendIo")).backendMediaIo;
}
