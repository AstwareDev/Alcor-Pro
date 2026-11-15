// Port of Project/SampleProjectService.swift. Palmier's sample backend (and its media) is not available to Alcor Pro, so
// the samples come from `sampleProjectList`: each entry points at a "resolve" document in the same shape the Swift backend
// returned, `{ title, project, manifest, downloads: [{ id, relativePath, url }], chat?: [{ name, url }], posterUrl? }`.
import { Project } from "../model";
import { chatDirectoryName } from "../project/projectPackage";
import type { FileSystem } from "../project/fileSystem";
import { dirname, joinPath } from "../project/projectPaths";

export interface SampleSummary {
  slug: string;
  title: string;
  posterUrl?: string;
  /** URL of the resolve document describing the package (project, manifest and every file to download). */
  resolveUrl: string;
}

/**
 * TODO(lead): fill with sample projects whose media may be redistributed (none ship with the Swift sources, which load
 * theirs from Palmier's hosted backend). While this is empty the Home screen shows no samples section and onboarding
 * skips the tutorial button.
 */
export const sampleProjectList: readonly SampleSummary[] = [];

export interface SampleDeps {
  fs: FileSystem;
  fetchText(url: string): Promise<string>;
  download(url: string, destPath: string): Promise<void>;
  /** Directory samples are materialised under (`<appData>/Samples`). */
  cacheRoot(): Promise<string>;
}

export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleError";
  }
}

/** `safeName`: path separators become spaces; never empty. */
export function safeSampleName(name: string): string {
  const cleaned = name.replace(/[/:\\]/g, " ").trim();
  return cleaned === "" ? "Sample" : cleaned;
}

interface Download {
  relativePath: string;
  url: string;
}

interface ResolvedSample {
  title: string;
  project: unknown;
  manifest: unknown;
  posterUrl?: string;
  downloads: Download[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A relative path inside the package: no absolute paths, no `..`. */
function safeRelativePath(path: string): boolean {
  return path !== "" && !/^([/\\]|[A-Za-z]:)/.test(path) && !path.split(/[/\\]/).includes("..");
}

export function parseResolvedSample(text: string): ResolvedSample {
  const malformed = new SampleError("The sample response was malformed.");
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw malformed;
  }
  if (!isRecord(root) || typeof root.title !== "string" || root.project === undefined || root.manifest === undefined || !Array.isArray(root.downloads)) {
    throw malformed;
  }
  const downloads: Download[] = [];
  for (const entry of root.downloads) {
    if (!isRecord(entry) || typeof entry.relativePath !== "string" || typeof entry.url !== "string" || !safeRelativePath(entry.relativePath)) throw malformed;
    downloads.push({ relativePath: entry.relativePath, url: entry.url });
  }
  if (root.chat !== undefined) {
    if (!Array.isArray(root.chat)) throw malformed;
    for (const entry of root.chat) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.url !== "string" || !safeRelativePath(entry.name)) throw malformed;
      downloads.push({ relativePath: `${chatDirectoryName}/${entry.name}`, url: entry.url });
    }
  }
  const resolved: ResolvedSample = { title: root.title, project: root.project, manifest: root.manifest, downloads };
  if (typeof root.posterUrl === "string") resolved.posterUrl = root.posterUrl;
  return resolved;
}

const slugDirectory = async (deps: SampleDeps, slug: string): Promise<string> => joinPath(await deps.cacheRoot(), safeSampleName(slug));

/** The already-materialised package for `slug`, if any (`cachedURL`). */
export async function cachedSamplePath(deps: SampleDeps, slug: string): Promise<string | undefined> {
  const dir = await slugDirectory(deps, slug);
  try {
    return (await deps.fs.list(dir)).find((e) => e.name.toLowerCase().endsWith(`.${Project.fileExtension}`))?.path;
  } catch {
    return undefined;
  }
}

/**
 * Builds a new `.palmier` package for the sample and returns its path. Reports download progress (0...1) and removes
 * a partial package if anything fails.
 */
export async function materializeSample(deps: SampleDeps, sample: SampleSummary, onProgress: (fraction: number) => void = () => undefined): Promise<string> {
  const resolved = parseResolvedSample(await deps.fetchText(sample.resolveUrl));
  const slugDir = await slugDirectory(deps, sample.slug);
  await deps.fs.remove(slugDir); // a stale or partial copy is replaced
  const dest = joinPath(slugDir, `${safeSampleName(resolved.title)}.${Project.fileExtension}`);
  const fetchTo = async (url: string, path: string): Promise<void> => {
    await deps.fs.mkdir(dirname(path));
    await deps.download(url, path);
  };
  try {
    await deps.fs.mkdir(joinPath(dest, Project.mediaDirectoryName));
    await deps.fs.writeText(joinPath(dest, Project.timelineFilename), JSON.stringify(resolved.project));
    await deps.fs.writeText(joinPath(dest, Project.manifestFilename), JSON.stringify(resolved.manifest));
    if (resolved.posterUrl !== undefined) {
      await fetchTo(resolved.posterUrl, joinPath(dest, Project.thumbnailFilename)).catch(() => undefined);
    }
    const total = Math.max(1, resolved.downloads.length);
    let completed = 0;
    onProgress(0);
    await Promise.all(
      resolved.downloads.map(async (d) => {
        await fetchTo(d.url, joinPath(dest, d.relativePath));
        completed += 1;
        onProgress(completed / total);
      }),
    );
  } catch (error) {
    await deps.fs.remove(slugDir).catch(() => undefined);
    throw error;
  }
  return dest;
}

/** Cached package when present, otherwise download it. */
export async function openableSamplePath(deps: SampleDeps, sample: SampleSummary, onProgress?: (fraction: number) => void): Promise<string> {
  return (await cachedSamplePath(deps, sample.slug)) ?? materializeSample(deps, sample, onProgress);
}

export async function createSampleDeps(): Promise<SampleDeps> {
  const [{ appPaths, httpDownload, httpFetch }, { backendFileSystem }] = await Promise.all([import("../platform/backend"), import("../project/fileSystem")]);
  return {
    fs: backendFileSystem,
    cacheRoot: async () => joinPath((await appPaths()).appData, "Samples"),
    async fetchText(url) {
      const response = await httpFetch({ url, timeoutMs: 30_000 });
      if (response.status < 200 || response.status >= 300) throw new SampleError(`Server returned HTTP ${response.status}.`);
      return response.bodyText;
    },
    async download(url, destPath) {
      await httpDownload({ url, timeoutMs: 120_000 }, destPath, () => undefined);
    },
  };
}
