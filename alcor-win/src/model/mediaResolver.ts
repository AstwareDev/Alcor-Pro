import type { MediaManifest, MediaManifestEntry } from "./mediaManifest";

/*
 * Paths are plain strings (Windows or POSIX). The filesystem check is injected so this module stays pure;
 * production code passes a Rust-backed existence check.
 */
export interface MediaResolver {
  manifest: () => MediaManifest;
  projectPath: () => string | undefined;
  fileExists: (path: string) => boolean;
}

export function makeMediaResolver(r: MediaResolver): MediaResolver {
  return r;
}

/** `NSString.appendingPathComponent`: exactly one separator between base and component. */
export function joinPath(base: string, component: string): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const trimmedComponent = component.replace(/^[\\/]+/, "");
  if (trimmedBase === "") return "/" + trimmedComponent;
  return `${trimmedBase}/${trimmedComponent}`;
}

function expectedPathForEntry(entry: MediaManifestEntry, projectPath: string | undefined): string | undefined {
  if ("external" in entry.source) return entry.source.external.absolutePath;
  if (projectPath === undefined) return undefined;
  return joinPath(projectPath, entry.source.project.relativePath);
}

export function mediaResolverEntry(r: MediaResolver, assetId: string): MediaManifestEntry | undefined {
  return r.manifest().entries.find((e) => e.id === assetId);
}

export function mediaResolverExpectedPath(r: MediaResolver, assetId: string): string | undefined {
  const entry = mediaResolverEntry(r, assetId);
  return entry ? expectedPathForEntry(entry, r.projectPath()) : undefined;
}

/** `resolveURL(for:)`: the expected path only if the file exists. */
export function mediaResolverResolvePath(r: MediaResolver, assetId: string): string | undefined {
  const path = mediaResolverExpectedPath(r, assetId);
  return path !== undefined && r.fileExists(path) ? path : undefined;
}

/** First entry wins for duplicate ids. */
export function mediaResolverExpectedPathMapFor(
  entries: readonly MediaManifestEntry[],
  projectPath: string | undefined,
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (out.has(entry.id)) continue;
    out.set(entry.id, expectedPathForEntry(entry, projectPath));
  }
  return out;
}

export function mediaResolverExpectedPathMap(r: MediaResolver): Map<string, string | undefined> {
  return mediaResolverExpectedPathMapFor(r.manifest().entries, r.projectPath());
}

export function mediaResolverSnapshot(r: MediaResolver): MediaResolver {
  const manifest = r.manifest();
  const projectPath = r.projectPath();
  return { manifest: () => manifest, projectPath: () => projectPath, fileExists: r.fileExists };
}

export function mediaResolverManifestSnapshot(r: MediaResolver): MediaManifest {
  return r.manifest();
}

export function mediaResolverIsMissing(r: MediaResolver, assetId: string): boolean {
  const path = mediaResolverExpectedPath(r, assetId);
  return path === undefined || !r.fileExists(path);
}

/** Asset IDs whose backing file is missing, from a snapshot of manifest entries + the project base path. */
export function mediaResolverMissingAssetIds(
  entries: readonly MediaManifestEntry[],
  projectPath: string | undefined,
  fileExists: (path: string) => boolean,
): Set<string> {
  const missing = new Set<string>();
  for (const entry of entries) {
    const path = expectedPathForEntry(entry, projectPath);
    if (path === undefined || !fileExists(path)) missing.add(entry.id);
  }
  return missing;
}

export function mediaResolverDisplayName(r: MediaResolver, assetId: string): string {
  return mediaResolverEntry(r, assetId)?.name ?? "Offline";
}
