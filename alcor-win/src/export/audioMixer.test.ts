import { describe, expect, it } from "vitest";
import { makeMediaAsset } from "../model/mediaAsset";
import { makeClip, makeTimeline, makeTrack } from "../model/timeline";
import {
  AudioMixer, collectAudioSegments, segmentFrames, type ChunkStream, type OpenStream, type PlanarChunk,
} from "./audioMixer";

const fps = 30;
const sr = 48000;

/** Source whose left channel equals its own time in seconds, right channel is a constant 0.5. */
const rampSource: OpenStream = async (_ref, startTime) => {
  const chunkSeconds = 0.1;
  let t = Math.floor(startTime / chunkSeconds) * chunkSeconds;
  const stream: ChunkStream = {
    async next(): Promise<PlanarChunk | null> {
      if (t >= 10) return null;
      const n = Math.round(chunkSeconds * sr);
      const left = new Float32Array(n);
      const right = new Float32Array(n).fill(0.5);
      for (let i = 0; i < n; i++) left[i] = (t + i / sr) / 10;
      const chunk = { time: t, sampleRate: sr, left, right };
      t += chunkSeconds;
      return chunk;
    },
    async close() {},
  };
  return stream;
};

type ClipParams = Omit<Parameters<typeof makeClip>[0], "mediaRef">;

function doc(clips: ClipParams[]) {
  const timeline = makeTimeline({
    fps, width: 1920, height: 1080,
    tracks: [makeTrack({ type: "audio", clips: clips.map((c) => makeClip({ mediaType: "audio", sourceClipType: "audio", ...c, mediaRef: "tone" })) })],
  });
  return { timelines: [timeline], mediaAssets: [{ ...makeMediaAsset({ id: "tone", url: "x", type: "audio", name: "tone", duration: 10 }), hasAudio: true }] };
}

describe("collectAudioSegments", () => {
  it("builds one contiguous segment per clip with envelope gains", () => {
    const d = doc([{ startFrame: 0, durationFrames: 30, fadeInFrames: 30 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 0, 60, {});
    expect(segs).toHaveLength(1);
    const s = segs[0]!;
    expect(segmentFrames(s)).toBe(30);
    expect(s.gains[0]).toBeCloseTo(0, 5);
    expect(s.gains[15]).toBeCloseTo(0.5, 2);
    expect(s.gains[30]).toBeCloseTo(1, 2);
    expect(s.sourceTime0).toBe(0);
    expect(s.rate).toBe(1);
  });

  it("only covers the requested range and carries trim/speed into the source mapping", () => {
    const d = doc([{ startFrame: 0, durationFrames: 60, trimStartFrame: 30, speed: 2 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 30, 60, {});
    expect(segs).toHaveLength(1);
    expect(segs[0]!.startFrame).toBe(30);
    expect(segs[0]!.rate).toBeCloseTo(2, 5);
    // trim 1 s + 1 s of timeline at 2x speed
    expect(segs[0]!.sourceTime0).toBeCloseTo(1 + 2, 5);
  });

  it("skips muted tracks", () => {
    const d = doc([{ startFrame: 0, durationFrames: 30 }]);
    d.timelines[0]!.tracks[0]!.muted = true;
    expect(collectAudioSegments(d, d.timelines[0]!.id, 0, 30, {})).toEqual([]);
  });
});

describe("AudioMixer", () => {
  it("maps output samples to source time and applies gain", async () => {
    const d = doc([{ startFrame: 30, durationFrames: 30, trimStartFrame: 60 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 0, 90, {});
    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 0 }, rampSource);
    const [l, r] = await mixer.mix(0, 90 * 1600);
    expect(l[10]).toBe(0);
    // sample at output 1.5 s = source 2.5 s -> left ramp 0.25
    expect(l[Math.round(1.5 * sr)]).toBeCloseTo(0.25, 3);
    expect(r[Math.round(1.5 * sr)]).toBeCloseTo(0.5, 3);
    expect(l[Math.round(2.5 * sr)]).toBe(0);
  });

  it("resamples for clip speed", async () => {
    const d = doc([{ startFrame: 0, durationFrames: 30, speed: 2 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 0, 30, {});
    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 0 }, rampSource);
    const [l] = await mixer.mix(0, sr);
    // output 0.5 s = source 1.0 s
    expect(l[sr / 2]).toBeCloseTo(0.1, 3);
  });

  it("interpolates a fade-in and sums overlapping tracks with a limiter", async () => {
    const d = doc([{ startFrame: 0, durationFrames: 30, fadeInFrames: 30 }]);
    const second = makeTrack({
      type: "audio",
      clips: [makeClip({ mediaType: "audio", sourceClipType: "audio", mediaRef: "tone", startFrame: 0, durationFrames: 30 })],
    });
    d.timelines[0]!.tracks.push(second);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 0, 30, {});
    expect(segs).toHaveLength(2);
    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 0 }, async (...a) => rampSource(...a));
    const [, r] = await mixer.mix(0, sr);
    // right channel: 0.5 * fade(t) + 0.5 * 1 at t = 0.5 s -> 0.5 * 0.5 + 0.5 = 0.75
    expect(r[sr / 2]).toBeCloseTo(0.75, 2);
    // limited at 1.0 near the end of the fade (0.5 + 0.5)
    expect(Math.max(...r)).toBeLessThanOrEqual(1);
  });

  it("reports media that cannot be opened and stays silent", async () => {
    const d = doc([{ startFrame: 0, durationFrames: 30 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 0, 30, {});
    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 0 }, async () => null);
    const [l] = await mixer.mix(0, sr);
    expect(Math.max(...l)).toBe(0);
    expect([...mixer.failedMedia]).toEqual(["tone"]);
  });

  it("starts the output at the range start", async () => {
    const d = doc([{ startFrame: 0, durationFrames: 90 }]);
    const segs = collectAudioSegments(d, d.timelines[0]!.id, 30, 90, {});
    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 30 }, rampSource);
    const [l] = await mixer.mix(0, sr);
    expect(l[0]).toBeCloseTo(0.1, 3);
    expect(mixer.sampleIndexOfFrame(60)).toBe(sr);
  });
});
