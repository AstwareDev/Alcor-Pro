import { describe, expect, it } from "vitest";
import { fixtureClip } from "./fixtures";
import { makeKeyframe, makeKeyframeTrack } from "./keyframe";
import { splitValues } from "./clipSplit";
import {
  clipHasSpeedRamp, clipSetSpeedRamp, clipSourceFramesAt, clipSpeedAt, speedRampFromPreset, speedRampPresets, speedTrackMean,
} from "./speedRamp";
import { clipSourceFramesConsumed, decodeClip } from "./timeline";

const ramp = (...pts: [number, number, ("linear" | "hold" | "smooth" | "easeInOut")?][]) =>
  makeKeyframeTrack(pts.map(([f, v, i]) => makeKeyframe(f, v, i ?? "linear")));

describe("speed ramp source mapping", () => {
  it("constant clips are unchanged", () => {
    const clip = fixtureClip({ start: 0, duration: 60, speed: 2 });
    expect(clipHasSpeedRamp(clip)).toBe(false);
    expect(clipSourceFramesAt(clip, 30)).toBe(60);
    expect(clipSpeedAt(clip, 10)).toBe(2);
  });

  it("integrates a linear ramp exactly", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.speedTrack = ramp([0, 1], [100, 3]);
    // speed(t)=1+0.02t -> integral = t + 0.01 t^2
    expect(clipSourceFramesAt(clip, 50)).toBeCloseTo(75, 6);
    expect(clipSourceFramesAt(clip, 100)).toBeCloseTo(200, 6);
    expect(speedTrackMean(clip.speedTrack, 100, 1)).toBeCloseTo(2, 6);
  });

  it("holds before the first and after the last keyframe, and honours hold keys", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.speedTrack = ramp([20, 2, "hold"], [60, 4]);
    expect(clipSourceFramesAt(clip, 20)).toBeCloseTo(40, 6);
    expect(clipSourceFramesAt(clip, 60)).toBeCloseTo(40 + 80, 6);
    expect(clipSourceFramesAt(clip, 100)).toBeCloseTo(120 + 160, 6);
  });

  it("is continuous and monotonic across eased segments", () => {
    const clip = fixtureClip({ start: 0, duration: 90 });
    clip.speedTrack = ramp([0, 1, "easeInOut"], [45, 0.2, "smooth"], [89, 3]);
    let prev = 0;
    for (let f = 1; f <= 90; f++) {
      const v = clipSourceFramesAt(clip, f);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("setting a ramp keeps length and source range, speed becomes the mean", () => {
    const clip = fixtureClip({ start: 0, duration: 100, trimStart: 10, trimEnd: 80, speed: 1 });
    const total = clipSourceFramesConsumed(clip) + clip.trimStartFrame + clip.trimEndFrame;
    clipSetSpeedRamp(clip, ramp([0, 1], [99, 2]));
    expect(clip.durationFrames).toBe(100);
    expect(clip.speed).toBeGreaterThan(1.4);
    expect(clipSourceFramesConsumed(clip) + clip.trimStartFrame + clip.trimEndFrame).toBe(total);
    clipSetSpeedRamp(clip, undefined);
    expect("speedTrack" in clip).toBe(false);
  });

  it("presets keep the clip's mean speed and stay inside the speed range", () => {
    for (const speed of [1, 0.5, 2]) {
      for (const preset of speedRampPresets) {
        const clip = fixtureClip({ start: 0, duration: 120, speed });
        const track = speedRampFromPreset(clip, preset);
        expect(speedTrackMean(track, 120, speed)).toBeCloseTo(speed, 1);
        for (const kf of track.keyframes) {
          expect(kf.value).toBeGreaterThanOrEqual(0.05);
          expect(kf.value).toBeLessThanOrEqual(20);
        }
      }
    }
    expect(speedRampPresets.map((p) => p.name)).toEqual(["Montage", "Hero", "Bullet", "Flash in", "Flash out", "Smooth slow-mo"]);
  });

  it("round-trips through the project codec", () => {
    const clip = fixtureClip({ start: 0, duration: 60 });
    clip.speedTrack = ramp([0, 1, "easeInOut"], [59, 0.5]);
    clip.frameBlending = true;
    const back = decodeClip(JSON.parse(JSON.stringify(clip)));
    expect(back.speedTrack).toEqual(clip.speedTrack);
    expect(back.frameBlending).toBe(true);
    expect(decodeClip(JSON.parse(JSON.stringify(fixtureClip({ start: 0, duration: 5 })))).speedTrack).toBeUndefined();
  });

  it("splitting a ramped clip keeps both halves on the same source frames", () => {
    const clip = fixtureClip({ start: 0, duration: 100 });
    clip.speedTrack = ramp([0, 1], [99, 3]);
    clipSetSpeedRamp(clip, clip.speedTrack);
    const at40 = clipSourceFramesAt(clip, 40);
    const split = splitValues(clip, 40);
    if (!split) throw new Error("split failed");
    expect(Math.abs(split.right.trimStartFrame - Math.round(at40))).toBeLessThanOrEqual(1);
    expect(clipHasSpeedRamp(split.left)).toBe(true);
    expect(clipHasSpeedRamp(split.right)).toBe(true);
    expect(clipSourceFramesAt(split.right, 0)).toBe(0);
    expect(clipSpeedAt(split.right, 0)).toBeCloseTo(clipSpeedAt(clip, 40), 1);
  });
});
