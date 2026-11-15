// Ports of VideoPreprocessor, VideoTrimExtractor, AudioTrackExtractor and ImageConverter on mediabunny + Canvas.
// Each returns a temp file path owned by the caller (or null when no work was needed).
import { mediaIo } from "../../media/io";
import { mediaUrl } from "../../media/mediaUrl";
import { probeMedia } from "../../media/probe";
import { trimmedSourceTimeRange, type TrimmedSource } from "../trimmedSource";
import { planVideoExport, resolutionLimits, type SourceVideoLimits } from "./conversionPlan";
import { ConversionError, convertToTempFile, tempFilePath } from "./mediaConvert";

export type SourceVideoResolution = keyof typeof resolutionLimits;
export type SourceVideoEncoding = "h264-mp4";

async function exportIfNeeded(path: string, limits: SourceVideoLimits, signal?: AbortSignal): Promise<string | null> {
  const probe = await probeMedia(path, { type: "video", signal });
  if (!probe.ok || !probe.hasVideo || probe.width === undefined || probe.height === undefined) return null;
  const plan = planVideoExport({ width: probe.width, height: probe.height, videoCodec: probe.videoCodec, path }, limits);
  if (!plan.needed) return null;
  try {
    return await convertToTempFile(
      { inputPath: path, container: "mp4", h264: true, ...(plan.renderSize ? { size: plan.renderSize } : {}) },
      "video",
      signal,
    );
  } catch (e) {
    throw new ConversionError(`Video compression failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `VideoPreprocessor.downscaleIfNeeded` (reference videos). */
export function downscaleIfNeeded(path: string, maxLongSide = 1100, signal?: AbortSignal): Promise<string | null> {
  return exportIfNeeded(path, { maxLongSide }, signal);
}

/** `VideoPreprocessor.transcodeIfNeeded` (source videos). */
export function transcodeIfNeeded(
  path: string,
  maxResolution: SourceVideoResolution | undefined,
  requiredEncoding: SourceVideoEncoding | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const limits: SourceVideoLimits = { ...(requiredEncoding ? { requiredEncoding } : {}) };
  if (maxResolution) {
    limits.maxLongSide = resolutionLimits[maxResolution].long;
    limits.maxShortSide = resolutionLimits[maxResolution].short;
  }
  return exportIfNeeded(path, limits, signal);
}

/** `VideoTrimExtractor.extract`: the visible range of a clip as a temp mp4. */
export async function extractVideoTrim(trim: TrimmedSource, signal?: AbortSignal): Promise<string> {
  if (!(trim.fps > 0)) throw new ConversionError(`Trim extraction failed: invalid fps ${trim.fps}`);
  if (!(trim.sourceFramesConsumed > 0)) throw new ConversionError("Trim extraction failed: empty range");
  const range = trimmedSourceTimeRange(trim);
  const probe = await probeMedia(trim.sourceURL, { type: "video", signal });
  // Pin the output rate: only plain 24...60 fps sources keep theirs, like the Swift export.
  const nominal = probe.fps ?? 0;
  const frameRate = nominal >= 24 && nominal <= 60 ? Math.round(nominal) : 30;
  try {
    return await convertToTempFile(
      { inputPath: trim.sourceURL, container: "mp4", h264: true, frameRate, trim: { start: range.start, end: range.start + range.duration } },
      "trim",
      signal,
    );
  } catch (e) {
    throw new ConversionError(`Trim extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `AudioTrackExtractor.extract`: M4A (AAC) with a WAV fallback when AAC cannot be encoded. */
export async function extractAudioTrack(sourcePath: string, trim?: TrimmedSource, signal?: AbortSignal): Promise<string> {
  const range = trim ? trimmedSourceTimeRange(trim) : undefined;
  const base = { inputPath: sourcePath, audioOnly: true, ...(range ? { trim: { start: range.start, end: range.start + range.duration } } : {}) };
  try {
    return await convertToTempFile({ ...base, container: "m4a" }, "audio", signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    try {
      return await convertToTempFile({ ...base, container: "wav" }, "audio", signal);
    } catch (e2) {
      throw new ConversionError(`Audio extraction failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}

/** `ImageConverter.convertToJPEG` at quality 0.92. */
export async function convertImageToJPEG(path: string): Promise<string> {
  const failure = () => new ConversionError(`Could not convert reference image ${path.split(/[\\/]/).pop() ?? path} to JPEG.`);
  const res = await fetch(mediaUrl(path));
  if (!res.ok) throw failure();
  const bitmap = await createImageBitmap(await res.blob(), { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) throw failure();
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw failure();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const output = await tempFilePath("jpg", "image");
    await (await mediaIo()).writeBytes(output, new Uint8Array(await blob.arrayBuffer()));
    return output;
  } finally {
    bitmap.close();
  }
}

