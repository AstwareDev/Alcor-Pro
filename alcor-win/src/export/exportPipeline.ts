import {
  AudioSample, AudioSampleSink, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output,
  WebMOutputFormat, canEncodeAudio, canEncodeVideo,
  type AudioCodec, type Target,
} from "mediabunny";
import { timelineTotalFrames, type Timeline } from "../model/timeline";
import { Compositor } from "../preview/renderer";
import { Feeder, MediaInputs, errorText } from "../preview/offlineRender";
import { buildFrameGraph, collectMediaLayers, type FrameGraphDocument, type FrameGraphOptions } from "../preview/frameGraph";
import {
  AudioMixer, collectAudioSegments, exportSampleRate, type ChunkStream, type PlanarChunk,
} from "./audioMixer";
import {
  exportAudioBitrate, exportResolutionRenderSize, exportTargetVideoBitrate, resolveExportRange, validateVideoExport,
  videoCodecContainer, videoCodecMediabunnyId,
} from "./exportOptions";
import { ExportCancelledError, ExportError, type ExportJobSpec, type ExportProgress, type ExportReport } from "./exportTypes";

export interface PipelineHooks {
  onProgress: (progress: ExportProgress) => void;
  signal: AbortSignal;
  /** True for append-only targets: the MP4 moov box goes to the end and the muxer seeks back to patch sizes. */
  streaming: boolean;
}

const keyFrameIntervalSeconds = 2;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError();
}

// MARK: - Audio decode

function toPlanar(sample: AudioSample): PlanarChunk {
  const n = sample.numberOfFrames;
  const channels = sample.numberOfChannels;
  const plane = (index: number): Float32Array => {
    const data = new Float32Array(n);
    sample.copyTo(data, { planeIndex: index, format: "f32-planar" });
    return data;
  };
  const left = plane(0);
  const right = channels > 1 ? plane(1) : left;
  const chunk = { time: sample.timestamp, sampleRate: sample.sampleRate, left, right };
  sample.close();
  return chunk;
}

async function openAudioStream(inputs: MediaInputs, mediaRef: string, startTime: number): Promise<ChunkStream | null> {
  const input = await inputs.get(mediaRef);
  const track = input ? await input.getPrimaryAudioTrack() : null;
  if (!track || !(await track.canDecode())) return null;
  const iter = new AudioSampleSink(track).samples(startTime);
  return {
    async next() {
      const r = await iter.next();
      return r.done ? null : toPlanar(r.value);
    },
    async close() {
      await iter.return(undefined);
    },
  };
}

async function pickAudioCodec(
  candidates: readonly AudioCodec[],
  supported: readonly AudioCodec[],
): Promise<AudioCodec | null> {
  for (const codec of candidates) {
    if (!supported.includes(codec)) continue;
    if (await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: exportSampleRate, bitrate: exportAudioBitrate })) return codec;
  }
  return null;
}

// MARK: - Pipeline

/** Renders `spec` into `target`. Throws ExportCancelledError on abort and ExportError for actionable failures. */
export async function runExportPipeline(spec: ExportJobSpec, target: Target, hooks: PipelineHooks): Promise<ExportReport> {
  const { signal } = hooks;
  const startedAt = performance.now();
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const timeline: Timeline | undefined = spec.timelines.find((t) => t.id === spec.timelineId);
  if (!timeline) throw new ExportError("The timeline to export no longer exists.");

  const totalTimelineFrames = timelineTotalFrames(timeline);
  const validation = validateVideoExport(spec.options, {
    width: timeline.width, height: timeline.height, fps: timeline.fps, totalFrames: totalTimelineFrames,
  });
  if (!validation.ok) throw new ExportError(validation.error ?? "Invalid export options.");

  const { codec } = spec.options;
  const { fps } = timeline;
  const range = resolveExportRange(spec.options, totalTimelineFrames);
  const totalFrames = range.endFrame - range.startFrame;
  const size = exportResolutionRenderSize(spec.options.resolution, { width: timeline.width, height: timeline.height });
  const container = videoCodecContainer(codec);
  const videoId = videoCodecMediabunnyId(codec);
  const bitrate = exportTargetVideoBitrate(codec, size);

  hooks.onProgress({ phase: "preparing", framesDone: 0, totalFrames, fraction: 0 });

  const hardware = videoId === "vp9" ? "no-preference" : "prefer-hardware";
  if (!(await canEncodeVideo(videoId, { width: size.width, height: size.height, bitrate, frameRate: fps, hardwareAcceleration: hardware }))) {
    const hint = codec === "H.265"
      ? "H.265 needs a GPU with HEVC encoding or the Windows HEVC Video Extensions. Choose H.264 instead."
      : "Try a lower resolution or another codec.";
    throw new ExportError(`This PC cannot encode ${codec} at ${size.width}×${size.height}. ${hint}`);
  }

  const doc: FrameGraphDocument = { timelines: spec.timelines, mediaAssets: spec.mediaAssets };
  const byId = new Map(spec.timelines.map((t) => [t.id, t]));
  const graphOptions: FrameGraphOptions = {
    resolveTimeline: (id) => byId.get(id),
    missingMediaRefs: new Set(spec.missingMediaRefs),
    wetMediaRefs: new Set(spec.wetMediaRefs ?? []),
  };

  const format = container === "webm"
    ? new WebMOutputFormat()
    : new Mp4OutputFormat(hooks.streaming ? { fastStart: false } : {});
  const output = new Output({ format, target });
  const inputs = new MediaInputs(spec.mediaAssets, warn);

  // Audio plan first: it decides whether an audio track exists and which codec encodes it.
  const segments = spec.options.includeAudio === false
    ? []
    : collectAudioSegments(doc, timeline.id, range.startFrame, range.endFrame, graphOptions);
  const mixer = new AudioMixer(segments, { fps, rangeStartFrame: range.startFrame }, (ref, t) => openAudioStream(inputs, ref, t));
  let audioCodec: AudioCodec | null = null;
  if (mixer.hasAudio) {
    const preferred: AudioCodec[] = container === "webm" ? ["opus"] : ["aac", "opus"];
    audioCodec = await pickAudioCodec(preferred, format.getSupportedAudioCodecs());
    if (!audioCodec) {
      throw new ExportError(
        container === "webm"
          ? "This PC cannot encode Opus audio, which WebM needs. Export as H.264 (MP4) or remove the audio tracks."
          : "This PC cannot encode AAC or Opus audio. Remove the audio tracks or update Windows media components.",
      );
    }
    if (audioCodec !== "aac" && container === "mp4") warn("AAC encoding is unavailable on this PC; the audio was encoded as Opus, which some players do not read inside MP4.");
  }

  const glCanvas = new OffscreenCanvas(size.width, size.height);
  const compositor = new Compositor(glCanvas);
  compositor.setScale(size.width / timeline.width);
  const out = compositor.outputSize(timeline.width, timeline.height);
  // Rounding can leave the compositor one pixel off an even render size; blit then.
  const blit = out.width !== size.width || out.height !== size.height;
  const encodeCanvas = blit ? new OffscreenCanvas(size.width, size.height) : glCanvas;
  const blitCtx = blit ? (encodeCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D) : null;
  glCanvas.width = out.width;
  glCanvas.height = out.height;
  const feeder = new Feeder(inputs, compositor, warn);

  const videoSource = new CanvasSource(encodeCanvas, {
    codec: videoId,
    bitrate,
    keyFrameInterval: keyFrameIntervalSeconds,
    hardwareAcceleration: hardware,
    latencyMode: "quality",
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: exportAudioBitrate }) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  const cleanup = async (): Promise<void> => {
    await feeder.close().catch(() => undefined);
    await mixer.close().catch(() => undefined);
    inputs.dispose();
    compositor.dispose();
  };

  try {
    await output.start();
    const blockFrames = Math.max(1, Math.round(fps));
    const renderStart = performance.now();
    let framesDone = 0;
    for (let blockStart = range.startFrame; blockStart < range.endFrame; blockStart += blockFrames) {
      const blockEnd = Math.min(range.endFrame, blockStart + blockFrames);
      for (let frame = blockStart; frame < blockEnd; frame++) {
        throwIfAborted(signal);
        const graph = buildFrameGraph(doc, timeline.id, frame, graphOptions);
        await feeder.prepare(collectMediaLayers(graph.layers, []));
        if (!compositor.render(graph, feeder)) throw new ExportError("The graphics context was lost while rendering. Close other GPU-heavy apps and try again.");
        if (blitCtx) blitCtx.drawImage(glCanvas, 0, 0, size.width, size.height);
        await videoSource.add((frame - range.startFrame) / fps, 1 / fps);
        framesDone += 1;
        const elapsed = (performance.now() - renderStart) / 1000;
        hooks.onProgress({
          phase: "rendering",
          framesDone,
          totalFrames,
          fraction: framesDone / totalFrames,
          ...(framesDone >= 5 ? { etaSeconds: (elapsed / framesDone) * (totalFrames - framesDone) } : {}),
        });
      }
      if (audioSource) {
        throwIfAborted(signal);
        const from = mixer.sampleIndexOfFrame(blockStart);
        const to = mixer.sampleIndexOfFrame(blockEnd);
        const [left, right] = await mixer.mix(from, to);
        const data = new Float32Array(left.length * 2);
        data.set(left, 0);
        data.set(right, left.length);
        await audioSource.add(new AudioSample({
          data, format: "f32-planar", numberOfChannels: 2, sampleRate: exportSampleRate, timestamp: from / exportSampleRate,
        }));
      }
    }
    for (const ref of mixer.failedMedia) {
      warn(`${inputs.asset(ref)?.name ?? ref} has no audio this system can decode; its audio is silent.`);
    }
    hooks.onProgress({ phase: "finalizing", framesDone: totalFrames, totalFrames, fraction: 1 });
    throwIfAborted(signal);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    await cleanup();
    if (e instanceof ExportCancelledError || e instanceof ExportError) throw e;
    if (signal.aborted) throw new ExportCancelledError();
    throw new ExportError(`Export failed: ${errorText(e)}`);
  }
  await cleanup();
  return {
    width: size.width,
    height: size.height,
    fps,
    frames: totalFrames,
    durationSeconds: totalFrames / fps,
    videoCodec: videoId,
    audioCodec,
    container,
    elapsedSeconds: (performance.now() - startedAt) / 1000,
    warnings,
  };
}
