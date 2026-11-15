// Downloadable pack catalog: a JSON index of packs, each with licence, attribution and sha256-pinned files.
//   { "format": "alcor-library-catalog", "version": 1, "packs": [ { id, name, kind, version, size, licence, ... } ] }
import { asObject, DecodingError, type JsonObject } from "../util/jsonDecode";

export const catalogFormatName = "alcor-library-catalog";
export const catalogFormatVersion = 1;

/** Default catalog; the repository does not exist yet, so callers must treat fetch failures as "unavailable". */
export const defaultCatalogUrl = "https://raw.githubusercontent.com/alcor-pro/library/main/index.json";

export const packKinds = ["looks", "luts", "text", "titles", "animations", "effects", "mixed"] as const;
export type PackKind = (typeof packKinds)[number];

export interface PackLicence {
  name: string;
  url?: string;
  /** True when users must credit the author (shown in the Attribution export). */
  requiresAttribution: boolean;
}

export interface PackFile {
  /** Path inside the pack directory (forward slashes, no `..`). */
  path: string;
  /** Absolute https URL, or relative to the catalog URL. */
  url: string;
  sha256: string;
  size: number;
}

export interface CatalogPack {
  id: string;
  name: string;
  kind: PackKind;
  version: string;
  description: string;
  /** Total bytes of all files. */
  size: number;
  licence: PackLicence;
  attribution: string;
  author: string;
  sourceUrl: string;
  files: PackFile[];
}

export interface Catalog {
  url: string;
  packs: CatalogPack[];
  warnings: string[];
}

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

/** True for a safe pack-relative file path (no traversal, drive letters, absolute or backslash paths). */
export function isSafePackPath(path: string): boolean {
  if (path === "" || path.length > 200 || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[<>:"|?*\u0000-\u001f]/.test(seg));
}

function reqString(o: JsonObject, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new DecodingError(`${ctx}: "${key}" must be a non-empty string`);
  return v;
}

function optString(o: JsonObject, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function decodeFile(raw: unknown, ctx: string): PackFile {
  const o = asObject(raw, `${ctx} file`);
  const path = reqString(o, "path", ctx);
  if (!isSafePackPath(path)) throw new DecodingError(`${ctx}: unsafe file path "${path}"`);
  const sha256 = reqString(o, "sha256", ctx).toLowerCase();
  if (!sha256Pattern.test(sha256)) throw new DecodingError(`${ctx}: "${path}" has an invalid sha256`);
  const size = o["size"];
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) throw new DecodingError(`${ctx}: "${path}" has an invalid size`);
  return { path, url: reqString(o, "url", ctx), sha256, size };
}

function decodePack(raw: unknown): CatalogPack {
  const o = asObject(raw, "pack");
  const id = reqString(o, "id", "pack");
  if (!idPattern.test(id)) throw new DecodingError(`pack id "${id}" is invalid`);
  const kind = o["kind"];
  if (typeof kind !== "string" || !(packKinds as readonly string[]).includes(kind)) throw new DecodingError(`${id}: unknown kind "${String(kind)}"`);
  const version = reqString(o, "version", id);
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new DecodingError(`${id}: invalid version "${version}"`);
  const licenceRaw = asObject(o["licence"], `${id} licence`);
  const licence: PackLicence = {
    name: reqString(licenceRaw, "name", id),
    requiresAttribution: licenceRaw["requiresAttribution"] === true,
    ...(typeof licenceRaw["url"] === "string" ? { url: licenceRaw["url"] } : {}),
  };
  if (!Array.isArray(o["files"]) || o["files"].length === 0) throw new DecodingError(`${id}: has no files`);
  const files = o["files"].map((f) => decodeFile(f, id));
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new DecodingError(`${id}: duplicate file paths`);
  const total = files.reduce((n, f) => n + f.size, 0);
  return {
    id,
    name: reqString(o, "name", id),
    kind: kind as PackKind,
    version,
    description: optString(o, "description"),
    size: typeof o["size"] === "number" ? o["size"] : total,
    licence,
    attribution: optString(o, "attribution"),
    author: reqString(o, "author", id),
    sourceUrl: reqString(o, "sourceUrl", id),
    files,
  };
}

/** Parses a catalog index. Broken packs are skipped with a warning; a broken envelope throws. */
export function parseCatalog(json: unknown, url: string): Catalog {
  const o = asObject(json, "catalog");
  if (o["format"] !== catalogFormatName) throw new DecodingError(`not an ${catalogFormatName} document`);
  const version = o["version"];
  if (typeof version !== "number" || version < 1) throw new DecodingError("invalid catalog version");
  if (version > catalogFormatVersion) throw new DecodingError(`catalog version ${version} is newer than this app supports`);
  if (!Array.isArray(o["packs"])) throw new DecodingError('"packs" must be an array');
  const packs: CatalogPack[] = [];
  const warnings: string[] = [];
  for (const raw of o["packs"]) {
    try {
      const pack = decodePack(raw);
      if (packs.some((p) => p.id === pack.id)) warnings.push(`duplicate pack "${pack.id}" skipped`);
      else packs.push(pack);
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { url, packs, warnings };
}

/** Resolves a file URL against the catalog URL; only https (and loopback http for development) is accepted. */
export function resolvePackFileUrl(file: PackFile, catalogUrl: string): string {
  const url = new URL(file.url, catalogUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`Refusing non-https download: ${url.protocol}//${url.host}`);
  return url.toString();
}

/** Numeric dotted-version comparison: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type PackState = "notInstalled" | "installed" | "updateAvailable";

export function packState(installedVersion: string | undefined, pack: CatalogPack): PackState {
  if (installedVersion === undefined) return "notInstalled";
  return compareVersions(installedVersion, pack.version) < 0 ? "updateAvailable" : "installed";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
