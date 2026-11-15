// WebCodecs/mediabunny side of the preprocessors: one thin function that re-encodes/trims a file into a temp file.
// Output bytes stream through the Rust positional writer (`exportFile*`), never through JS arrays.
import {
  ALL_FORMATS, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, WavOutputFormat, type StreamTargetChunk,
} from "mediabunny";
import { joinPath } from "../../model";
import { mediaIo } from "../../media/io";
import { mediaUrl } from "../../media/mediaUrl";
import { exportFileAbort, exportFileFinish, exportFileOpen, exportFileWrite } from "../../platform/backend";
import { newId } from "../../util/id";

export class ConversionError extends Error {}

export interface ConvertSpec {
  inputPath: string;
  container: "mp4" | "m4a" | "wav";
  /** Seconds into the source. */
  trim?: { start: number; end: number };
  /** Output display size; omit to keep the source size. */
  size?: { width: number; height: number };
  frameRate?: number;
  /** Drop the video track (audio extraction). */
  audioOnly?: boolean;
  /** Re-encode to H.264/AAC (mp4). */
  h264?: boolean;
}

export async function tempFilePath(extension: string, prefix: string): Promise<string> {
  const io = await mediaIo();
  const dir = await io.tempDir();
  await io.mkdir(dir);
  return joinPath(dir, `${prefix}-${newId()}.${extension}`);
}

export async function removeTempFiles(paths: readonly string[]): Promise<void> {
  const io = await mediaIo();
  await Promise.all(paths.map((p) => io.remove(p).catch(() => undefined)));
}

/** Converts into a new temp file and returns its path. The caller owns (and removes) it. */
export async function convertToTempFile(spec: ConvertSpec, prefix: string, signal?: AbortSignal): Promise<string> {
  const outputPath = await tempFilePath(spec.container, prefix);
  const handle = await exportFileOpen(outputPath);
  const input = new Input({ source: new UrlSource(mediaUrl(spec.inputPath)), formats: ALL_FORMATS });
  try {
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => exportFileWrite(handle, chunk.position, chunk.data.slice()),
    });
    const format = spec.container === "wav" ? new WavOutputFormat() : new Mp4OutputFormat({ fastStart: false });
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
    const conversion = await Conversion.init({
      input,
      output,
      ...(spec.trim ? { trim: spec.trim } : {}),
      video: spec.audioOnly
        ? { discard: true }
        : {
            ...(spec.size ? { width: spec.size.width, height: spec.size.height, fit: "fill" as const } : {}),
            ...(spec.frameRate ? { frameRate: spec.frameRate } : {}),
            ...(spec.h264 ? { codec: "avc" as const } : {}),
          },
      audio: spec.container === "wav" ? { codec: "pcm-s16" } : spec.h264 || spec.container === "m4a" ? { codec: "aac" } : {},
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((t) => t.reason).join(", ");
      throw new ConversionError(`nothing to convert${reasons ? ` (${reasons})` : ""}`);
    }
    signal?.addEventListener("abort", () => void conversion.cancel(), { once: true });
    await conversion.execute();
    signal?.throwIfAborted();
    await exportFileFinish(handle);
    return outputPath;
  } catch (e) {
    await exportFileAbort(handle).catch(() => undefined);
    await removeTempFiles([outputPath]);
    throw e;
  } finally {
    input.dispose();
  }
}
