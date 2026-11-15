import { ALL_FORMATS, AudioSampleSink, Input, UrlSource } from "mediabunny";
import { throwIfAborted, yieldToUi } from "../media/concurrency";
import { mediaUrl } from "../media/mediaUrl";

export class NoAudioError extends Error {
  constructor(name: string) {
    super(`No audio track in ${name}`);
    this.name = "NoAudioError";
  }
}

export interface AudioChunk {
  /** One plane per channel (at most `maxChannels`); a mono source yields one plane. */
  planes: Float32Array[];
  sampleRate: number;
}

const sliceBudgetMs = 8;

/**
 * Streams the first audio track as planar float chunks (`AudioTrackReader.read`), yielding to the UI between slices.
 * `source` is a media path (converted with the asset protocol) or, outside Tauri, a fetchable URL.
 */
export async function readAudioChunks(
  source: string,
  maxChannels: number,
  signal: AbortSignal | undefined,
  onChunk: (chunk: AudioChunk) => void | Promise<void>,
): Promise<{ channels: number; sampleRate: number }> {
  const input = new Input({ source: new UrlSource(mediaUrl(source)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new NoAudioError(source);
    if (!(await track.canDecode())) throw new Error(`Audio codec not decodable in ${source}`);
    const channels = Math.min(maxChannels, Math.max(1, track.numberOfChannels));
    let sliceStart = performance.now();
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        throwIfAborted(signal);
        const planes: Float32Array[] = [];
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(sample.numberOfFrames);
          sample.copyTo(plane, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: "f32-planar" });
          planes.push(plane);
        }
        await onChunk({ planes, sampleRate: sample.sampleRate });
      } finally {
        sample.close();
      }
      if (performance.now() - sliceStart > sliceBudgetMs) {
        await yieldToUi();
        sliceStart = performance.now();
      }
    }
    return { channels, sampleRate: track.sampleRate };
  } finally {
    input.dispose();
  }
}

/** Channel average of planar audio (`AudioTrackReader` mono mix). */
export function mixDown(planes: readonly Float32Array[]): Float32Array {
  const first = planes[0] as Float32Array;
  if (planes.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const plane of planes) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (plane[i] as number);
  const k = 1 / planes.length;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * k;
  return out;
}
