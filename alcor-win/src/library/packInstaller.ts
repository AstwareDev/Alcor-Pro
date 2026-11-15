// Installs catalog packs into `<root>/<packId>/` (root = `<appData>/library`). Files are downloaded into a staging
// directory, verified (size + sha256), then the directory is swapped in; any failure or cancel leaves the previous
// install untouched. All I/O goes through `InstallerDeps` so tests run against a fake file system.
import { isSafePackPath, resolvePackFileUrl, type CatalogPack } from "./catalog";

export interface InstallerFs {
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ name: string; isDir: boolean }[]>;
}

export interface InstallerDeps {
  root: string;
  fs: InstallerFs;
  /** Streams `url` to `dest`; must reject when `signal` aborts. */
  download(url: string, dest: string, onProgress: (received: number) => void, signal: AbortSignal): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
}

export interface InstalledPack {
  id: string;
  version: string;
  installedAt: string;
  pack: CatalogPack;
  /** Absolute directory of the installed files. */
  dir: string;
}

export interface InstallProgress {
  receivedBytes: number;
  totalBytes: number;
  fileIndex: number;
  fileCount: number;
}

export class InstallCancelled extends Error {
  constructor() {
    super("Download cancelled.");
    this.name = "InstallCancelled";
  }
}

export class IntegrityError extends Error {
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "IntegrityError";
  }
}

export const manifestFileName = "manifest.json";

export function joinPath(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).filter((p) => p !== "").join("/");
}

export function packDir(root: string, packId: string): string {
  return joinPath(root, packId);
}

async function mkdirs(fs: InstallerFs, base: string, relative: string): Promise<void> {
  await fs.mkdir(base);
  const segments = relative.split("/");
  let current = base;
  for (const seg of segments.slice(0, -1)) {
    current = joinPath(current, seg);
    await fs.mkdir(current);
  }
}

export async function installPack(
  deps: InstallerDeps,
  pack: CatalogPack,
  catalogUrl: string,
  options: { signal?: AbortSignal; onProgress?: (p: InstallProgress) => void; now?: () => Date } = {},
): Promise<InstalledPack> {
  const signal = options.signal ?? new AbortController().signal;
  for (const file of pack.files) if (!isSafePackPath(file.path)) throw new Error(`Unsafe file path in pack: ${file.path}`);
  const urls = pack.files.map((f) => resolvePackFileUrl(f, catalogUrl));
  const { fs } = deps;
  const finalDir = packDir(deps.root, pack.id);
  const staging = joinPath(deps.root, `.staging-${pack.id}`);
  const backup = joinPath(deps.root, `.old-${pack.id}`);
  const totalBytes = pack.files.reduce((n, f) => n + f.size, 0);
  let doneBytes = 0;

  const throwIfAborted = (): void => {
    if (signal.aborted) throw new InstallCancelled();
  };

  await fs.mkdir(deps.root);
  if (await fs.exists(staging)) await fs.remove(staging);
  try {
    for (let i = 0; i < pack.files.length; i++) {
      throwIfAborted();
      const file = pack.files[i] as CatalogPack["files"][number];
      const dest = joinPath(staging, file.path);
      await mkdirs(fs, staging, file.path);
      const emit = (received: number): void =>
        options.onProgress?.({ receivedBytes: doneBytes + received, totalBytes, fileIndex: i, fileCount: pack.files.length });
      emit(0);
      try {
        await deps.download(urls[i] as string, dest, emit, signal);
      } catch (e) {
        if (signal.aborted) throw new InstallCancelled();
        throw e;
      }
      throwIfAborted();
      const bytes = await deps.readBytes(dest);
      if (bytes.byteLength !== file.size) throw new IntegrityError(file.path, `expected ${file.size} bytes, got ${bytes.byteLength}`);
      const actual = await deps.sha256Hex(bytes);
      if (actual !== file.sha256) throw new IntegrityError(file.path, "sha256 mismatch (the download is corrupt or was modified)");
      doneBytes += file.size;
      emit(0);
    }
    throwIfAborted();
    const installed: InstalledPack = {
      id: pack.id, version: pack.version, installedAt: (options.now?.() ?? new Date()).toISOString(), pack, dir: finalDir,
    };
    await fs.writeText(joinPath(staging, manifestFileName), JSON.stringify(installed, null, 2));
    if (await fs.exists(backup)) await fs.remove(backup);
    const hadPrevious = await fs.exists(finalDir);
    if (hadPrevious) await fs.rename(finalDir, backup);
    try {
      await fs.rename(staging, finalDir);
    } catch (e) {
      if (hadPrevious) await fs.rename(backup, finalDir);
      throw e;
    }
    if (hadPrevious) await fs.remove(backup);
    return installed;
  } catch (e) {
    await fs.remove(staging).catch(() => undefined);
    throw e;
  }
}

export async function uninstallPack(deps: InstallerDeps, packId: string): Promise<void> {
  const dir = packDir(deps.root, packId);
  if (await deps.fs.exists(dir)) await deps.fs.remove(dir);
}

/** Every pack with a readable manifest; damaged or half-installed directories are ignored. */
export async function listInstalledPacks(deps: InstallerDeps): Promise<InstalledPack[]> {
  if (!(await deps.fs.exists(deps.root))) return [];
  const out: InstalledPack[] = [];
  for (const entry of await deps.fs.list(deps.root)) {
    if (!entry.isDir || entry.name.startsWith(".")) continue;
    const dir = joinPath(deps.root, entry.name);
    try {
      const parsed: unknown = JSON.parse(await deps.fs.readText(joinPath(dir, manifestFileName)));
      if (typeof parsed !== "object" || parsed === null) continue;
      const m = parsed as Partial<InstalledPack>;
      if (typeof m.id === "string" && typeof m.version === "string" && m.pack !== undefined && m.id === entry.name) {
        out.push({ id: m.id, version: m.version, installedAt: m.installedAt ?? "", pack: m.pack, dir });
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** Resolves a pack-relative resource (`<packId>/luts/a.cube`) to an absolute path when that pack is installed. */
export function resolveInstalledResource(installed: readonly InstalledPack[], resource: string): string | undefined {
  const slash = resource.indexOf("/");
  if (slash <= 0) return undefined;
  const id = resource.slice(0, slash);
  const rest = resource.slice(slash + 1);
  if (!isSafePackPath(rest)) return undefined;
  const pack = installed.find((p) => p.id === id);
  return pack && pack.pack.files.some((f) => f.path === rest) ? joinPath(pack.dir, rest) : undefined;
}
