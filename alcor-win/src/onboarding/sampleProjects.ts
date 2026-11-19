// Port of Project/SampleProjectService.swift. Palmier's sample backend (and its media) is not available to Alcor Pro, so
// the samples come from `sampleProjectList`. A sample is either generated in code (`build`: nothing to download) or points
// at a "resolve" document in the shape the Swift backend returned, `{ title, project, manifest, downloads: [{ id,
// relativePath, url }], chat?: [{ name, url }], posterUrl? }`; its media is downloaded on demand into a new package.
import { Project } from "../model";
import { chatDirectoryName } from "../project/projectPackage";
import type { FileSystem } from "../project/fileSystem";
import { dirname, joinPath } from "../project/projectPaths";
import { newId } from "../util/id";
import { buildGeneratedSample, type BuiltSample } from "./generatedSample";

export interface SampleSummary {
  slug: string;
  title: string;
  posterUrl?: string;
  /** URL of the resolve document describing the package (project, manifest and every file to download). */
  resolveUrl?: string;
  /** Generated samples build their whole package in memory instead of downloading it. */
  build?: () => BuiltSample;
}

/**
 * TEMPLATE for a sample with downloaded media; deliberately not in `sampleProjectList` (its URL is a placeholder).
 * Host a resolve document at `resolveUrl` and move this entry into the list. The document needs `title`, `project`
 * (project.json), `manifest` (media.json whose `project.relativePath` sources match `downloads`), `downloads` and an
 * optional `posterUrl`. Media this sample would need (CC0 or otherwise redistributable, none of it is in git):
 *   media/clip-01.mp4, clip-02.mp4, clip-03.mp4  1080p, 5-10 s b-roll
 *   media/music.mp3                               60 s instrumental
 *   media/voiceover.mp3                           10-20 s narration
 */
export const placeholderDownloadSample: SampleSummary = {
  slug: "travel-reel",
  title: "Travel Reel",
  resolveUrl: "https://example.invalid/alcor/samples/travel-reel.json", // PLACEHOLDER: not a real URL
};

/** Offered on Home and by onboarding; onboarding opens the first entry. */
export const sampleProjectList: readonly SampleSummary[] = [{ slug: "welcome", title: "Welcome to Alcor", build: buildGeneratedSample }];

export interface SampleDeps {
  fs: FileSystem;
  fetchText(url: string): Promise<string>;
  /** Aborting `signal` must stop the transfer and reject. */
  download(url: string, destPath: string, signal?: AbortSignal): Promise<void>;
  /** Directory samples are materialised under (`<appData>/Samples`). */
  cacheRoot(): Promise<string>;
}

export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleError";
  }
}

export class SampleCancelled extends SampleError {
  constructor() {
    super("The sample download was cancelled.");
    this.name = "SampleCancelled";
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
  /** Generated files, written as they are. */
  files: { relativePath: string; bytes: Uint8Array }[];
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
  const resolved: ResolvedSample = { title: root.title, project: root.project, manifest: root.manifest, downloads, files: [] };
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

async function resolveSample(deps: SampleDeps, sample: SampleSummary): Promise<ResolvedSample> {
  if (sample.build) {
    const built = sample.build();
    return { title: built.title, project: built.project, manifest: built.manifest, downloads: [], files: built.files };
  }
  if (sample.resolveUrl === undefined) throw new SampleError("The sample has no source.");
  return parseResolvedSample(await deps.fetchText(sample.resolveUrl));
}

/**
 * Builds a new `.palmier` package for the sample and returns its path. Reports progress (0...1); aborting `signal`
 * stops the transfers, and any failure or cancel removes the partial package.
 */
export async function materializeSample(
  deps: SampleDeps,
  sample: SampleSummary,
  onProgress: (fraction: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<string> {
  const cancelled = signal && new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new SampleCancelled());
    else signal.addEventListener("abort", () => reject(new SampleCancelled()), { once: true });
  });
  cancelled?.catch(() => undefined);
  const guard = <T>(work: Promise<T>): Promise<T> => (cancelled ? Promise.race([work, cancelled]) : work);

  const resolved = await guard(resolveSample(deps, sample));
  const slugDir = await slugDirectory(deps, sample.slug);
  await deps.fs.remove(slugDir); // a stale or partial copy is replaced
  const dest = joinPath(slugDir, `${safeSampleName(resolved.title)}.${Project.fileExtension}`);
  const fetchTo = async (url: string, path: string): Promise<void> => {
    await deps.fs.mkdir(dirname(path));
    await guard(deps.download(url, path, signal));
  };
  try {
    await guard(Promise.resolve());
    await deps.fs.mkdir(joinPath(dest, Project.mediaDirectoryName));
    await deps.fs.writeText(joinPath(dest, Project.timelineFilename), JSON.stringify(resolved.project));
    await deps.fs.writeText(joinPath(dest, Project.manifestFilename), JSON.stringify(resolved.manifest));
    if (resolved.posterUrl !== undefined) {
      await fetchTo(resolved.posterUrl, joinPath(dest, Project.thumbnailFilename)).catch((error: unknown) => {
        if (error instanceof SampleCancelled) throw error; // a missing poster is not fatal, a cancel is
      });
    }
    const total = Math.max(1, resolved.downloads.length + resolved.files.length);
    let completed = 0;
    const step = (): void => onProgress(++completed / total);
    onProgress(0);
    for (const file of resolved.files) {
      await guard(deps.fs.writeBytes(joinPath(dest, file.relativePath), file.bytes));
      step();
    }
    await Promise.all(
      resolved.downloads.map(async (d) => {
        await fetchTo(d.url, joinPath(dest, d.relativePath));
        step();
      }),
    );
  } catch (error) {
    await deps.fs.remove(slugDir).catch(() => undefined);
    throw error;
  }
  return dest;
}

/** Cached package when present, otherwise build or download it. */
export async function openableSamplePath(
  deps: SampleDeps,
  sample: SampleSummary,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return (await cachedSamplePath(deps, sample.slug)) ?? materializeSample(deps, sample, onProgress, signal);
}

export async function createSampleDeps(): Promise<SampleDeps> {
  const [{ appPaths, httpCancel, httpDownload, httpFetch }, { backendFileSystem }] = await Promise.all([import("../platform/backend"), import("../project/fileSystem")]);
  return {
    fs: backendFileSystem,
    cacheRoot: async () => joinPath((await appPaths()).appData, "Samples"),
    async fetchText(url) {
      const response = await httpFetch({ url, timeoutMs: 30_000 });
      if (response.status < 200 || response.status >= 300) throw new SampleError(`Server returned HTTP ${response.status}.`);
      return response.bodyText;
    },
    async download(url, destPath, signal) {
      const requestId = newId();
      const cancel = (): void => void httpCancel(requestId);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await httpDownload({ url, timeoutMs: 120_000, requestId }, destPath, () => undefined);
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
