import { describe, expect, it } from "vitest";
import { fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { makeKeyframe, makeKeyframeTrack } from "../model/keyframe";
import { makeMediaAsset } from "../model/mediaAsset";
import { clipSetSpeedRamp, clipSourceFramesAt } from "../model/speedRamp";
import { makeClip, makeTimeline, makeTrack, type Clip } from "../model/timeline";
import { AudioMixer, collectAudioSegments, type ChunkStream, type OpenStream, type PlanarChunk } from "../export/audioMixer";
import { buildFrameGraph, collectMediaLayers, mediaSourceRate, mediaSourceTime, mediaTiming, type MediaLayer } from "./frameGraph";

const fps = 30;

function rampedClip(extra: Partial<Clip> = {}): Clip {
  const clip = fixtureClip({ start: 0, duration: 90, trimStart: 30 });
  clipSetSpeedRamp(clip, makeKeyframeTrack([makeKeyframe(0, 1, "linear"), makeKeyframe(89, 3, "linear")]));
  return Object.assign(clip, extra);
}

const mediaLayerAt = (clip: Clip, frame: number): MediaLayer => {
  const t = makeTimeline({ fps, width: 320, height: 180, tracks: [fixtureVideoTrack({ clips: [clip] })] });
  const layers = collectMediaLayers(buildFrameGraph({ timelines: [t] }, t.id, frame).layers, []);
  const layer = layers[0];
  if (!layer) throw new Error("no media layer");
  return layer;
};

describe("speed ramps in the frame graph", () => {
  it("constant clips keep the linear mapping", () => {
    const clip = fixtureClip({ start: 0, duration: 60, speed: 2 });
    const timing = mediaTiming(clip, fps);
    if (!timing) throw new Error("no timing");
    expect(mediaSourceTime(clip, timing, 30, fps)).toBeCloseTo(2, 9);
    expect(mediaSourceRate(clip, timing, 30)).toBe(timing.rate);
  });

  it("source time integrates the ramp and the rate follows it", () => {
    const clip = rampedClip();
    const timing = mediaTiming(clip, fps);
    if (!timing) throw new Error("no timing");
    const scale = timing.rate / clip.speed;
    expect(mediaSourceTime(clip, timing, 0, fps)).toBeCloseTo(1, 9);
    expect(mediaSourceTime(clip, timing, 45, fps)).toBeCloseTo(1 + (clipSourceFramesAt(clip, 45) / fps) * scale, 9);
    expect(mediaSourceRate(clip, timing, 0)).toBeCloseTo(1 * scale, 6);
    expect(mediaSourceRate(clip, timing, 89)).toBeCloseTo(3 * scale, 6);
    // the whole clip consumes exactly its source frames
    expect(mediaSourceTime(clip, timing, 90, fps) - timing.sourceStart).toBeCloseTo(timing.sourceDuration, 3);
  });

  it("layers carry instantaneous rate and the frame-blend flag only when slower than 1x", () => {
    const clip = fixtureClip({ start: 0, duration: 90 });
    clipSetSpeedRamp(clip, makeKeyframeTrack([makeKeyframe(0, 0.5, "linear"), makeKeyframe(89, 2, "linear")]));
    clip.frameBlending = true;
    const slow = mediaLayerAt(clip, 0);
    const fast = mediaLayerAt(clip, 89);
    expect(slow.sourceRate).toBeLessThan(1);
    expect(slow.frameBlend).toBe(true);
    expect(fast.sourceRate).toBeGreaterThan(1);
    expect(fast.frameBlend).toBeUndefined();
  });
});

describe("speed ramps in the export audio mixer", () => {
  const sr = 48000;
  // left channel = source time in seconds / 10
  const source: OpenStream = async (_ref, startTime) => {
    let t = Math.floor(startTime / 0.1) * 0.1;
    const stream: ChunkStream = {
      async next(): Promise<PlanarChunk | null> {
        if (t >= 10) return null;
        const n = Math.round(0.1 * sr);
        const left = new Float32Array(n);
        for (let i = 0; i < n; i++) left[i] = (t + i / sr) / 10;
        const chunk = { time: t, sampleRate: sr, left, right: new Float32Array(n) };
        t += 0.1;
        return chunk;
      },
      async close() {},
    };
    return stream;
  };

  it("records per-frame source times and mixes along the ramp", async () => {
    const clip = makeClip({ mediaRef: "tone", mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: 60, trimStartFrame: 0 });
    clipSetSpeedRamp(clip, makeKeyframeTrack([makeKeyframe(0, 1, "linear"), makeKeyframe(59, 2, "linear")]));
    const t = makeTimeline({ fps, width: 320, height: 180, tracks: [makeTrack({ type: "audio", clips: [clip] })] });
    const doc = { timelines: [t], mediaAssets: [{ ...makeMediaAsset({ id: "tone", url: "x", type: "audio", name: "tone", duration: 10 }), hasAudio: true }] };
    const segs = collectAudioSegments(doc, t.id, 0, 60, {});
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    if (!seg?.sourceTimes) throw new Error("ramp segment must carry source times");
    expect(seg.sourceTimes).toHaveLength(61);
    expect(seg.sourceTimes[30]).toBeGreaterThan(30 / fps);
    expect(seg.sourceTimes[60] as number).toBeGreaterThan(seg.sourceTimes[59] as number);

    const mixer = new AudioMixer(segs, { fps, rangeStartFrame: 0 }, source);
    const [l] = await mixer.mix(0, 60 * 1600);
    const halfway = 30 * 1600;
    expect(l[halfway]).toBeCloseTo((seg.sourceTimes[30] as number) / 10, 3);
  });
});
