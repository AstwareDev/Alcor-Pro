import type { Editor } from "../../editor/editor";
import { createMatte } from "../../editor/mutations/matte";
import { generationHooks } from "../../generation/generationState";
import { mediaIo } from "../../media/io";
import {
  commitStagedProjectMedia, finalizeImportedAsset, importFinderItems, importMediaAsset, manifestEntryFor, updateManifestMetadata,
} from "../../media/library";
import { clipTypeForPath, isLottieHeader, lottieSniffByteLimit } from "../../media/mediaTypes";
import { fileStem, lastPathComponent, pathExtension } from "../../media/paths";
import {
  clipTypeFromFileExtension, joinPath, makeMediaAsset, matteAspectParse, matteAspects, swiftDateNow, type ClipType, type MatteAspect, type MediaAsset,
} from "../../model";
import { httpCancel, httpDownload } from "../../platform/backend";
import { newId } from "../../util/id";
import { jsonString } from "./jsonFormat";
import { resolveFolder } from "./organizeTools";
import { ToolError, argString, isRecord, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Import.swift: import_media (url / path / directory / bytes / matte).

export const remoteImportMaxBytes = 5 * 1024 * 1024 * 1024;
export const importBytesMaxBase64Length = 15 * 1024 * 1024;
export const remoteImportRequestTimeoutMs = 15 * 60 * 1000;

const importMediaAllowedKeys = ["source", "name", "folder"];
const importSourceAllowedKeys = ["url", "path", "bytes", "matte", "mimeType"];
const acceptedMimeTypesMessage =
  "Accepted: video/mp4, video/quicktime, audio/mpeg, audio/wav, audio/aac, audio/mp4, audio/aiff, audio/x-caf, audio/flac, image/png, image/jpeg, image/tiff, image/heic, application/x-subrip, text/vtt.";
const undoName = "Import Media (Agent)";

/** Network seam so tests don't touch the backend. */
export interface ImportDeps {
  /** Downloads `url` to `dest`, calling `onProgress` with received bytes; rejects on HTTP errors. */
  download(url: string, dest: string, requestId: string, onProgress: (received: number, total: number | null) => void): Promise<void>;
  cancel(requestId: string): Promise<unknown>;
}

const defaultImportDeps: ImportDeps = {
  async download(url, dest, requestId, onProgress) {
    await httpDownload({ url, requestId, timeoutMs: remoteImportRequestTimeoutMs }, dest, (p) => onProgress(p.received, p.total));
  },
  cancel: httpCancel,
};

let importDeps: ImportDeps = defaultImportDeps;

/** Tests substitute a fake downloader; pass undefined to restore. */
export function setImportDeps(deps: ImportDeps | undefined): void {
  importDeps = deps ?? defaultImportDeps;
}

function fileExtensionForMime(mime: string): string | undefined {
  switch (mime.toLowerCase()) {
    case "video/mp4": case "video/mpeg4": return "mp4";
    case "video/quicktime": return "mov";
    case "audio/mpeg": case "audio/mp3": return "mp3";
    case "audio/wav": case "audio/x-wav": case "audio/wave": return "wav";
    case "audio/aac": return "aac";
    case "audio/mp4": case "audio/m4a": case "audio/x-m4a": return "m4a";
    case "audio/aiff": case "audio/x-aiff": return "aiff";
    case "audio/aifc": case "audio/x-aifc": return "aifc";
    case "audio/caf": case "audio/x-caf": return "caf";
    case "audio/flac": case "audio/x-flac": return "flac";
    case "image/png": return "png";
    case "image/jpeg": case "image/jpg": return "jpg";
    case "image/tiff": return "tiff";
    case "image/heic": case "image/heif": return "heic";
    case "application/json": case "application/vnd.lottie+json": return "json";
    case "application/x-subrip": case "text/srt": return "srt";
    case "text/vtt": return "vtt";
    default: return undefined;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function importMedia(ctx: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const { editor } = ctx;
  validateUnknownKeys(args, importMediaAllowedKeys, "import_media");
  const source = args.source;
  if (!isRecord(source)) throw new ToolError("Missing required 'source' object");
  validateUnknownKeys(source, importSourceAllowedKeys, "source");

  const urlStr = argString(source, "url");
  const pathStr = argString(source, "path");
  const bytesStr = argString(source, "bytes");
  const matte = isRecord(source.matte) ? source.matte : undefined;
  const mimeType = argString(source, "mimeType");

  const setCount = [urlStr, pathStr, bytesStr].filter((v) => v !== undefined).length + (matte === undefined ? 0 : 1);
  if (setCount !== 1) throw new ToolError(`source must set exactly one of 'url', 'path', 'bytes', or 'matte' (got ${setCount})`);

  const folderId = resolveFolder(editor, args);
  const providedName = argString(args, "name");

  if (pathStr !== undefined) return importFromPath(editor, pathStr, providedName, folderId);
  if (bytesStr !== undefined) {
    if (mimeType === undefined) throw new ToolError("source.mimeType is required when source.bytes is set");
    return importFromBytes(editor, bytesStr, mimeType, providedName, folderId);
  }
  if (matte !== undefined) return importMatte(editor, matte, providedName, folderId);
  if (urlStr !== undefined) return importFromURL(editor, urlStr, mimeType, providedName, folderId);
  throw new ToolError("unreachable");
}

/** One undo step that adds a not-yet-finalized asset to the library (`undo.perform` around `addMediaAsset`). */
function registerImportedAsset(editor: Editor, asset: MediaAsset): void {
  editor.perform(undoName, () => {
    editor.doc.mediaAssets.push(asset);
    editor.doc.mediaManifest.entries.push(manifestEntryFor(editor, asset));
  });
}

function newAsset(path: string, type: ClipType, name: string | undefined, folderId: string | undefined): MediaAsset {
  const asset = makeMediaAsset({ url: path, type, name: name ?? fileStem(path) });
  if (folderId !== undefined) asset.folderId = folderId;
  return asset;
}

function readyResult(asset: MediaAsset): ToolResult {
  return ok(jsonString({ mediaRef: asset.id, name: asset.name, type: asset.type, status: "ready" }));
}

async function importFromPath(editor: Editor, path: string, name: string | undefined, folderId: string | undefined): Promise<ToolResult> {
  const io = await mediaIo();
  const stat = await io.stat(path);
  if (stat === null) throw new ToolError(`File not found: ${path}`);
  if (stat.isDir) {
    const summary = await importFinderItems(editor, [path], folderId);
    if (summary.assetCount <= 0) throw new ToolError(`No supported media found in folder: ${path}`);
    return ok(
      jsonString({
        status: "ready",
        imported: summary.assetCount,
        folders: summary.folderCount,
        note: `Imported from '${lastPathComponent(path)}', mirroring its structure. See get_media.`,
      }),
    );
  }
  const ext = pathExtension(path).toLowerCase();
  const type = clipTypeForPath(path);
  if (type === undefined) {
    throw new ToolError(`Unsupported file extension '.${ext}'. Supported: mov/mp4/m4v, mp3/wav/aac/m4a/aiff/aifc/caf/flac, png/jpg/jpeg/tiff/heic, json (Lottie), srt/vtt (subtitles).`);
  }
  if (type === "lottie" && !isLottieHeader(path, await io.readHead(path, lottieSniffByteLimit).catch(() => new Uint8Array(0)))) {
    throw new ToolError(`Unsupported Lottie file: ${lastPathComponent(path)}`);
  }
  if (editor.projectPath === null) throw new ToolError("No project is open; cannot import from path");

  const asset = newAsset(path, type, name, folderId);
  registerImportedAsset(editor, asset);
  const finalized = await finalizeImportedAsset(editor, asset.id);
  generationHooks.checkpointRequired?.(editor);
  if (!finalized) throw new ToolError(`Could not read media file: ${lastPathComponent(path)}`);
  return ok(jsonString({ mediaRef: asset.id, name: editor.mediaAsset(asset.id)?.name ?? asset.name, type, status: "ready" }));
}

function decodeBase64(base64: string): Uint8Array | undefined {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(cleaned);
    if (binary.length === 0) return undefined;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function importFromBytes(
  editor: Editor, base64: string, mimeType: string, name: string | undefined, folderId: string | undefined,
): Promise<ToolResult> {
  const size = new TextEncoder().encode(base64).length;
  if (size > importBytesMaxBase64Length) {
    throw new ToolError(`source.bytes is too large (${size} chars; max ${importBytesMaxBase64Length}). Use source.url or source.path for larger files.`);
  }
  if (editor.projectPath === null) throw new ToolError("No project is open; cannot import bytes");

  const fileExt = fileExtensionForMime(mimeType);
  if (fileExt === undefined) throw new ToolError(`Unsupported mimeType '${mimeType}'. ${acceptedMimeTypesMessage}`);
  const data = decodeBase64(base64);
  if (!data) throw new ToolError("source.bytes is not valid non-empty base64");
  const filename = `imported-${newId().slice(0, 8)}.${fileExt}`;
  const type = clipTypeFromFileExtension(fileExt);
  if (type === undefined) throw new ToolError(`Unsupported mimeType '${mimeType}'. ${acceptedMimeTypesMessage}`);
  if (type === "lottie" && !isLottieHeader(filename, data.subarray(0, lottieSniffByteLimit))) {
    throw new ToolError("source.bytes is not a valid Lottie animation");
  }

  const io = await mediaIo();
  const tempDir = await io.tempDir();
  const staged = joinPath(tempDir, `palmier-stage-${newId()}.${fileExt}`);
  try {
    await io.mkdir(tempDir);
    await io.writeBytes(staged, data);
  } catch (e) {
    throw new ToolError(`Failed to write bytes to disk: ${errorMessage(e)}`);
  }
  const committed = await commitStagedProjectMedia(editor, staged, filename);
  const asset = newAsset(committed, type, name, folderId);
  registerImportedAsset(editor, asset);
  void finalizeImportedAsset(editor, asset.id);
  return readyResult(asset);
}

function importFromURL(
  editor: Editor, urlString: string, mimeOverride: string | undefined, name: string | undefined, folderId: string | undefined,
): ToolResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ToolError("source.url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ToolError("source.url must use https");
  if (url.username !== "" || url.password !== "") throw new ToolError("source.url must not embed credentials");
  if (url.hostname === "") throw new ToolError("source.url has no host");

  let fileExt: string;
  if (mimeOverride !== undefined) {
    const mapped = fileExtensionForMime(mimeOverride);
    if (mapped === undefined) throw new ToolError(`Unsupported mimeType '${mimeOverride}'. ${acceptedMimeTypesMessage}`);
    fileExt = mapped;
  } else {
    const urlExt = pathExtension(url.pathname).toLowerCase();
    if (urlExt === "" || clipTypeFromFileExtension(urlExt) === undefined) {
      const shown = urlExt === "" ? "(none)" : `.${urlExt}`;
      throw new ToolError(`Cannot infer media type from URL extension ${shown}. Set source.mimeType to disambiguate (e.g. 'video/mp4', 'image/png').`);
    }
    fileExt = urlExt;
  }
  const type = clipTypeFromFileExtension(fileExt);
  if (type === undefined) throw new ToolError(`Unsupported file extension '.${fileExt}'`);

  const projectPath = editor.projectPath;
  if (projectPath === null) throw new ToolError("No project is open; cannot import from URL");

  let stem: string;
  try {
    stem = fileStem(decodeURIComponent(url.pathname));
  } catch {
    stem = fileStem(url.pathname);
  }
  const displayName = name ?? (stem === "" ? "Imported asset" : stem);

  const id = newId();
  const placeholder = makeMediaAsset({ id, url: joinPath(joinPath(projectPath, "media"), `imported-${id.slice(0, 8)}.${fileExt}`), type, name: displayName });
  if (folderId !== undefined) placeholder.folderId = folderId;
  placeholder.importInput = { sourceURL: url.href, createdAt: swiftDateNow() };
  placeholder.generationStatus = { kind: "downloading" };
  importMediaAsset(editor, placeholder);
  generationHooks.checkpointRequired?.(editor);

  void downloadImportedAsset(editor, placeholder.id, url.href, lastPathComponent(placeholder.url));

  return ok(
    jsonString({
      mediaRef: id,
      type,
      status: "downloading",
      note: `Downloading in the background. Poll get_media with ids:["${id}"] until generationStatus clears.`,
    }),
  );
}

async function downloadImportedAsset(editor: Editor, assetId: string, remoteURL: string, filename: string): Promise<void> {
  try {
    const io = await mediaIo();
    const tempDir = await io.tempDir();
    await io.mkdir(tempDir);
    const staged = joinPath(tempDir, `palmier-stage-${newId()}.${pathExtension(filename)}`);
    const requestId = newId();
    let exceeded = false;
    const guard = (received: number, total: number | null): void => {
      if (exceeded || ((total === null || total <= remoteImportMaxBytes) && received <= remoteImportMaxBytes)) return;
      exceeded = true;
      void importDeps.cancel(requestId);
    };
    try {
      await importDeps.download(remoteURL, staged, requestId, guard);
    } catch (e) {
      await io.remove(staged).catch(() => undefined);
      throw exceeded ? new ToolError(`file exceeds the ${remoteImportMaxBytes}-byte import limit`) : e;
    }
    const dest = await commitStagedProjectMedia(editor, staged, filename, { maxBytes: remoteImportMaxBytes });
    editor.withoutRegistration(() => {
      const asset = editor.doc.mediaAssets.find((a) => a.id === assetId);
      if (asset) asset.url = dest;
    });
    const finalized = await finalizeImportedAsset(editor, assetId);
    if (finalized) {
      editor.withoutRegistration(() => {
        const asset = editor.doc.mediaAssets.find((a) => a.id === assetId);
        if (asset) delete asset.importInput;
      });
      const asset = editor.mediaAsset(assetId);
      if (asset) updateManifestMetadata(editor, [asset]);
    }
  } catch (e) {
    editor.withoutRegistration(() => {
      const asset = editor.doc.mediaAssets.find((a) => a.id === assetId);
      if (asset) asset.generationStatus = { kind: "failed", message: errorMessage(e) };
    });
    const asset = editor.mediaAsset(assetId);
    if (asset) updateManifestMetadata(editor, [asset]);
  }
  generationHooks.checkpointRequired?.(editor);
}

async function importMatte(
  editor: Editor, matte: Record<string, unknown>, name: string | undefined, folderId: string | undefined,
): Promise<ToolResult> {
  validateUnknownKeys(matte, ["hex", "aspectRatio"], "source.matte");
  const hex = argString(matte, "hex")?.trim();
  if (hex === undefined || hex === "") throw new ToolError("source.matte requires 'hex'.");
  let aspect: MatteAspect | undefined;
  const raw = argString(matte, "aspectRatio");
  if (raw !== undefined) {
    aspect = matteAspectParse(raw);
    if (aspect === undefined) throw new ToolError(`source.matte: unknown aspectRatio '${raw}'. Use one of ${matteAspects.join(", ")}.`);
  }
  let asset: MediaAsset;
  try {
    asset = await createMatte(editor, {
      hex,
      ...(aspect !== undefined ? { aspect } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      ...(name !== undefined ? { name } : {}),
    });
  } catch (e) {
    throw new ToolError(errorMessage(e));
  }
  return readyResult(asset);
}
