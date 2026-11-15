import { ALL_FORMATS, Input, UrlSource, type InputVideoTrack } from "mediabunny";
import { Defaults, type ClipType } from "../model";
import { AsyncSemaphore, throwIfAborted } from "./concurrency";
import { mediaIo } from "./io";
import { mediaHooks } from "./mediaHooks";
import { mediaUrl } from "./mediaUrl";
import { clipTypeForPath, parseLottieJson } from "./mediaTypes";

export interface MediaProbe {
  /** `MediaAsset.loadMetadata`'s result: false means the file is unreadable / unusable for this kind. */
  ok: boolean;
  /** Undefined only when the extension is not a supported media type. */
  kind: ClipType | undefined;
  duration?: number;
  /** Display size with rotation applied. */
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string | null;
  audioCodec?: string | null;
  /** WebCodecs can decode every stream this kind needs; false flags "unprocessable" media. */
  canDecode: boolean;
  reason?: string;
}

const metadataLoadGate = new AsyncSemaphore(4);

export interface ProbeOptions {
  /** Defaults to the type implied by the file extension. */
  type?: ClipType;
  signal?: AbortSignal;
}

export async function probeMedia(path: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const kind = options.type ?? clipTypeForPath(path);
  if (kind === undefined) return failure(undefined, "unsupported file type");
  return metadataLoadGate.run(async () => {
    throwIfAborted(options.signal);
    try {
      switch (kind) {
        case "image": return await probeImage(path);
        case "lottie": return await probeLottie(path);
        case "subtitle": return await probeSubtitle(path);
        case "video": return await probeVideo(path);
        case "audio": return await probeAudio(path);
        default: return { ok: true, kind, hasAudio: false, hasVideo: false, canDecode: true };
      }
    } catch (e) {
      throwIfAborted(options.signal);
      return failure(kind, e instanceof Error ? e.message : String(e));
    }
  }, options.signal);
}

function failure(kind: ClipType | undefined, reason: string): MediaProbe {
  return { ok: false, kind, hasAudio: false, hasVideo: false, canDecode: false, reason };
}

async function probeImage(path: string): Promise<MediaProbe> {
  const res = await fetch(mediaUrl(path));
  if (!res.ok) return { ...failure("image", `HTTP ${res.status}`), duration: Defaults.imageDurationSeconds };
  const bitmap = await createImageBitmap(await res.blob(), { imageOrientation: "from-image" });
  const { width, height } = bitmap;
  bitmap.close();
  const ok = width > 0 && height > 0;
  return {
    ok, kind: "image", duration: Defaults.imageDurationSeconds, width, height,
    hasAudio: false, hasVideo: true, canDecode: ok,
  };
}

async function probeLottie(path: string): Promise<MediaProbe> {
  let meta = await mediaHooks.inspectLottie?.(path);
  if (!meta) {
    const bytes = await (await mediaIo()).readAll(path);
    meta = parseLottieJson(new TextDecoder().decode(bytes));
  }
  if (!meta) return failure("lottie", "not a readable Lottie animation");
  return {
    ok: true, kind: "lottie", duration: meta.duration, width: meta.width, height: meta.height,
    fps: meta.framerate, hasAudio: false, hasVideo: true, canDecode: true,
  };
}

async function probeSubtitle(path: string): Promise<MediaProbe> {
  const parse = mediaHooks.parseSubtitleDuration;
  const duration = parse ? await parse(path) : 0;
  if (duration === undefined) return failure("subtitle", "could not parse subtitle file");
  return { ok: true, kind: "subtitle", duration, hasAudio: false, hasVideo: false, canDecode: true };
}

function openInput(path: string): Input<UrlSource> {
  return new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
}

async function displaySize(track: InputVideoTrack): Promise<{ width: number; height: number }> {
  const [w, h, rotation] = [await track.getCodedWidth(), await track.getCodedHeight(), await track.getRotation()];
  return rotation === 90 || rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

async function probeVideo(path: string): Promise<MediaProbe> {
  const input = openInput(path);
  try {
    const video = await input.getPrimaryVideoTrack();
    const audioTracks = await input.getAudioTracks();
    const audio = audioTracks[0] ?? null;
    const probe: MediaProbe = {
      ok: video !== null, kind: "video", hasAudio: audioTracks.length > 0, hasVideo: video !== null,
      canDecode: false, audioCodec: audio ? await audio.getCodec() : null,
    };
    if (!video) {
      probe.duration = await input.computeDuration();
      probe.reason = "no video track";
      return probe;
    }
    Object.assign(probe, await displaySize(video));
    probe.videoCodec = await video.getCodec();
    try {
      const metrics = await video.computeFrameRateMetrics();
      if (metrics.bestGuessFrameRate > 0) probe.fps = metrics.bestGuessFrameRate;
    } catch {
      // fps stays unknown, like a track with nominalFrameRate 0
    }
    const [first, end] = [await video.getFirstTimestamp(), await video.computeDuration()];
    probe.duration = Math.max(0, end - first);
    const decodable = await video.canDecode();
    const audioDecodable = audio ? await audio.canDecode() : true;
    probe.canDecode = decodable && audioDecodable;
    if (!decodable) probe.reason = "video codec not decodable";
    else if (!audioDecodable) probe.reason = "audio codec not decodable";
    return probe;
  } finally {
    input.dispose();
  }
}

async function probeAudio(path: string): Promise<MediaProbe> {
  const input = openInput(path);
  try {
    const audio = await input.getPrimaryAudioTrack();
    const probe: MediaProbe = {
      ok: audio !== null, kind: "audio", hasAudio: audio !== null, hasVideo: false,
      canDecode: false, audioCodec: audio ? await audio.getCodec() : null,
      duration: await input.computeDuration(),
    };
    if (!audio) {
      probe.reason = "no audio track";
      return probe;
    }
    probe.canDecode = await audio.canDecode();
    if (!probe.canDecode) probe.reason = "audio codec not decodable";
    return probe;
  } finally {
    input.dispose();
  }
}
