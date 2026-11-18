import { swiftRound } from "../util/math";

/*
 * Port of ExportOptions.swift for the WebCodecs pipeline. Not mappable and therefore absent: ProRes (`prores`), which
 * WebCodecs cannot encode. Added for Windows: VP9 in WebM, and 10-bit HDR as HEVC Main10 (`hevcHDR`, like the Swift) or
 * VP9 profile 2. The HDR codecs are only offered when the runtime can encode them (see hdrExport.ts).
 */

export type ExportFormat = "h264" | "h265" | "vp9" | "hevcHDR" | "vp9HDR" | "xml" | "fcpxml";

export function exportFormatFileExtension(format: ExportFormat): string {
  switch (format) {
    case "h264":
    case "h265":
    case "hevcHDR": return "mp4";
    case "vp9":
    case "vp9HDR": return "webm";
    case "xml": return "xml";
    case "fcpxml": return "fcpxml";
  }
}

export function exportFormatDisplayName(format: ExportFormat): string {
  switch (format) {
    case "xml": return "XML";
    case "fcpxml": return "FCPXML";
    default: return videoCodecFromFormat(format) ?? "Video";
  }
}

export type ExportResolution = "720p" | "1080p" | "2K" | "4K" | "Match Timeline";

export const exportResolutions: readonly ExportResolution[] = ["720p", "1080p", "2K", "4K", "Match Timeline"];

export function exportResolutionTitle(r: ExportResolution): string {
  return r;
}

export function exportResolutionShortSidePixels(r: ExportResolution): number | undefined {
  switch (r) {
    case "720p": return 720;
    case "1080p": return 1080;
    case "2K": return 1440;
    case "4K": return 2160;
    case "Match Timeline": return undefined;
  }
}

export interface RenderSize {
  width: number;
  height: number;
}

function evenSize(size: RenderSize): RenderSize {
  const w = Math.trunc(swiftRound(size.width) / 2) * 2;
  const h = Math.trunc(swiftRound(size.height) / 2) * 2;
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

export function exportResolutionRenderSize(r: ExportResolution, canvas: RenderSize): RenderSize {
  const shortSide = exportResolutionShortSidePixels(r);
  if (shortSide === undefined) return evenSize(canvas);
  const canvasShort = Math.min(canvas.width, canvas.height);
  if (!(canvasShort > 0)) return canvas;
  const scale = shortSide / canvasShort;
  return evenSize({ width: canvas.width * scale, height: canvas.height * scale });
}

export type VideoCodec = "H.264" | "H.265" | "VP9" | "HEVC 10-bit HDR" | "VP9 10-bit HDR";

export const videoCodecs: readonly VideoCodec[] = ["H.264", "H.265", "VP9", "HEVC 10-bit HDR", "VP9 10-bit HDR"];

export function videoCodecIsHDR(c: VideoCodec): boolean {
  return c === "HEVC 10-bit HDR" || c === "VP9 10-bit HDR";
}

export function videoCodecContainerLabel(c: VideoCodec): string {
  return videoCodecContainer(c) === "webm" ? "WebM (.webm)" : "MPEG-4 (.mp4)";
}

export function videoCodecExportFormat(c: VideoCodec): ExportFormat {
  switch (c) {
    case "H.264": return "h264";
    case "H.265": return "h265";
    case "VP9": return "vp9";
    case "HEVC 10-bit HDR": return "hevcHDR";
    case "VP9 10-bit HDR": return "vp9HDR";
  }
}

export function videoCodecFromFormat(format: ExportFormat): VideoCodec | undefined {
  switch (format) {
    case "h264": return "H.264";
    case "h265": return "H.265";
    case "vp9": return "VP9";
    case "hevcHDR": return "HEVC 10-bit HDR";
    case "vp9HDR": return "VP9 10-bit HDR";
    case "xml":
    case "fcpxml": return undefined;
  }
}

/** mediabunny codec ids. */
export function videoCodecMediabunnyId(c: VideoCodec): "avc" | "hevc" | "vp9" {
  switch (c) {
    case "H.264": return "avc";
    case "H.265":
    case "HEVC 10-bit HDR": return "hevc";
    case "VP9":
    case "VP9 10-bit HDR": return "vp9";
  }
}

export type ExportContainer = "mp4" | "webm";

export function videoCodecContainer(c: VideoCodec): ExportContainer {
  return videoCodecMediabunnyId(c) === "vp9" ? "webm" : "mp4";
}

/** Bytes per second per megapixel: the Swift file-size estimate, reused as the target bitrate. */
export function videoCodecBytesPerSecPerMegapixel(c: VideoCodec): number {
  switch (c) {
    case "H.264": return 0.63e6;
    case "H.265": return 0.32e6;
    case "VP9": return 0.4e6;
    // 10-bit needs about a quarter more bits than the 8-bit codec it is based on.
    case "HEVC 10-bit HDR": return 0.4e6;
    case "VP9 10-bit HDR": return 0.5e6;
  }
}

export function exportTargetVideoBitrate(c: VideoCodec, size: RenderSize): number {
  const megapixels = (size.width * size.height) / 1_000_000;
  return Math.round(videoCodecBytesPerSecPerMegapixel(c) * Math.max(0.1, megapixels) * 8);
}

export const exportAudioBitrate = 192_000;

export interface FileSizeEstimateInput {
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
}

/** `ExportView.estimatedFileSize`, in bytes. */
export function exportEstimatedFileBytes(codec: VideoCodec, resolution: ExportResolution, t: FileSizeEstimateInput): number {
  const seconds = t.totalFrames / Math.max(1, t.fps);
  const out = exportResolutionRenderSize(resolution, { width: t.width, height: t.height });
  const megapixels = (out.width * out.height) / 1_000_000;
  const bytesPerSec = videoCodecBytesPerSecPerMegapixel(codec) * Math.max(0.1, megapixels);
  return Math.trunc(bytesPerSec * seconds);
}

/** ByteCountFormatter `.file` style (decimal units). */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "Zero KB";
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  return `${text} ${units[unit] as string}`;
}

/** Inclusive-start, exclusive-end frame range of the timeline to render. */
export interface ExportRange {
  startFrame: number;
  endFrame: number;
}

/** Transfer function of an HDR export; HLG is the default like the Swift HDRVideoExporter. */
export type HdrTransfer = "hlg" | "pq";

export const hdrTransfers: readonly HdrTransfer[] = ["hlg", "pq"];

export const hdrTransferDefault: HdrTransfer = "hlg";

export function hdrTransferDisplayName(t: HdrTransfer): string {
  return t === "hlg" ? "HLG" : "PQ (HDR10)";
}

export interface VideoExportOptions {
  codec: VideoCodec;
  resolution: ExportResolution;
  /** HDR codecs only; defaults to HLG. */
  hdrTransfer?: HdrTransfer;
  /** Defaults to the whole timeline. */
  range?: ExportRange;
  /** Mix and encode the audio tracks (default true). */
  includeAudio?: boolean;
  /** Encode only the mixed audio (no video track, no video decode): used by Save as Audio / Extract Audio. */
  audioOnly?: boolean;
}

export interface ExportValidation {
  ok: boolean;
  /** Fatal reason, actionable. */
  error?: string;
}

/** Validates options against the timeline before any work starts. */
export function validateVideoExport(
  options: VideoExportOptions,
  timeline: { width: number; height: number; fps: number; totalFrames: number },
): ExportValidation {
  if (!(timeline.fps > 0) || !(timeline.width > 0) || !(timeline.height > 0)) {
    return { ok: false, error: "The timeline has an invalid size or frame rate." };
  }
  if (!(timeline.totalFrames > 0)) return { ok: false, error: "The timeline is empty. Add clips before exporting." };
  if (options.hdrTransfer !== undefined && !videoCodecIsHDR(options.codec)) {
    return { ok: false, error: `${options.codec} is not an HDR codec, so it has no HDR transfer function.` };
  }
  const r = options.range;
  if (r !== undefined) {
    if (!(Number.isInteger(r.startFrame) && Number.isInteger(r.endFrame)) || r.startFrame < 0 || r.endFrame <= r.startFrame) {
      return { ok: false, error: "The export range is empty." };
    }
    if (r.startFrame >= timeline.totalFrames) return { ok: false, error: "The export range starts after the end of the timeline." };
  }
  return { ok: true };
}

/** The frames actually rendered: the range clamped to the timeline. */
export function resolveExportRange(options: Pick<VideoExportOptions, "range">, totalFrames: number): ExportRange {
  const r = options.range;
  if (!r) return { startFrame: 0, endFrame: totalFrames };
  return { startFrame: Math.max(0, r.startFrame), endFrame: Math.min(totalFrames, r.endFrame) };
}
