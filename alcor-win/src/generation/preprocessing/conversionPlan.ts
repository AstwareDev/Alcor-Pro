// Pure decisions behind VideoPreprocessor / ImageConverter / VideoTrimExtractor (no DOM, no I/O).
import { pathExtension } from "../../media/paths";

export interface SourceVideoLimits {
  maxLongSide?: number;
  maxShortSide?: number;
  requiredEncoding?: "h264-mp4";
}

export interface VideoFacts {
  /** Display size with rotation applied. */
  width: number;
  height: number;
  videoCodec: string | null | undefined;
  path: string;
}

export const resolutionLimits: Record<"720p" | "1080p" | "4k", { long: number; short: number }> = {
  "720p": { long: 1280, short: 720 },
  "1080p": { long: 1920, short: 1080 },
  "4k": { long: 3840, short: 2160 },
};

export function isH264MP4(facts: Pick<VideoFacts, "path" | "videoCodec">): boolean {
  return pathExtension(facts.path).toLowerCase() === "mp4" && facts.videoCodec === "avc";
}

export type VideoExportPlan = { needed: false } | { needed: true; renderSize?: { width: number; height: number } };

/** `VideoPreprocessor.exportIfNeeded`'s decision and render-size maths. */
export function planVideoExport(facts: VideoFacts, limits: SourceVideoLimits): VideoExportPlan {
  const longSide = Math.max(Math.abs(facts.width), Math.abs(facts.height));
  const shortSide = Math.min(Math.abs(facts.width), Math.abs(facts.height));
  const exceeds =
    (limits.maxLongSide !== undefined && longSide > limits.maxLongSide) ||
    (limits.maxShortSide !== undefined && shortSide > limits.maxShortSide);
  const requiresEncoding = limits.requiredEncoding === "h264-mp4" && !isH264MP4(facts);
  if (!exceeds && !requiresEncoding) return { needed: false };
  if (!exceeds || limits.maxLongSide === undefined) return { needed: true };
  const scale = Math.min(limits.maxLongSide / longSide, (limits.maxShortSide ?? limits.maxLongSide) / shortSide);
  return {
    needed: true,
    renderSize: {
      width: Math.max(2, Math.floor((Math.abs(facts.width) * scale) / 2) * 2),
      height: Math.max(2, Math.floor((Math.abs(facts.height) * scale) / 2) * 2),
    },
  };
}

/** `ImageConverter.requiresConversion` */
export function imageRequiresConversion(path: string): boolean {
  return ["heic", "heif", "tiff"].includes(pathExtension(path).toLowerCase());
}

/** `GenerationService.contentType(for:fallback:)` */
export function contentTypeForPath(path: string, fallback: "image" | "video" | "audio" | "other"): string {
  switch (pathExtension(path).toLowerCase()) {
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "gif": return "image/gif";
    case "mp4": case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "m4a": return "audio/mp4";
    case "aiff": case "aif": case "aifc": return "audio/aiff";
    case "caf": return "audio/x-caf";
    case "flac": return "audio/flac";
    default:
      switch (fallback) {
        case "image": return "image/jpeg";
        case "video": return "video/mp4";
        case "audio": return "audio/mpeg";
        case "other": return "application/octet-stream";
      }
  }
}
