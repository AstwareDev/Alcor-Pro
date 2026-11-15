import { clipHasSpeedRamp } from "../model/speedRamp";
import { audioEnvelopeGain, buildAudioGraph, type FrameGraphDocument, type FrameGraphOptions } from "../preview/frameGraph";

/*
 * Offline audio mix for export. A JS mixer instead of OfflineAudioContext because Web Audio does not exist in Workers
 * and a whole-timeline OfflineAudioContext buffer is unbounded. Gains come from `buildAudioGraph` per timeline frame
 * (the same envelope playback uses) and are interpolated linearly between frames, which is exact for the piecewise
 * linear envelope. Clip speed resamples (varispeed): pitch follows speed, unlike the preview's pitch-preserving elements.
 */

export const exportSampleRate = 48000;

export interface AudioSegment {
  key: string;
  mediaRef: string;
  /** Absolute timeline frame of the segment's first frame. */
  startFrame: number;
  /** Mix gain at `startFrame + i`; one extra trailing value for the end boundary. */
  gains: number[];
  /** Source seconds at `startFrame`. */
  sourceTime0: number;
  /** Source seconds per timeline second. */
  rate: number;
  /** Speed ramps: source seconds at `startFrame + i` (one extra trailing value), replacing the constant `rate`. */
  sourceTimes?: number[];
}

export const segmentFrames = (s: AudioSegment): number => s.gains.length - 1;

/** Contiguous per-clip runs of active audio sources over [startFrame, endFrame). */
export function collectAudioSegments(
  doc: FrameGraphDocument,
  timelineId: string,
  startFrame: number,
  endFrame: number,
  options: FrameGraphOptions,
): AudioSegment[] {
  const open = new Map<string, { seg: AudioSegment; last: number; tail: number; tailSource: number }>();
  const done: AudioSegment[] = [];
  const fps = doc.timelines.find((t) => t.id === timelineId)?.fps ?? 30;
  const close = (key: string): void => {
    const o = open.get(key);
    if (!o) return;
    o.seg.gains.push(o.tail);
    o.seg.sourceTimes?.push(o.tailSource);
    done.push(o.seg);
    open.delete(key);
  };
  for (let f = startFrame; f < endFrame; f++) {
    const present = new Set<string>();
    for (const src of buildAudioGraph(doc, timelineId, f, options).sources) {
      present.add(src.key);
      // Nested sources fold the carrier envelope into `gain`; the next-frame value is only known for plain clips.
      const tail = src.key.includes("/") ? src.gain : audioEnvelopeGain(src.clip, f + 1) * (src.tailFade ?? 1);
      const o = open.get(src.key);
      if (o && o.last === f - 1) {
        o.seg.gains.push(src.gain);
        o.seg.sourceTimes?.push(src.sourceTime);
        o.last = f;
        o.tail = tail;
        o.tailSource = src.sourceTime + src.sourceRate / fps;
        continue;
      }
      if (o) close(src.key);
      const seg: AudioSegment = { key: src.key, mediaRef: src.mediaRef, startFrame: f, gains: [src.gain], sourceTime0: src.sourceTime, rate: src.sourceRate };
      if (clipHasSpeedRamp(src.clip)) seg.sourceTimes = [src.sourceTime];
      open.set(src.key, { seg, last: f, tail, tailSource: src.sourceTime + src.sourceRate / fps });
    }
    for (const key of [...open.keys()]) if (!present.has(key)) close(key);
  }
  for (const key of [...open.keys()]) close(key);
  return done;
}

/** Decoded source audio: planar float, stereo (mono is duplicated). */
export interface PlanarChunk {
  time: number;
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

/** Monotonic stream of decoded chunks starting at or before the requested time. */
export interface ChunkStream {
  next(): Promise<PlanarChunk | null>;
  close(): Promise<void>;
}

export type OpenStream = (mediaRef: string, startTime: number) => Promise<ChunkStream | null>;

class SegmentReader {
  private stream: ChunkStream | null | undefined;
  private chunks: PlanarChunk[] = [];
  private ended = false;
  private cursor = 0;

  constructor(
    private readonly seg: AudioSegment,
    private readonly open: OpenStream,
  ) {}

  private chunkEnd(c: PlanarChunk): number {
    return c.time + c.left.length / c.sampleRate;
  }

  /** Ensure decoded audio covers source time `until`. False when the source cannot be opened. */
  async fill(from: number, until: number): Promise<boolean> {
    if (this.stream === undefined) this.stream = await this.open(this.seg.mediaRef, Math.max(0, from));
    if (this.stream === null) return false;
    while (!this.ended) {
      const last = this.chunks[this.chunks.length - 1];
      if (last && this.chunkEnd(last) >= until) break;
      const next = await this.stream.next();
      if (!next) this.ended = true;
      else this.chunks.push(next);
    }
    return true;
  }

  discardBefore(time: number): void {
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.chunkEnd(this.chunks[drop] as PlanarChunk) < time) drop += 1;
    if (drop > 0) {
      this.chunks.splice(0, drop);
      this.cursor = Math.max(0, this.cursor - drop);
    }
  }

  /** Linear-interpolated stereo sample at source time `t`; false past the decoded audio. */
  sample(t: number, out: Float32Array): boolean {
    const chunks = this.chunks;
    if (chunks.length === 0) return false;
    while (this.cursor > 0 && t < (chunks[this.cursor] as PlanarChunk).time) this.cursor -= 1;
    while (this.cursor + 1 < chunks.length && t >= (chunks[this.cursor + 1] as PlanarChunk).time) this.cursor += 1;
    const c = chunks[this.cursor] as PlanarChunk;
    const pos = (t - c.time) * c.sampleRate;
    if (pos < 0 || pos >= c.left.length) return false;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const i1 = i0 + 1;
    let l1: number, r1: number;
    if (i1 < c.left.length) {
      l1 = c.left[i1] as number;
      r1 = c.right[i1] as number;
    } else {
      const n = chunks[this.cursor + 1];
      l1 = n ? (n.left[0] as number) : (c.left[i0] as number);
      r1 = n ? (n.right[0] as number) : (c.right[i0] as number);
    }
    const l0 = c.left[i0] as number, r0 = c.right[i0] as number;
    out[0] = l0 + (l1 - l0) * frac;
    out[1] = r0 + (r1 - r0) * frac;
    return true;
  }

  async close(): Promise<void> {
    this.chunks = [];
    if (this.stream) await this.stream.close();
  }
}

export interface MixerOptions {
  fps: number;
  /** First exported timeline frame; output sample 0 sits here. */
  rangeStartFrame: number;
  sampleRate?: number;
}

export class AudioMixer {
  private readonly readers = new Map<string, SegmentReader>();
  private readonly sampleRate: number;
  private readonly scratch = new Float32Array(2);
  /** Media refs that could not be opened (reported once). */
  readonly failedMedia = new Set<string>();

  constructor(
    private readonly segments: readonly AudioSegment[],
    private readonly options: MixerOptions,
    private readonly open: OpenStream,
  ) {
    this.sampleRate = options.sampleRate ?? exportSampleRate;
  }

  get hasAudio(): boolean {
    return this.segments.length > 0;
  }

  /** Output sample index of a timeline-frame boundary relative to the range start. */
  sampleIndexOfFrame(frame: number): number {
    return Math.round(((frame - this.options.rangeStartFrame) / this.options.fps) * this.sampleRate);
  }

  /** Mixed stereo planes for output samples [from, to). */
  async mix(from: number, to: number): Promise<[Float32Array, Float32Array]> {
    const n = Math.max(0, to - from);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const { fps, rangeStartFrame } = this.options;
    const sr = this.sampleRate;
    for (const seg of this.segments) {
      const segStart = ((seg.startFrame - rangeStartFrame) / fps) * sr;
      const segEnd = segStart + (segmentFrames(seg) / fps) * sr;
      const a = Math.max(from, Math.ceil(segStart));
      const b = Math.min(to, Math.ceil(segEnd));
      if (b <= a) continue;
      const times = seg.sourceTimes;
      const srcAt = (s: number): number => {
        if (!times) return seg.sourceTime0 + ((s - segStart) / sr) * seg.rate;
        const p = ((s - segStart) / sr) * fps;
        const i = Math.max(0, Math.min(Math.floor(p), times.length - 2));
        const t0 = times[i] as number;
        return t0 + ((times[i + 1] as number) - t0) * (p - i);
      };
      let reader = this.readers.get(seg.key);
      if (!reader) {
        reader = new SegmentReader(seg, this.open);
        this.readers.set(seg.key, reader);
      }
      const ok = await reader.fill(srcAt(a) - 0.05, srcAt(b) + 0.05);
      if (!ok) {
        this.failedMedia.add(seg.mediaRef);
        continue;
      }
      const framesPerSample = fps / sr;
      const gains = seg.gains;
      for (let s = a; s < b; s++) {
        const p = (s - segStart) * framesPerSample;
        const i = Math.min(Math.floor(p), gains.length - 2);
        const g0 = gains[i] as number, g1 = gains[i + 1] as number;
        const gain = g0 + (g1 - g0) * (p - i);
        if (!reader.sample(srcAt(s), this.scratch)) continue;
        left[s - from] += (this.scratch[0] as number) * gain;
        right[s - from] += (this.scratch[1] as number) * gain;
      }
      reader.discardBefore(srcAt(b) - 0.25);
      if (segEnd <= to) {
        this.readers.delete(seg.key);
        await reader.close();
      }
    }
    // Hard limit keeps summed tracks from wrapping in the encoder's integer conversion.
    for (let i = 0; i < n; i++) {
      left[i] = Math.max(-1, Math.min(1, left[i] as number));
      right[i] = Math.max(-1, Math.min(1, right[i] as number));
    }
    return [left, right];
  }

  async close(): Promise<void> {
    const readers = [...this.readers.values()];
    this.readers.clear();
    await Promise.all(readers.map((r) => r.close()));
  }
}
