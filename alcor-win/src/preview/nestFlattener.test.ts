import { describe, expect, it } from "vitest";
import { makeStaticEffect } from "../model/effect";
import { fixtureAudioTrack, fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { makeKeyframe, makeKeyframeTrack } from "../model/keyframe";
import { makeClip, makeTimeline, type Clip } from "../model/timeline";
import { nestFlatten } from "./nestFlattener";

function carrier(p: Partial<Clip> = {}): Clip {
  return makeClip({ id: "nest", mediaRef: "child", mediaType: "sequence", sourceClipType: "sequence", startFrame: 100, durationFrames: 50, trimStartFrame: 20, ...p });
}

describe("NestFlattener", () => {
  it("remaps child clips into parent frames through the carrier window", () => {
    const child = makeTimeline({ width: 640, height: 360, tracks: [fixtureVideoTrack({ clips: [fixtureClip({ id: "a", start: 0, duration: 40 }), fixtureClip({ id: "b", start: 60, duration: 40 }), fixtureClip({ id: "c", start: 80, duration: 10 })] })] });
    const flat = nestFlatten(carrier(), child, true);
    expect(flat.childCanvas).toEqual({ width: 640, height: 360 });
    const clips = flat.videoTracks[0] ?? [];
    expect(clips.map((c) => c.id)).toEqual(["nest/a", "nest/b"]);
    const a = clips[0] as Clip, b = clips[1] as Clip;
    // a: [20,40) of the child → parent [100,120), head cut of 20 frames moves its trim.
    expect([a.startFrame, a.durationFrames, a.trimStartFrame]).toEqual([100, 20, 20]);
    // b: [60,70) → parent [140,150), tail cut.
    expect([b.startFrame, b.durationFrames, b.trimStartFrame]).toEqual([140, 10, 0]);
  });

  it("head cut scales trim by speed, drops the fade-in and rebases keyframes", () => {
    const clip = fixtureClip({ id: "a", start: 0, duration: 60, speed: 1.5 });
    clip.fadeInFrames = 10;
    clip.fadeOutFrames = 10;
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(40, 1, "linear")]);
    clip.effects = [{ ...makeStaticEffect("blur.gaussian", { radius: 4 }), params: { radius: { value: 4, track: makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(40, 8, "linear")]) } } }];
    Object.freeze(clip);
    const child = makeTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] });
    const out = nestFlatten(carrier({ trimStartFrame: 20, durationFrames: 30 }), child, true).videoTracks[0]?.[0] as Clip;
    expect(out.trimStartFrame).toBe(30);
    expect(out.fadeInFrames).toBe(0);
    expect(out.fadeOutFrames).toBe(0);
    expect(out.opacityTrack?.keyframes[0]).toEqual({ frame: 0, value: 0.5, interpolationOut: "linear" });
    expect(out.effects?.[0]?.params["radius"]?.track?.keyframes[0]?.value).toBeCloseTo(4, 9);
    // The document clip is untouched.
    expect(clip.opacityTrack?.keyframes[0]?.frame).toBe(0);
  });

  it("visual flatten skips audio and hidden tracks; audio flatten skips muted tracks", () => {
    const hidden = fixtureVideoTrack({ clips: [fixtureClip({ id: "h", start: 0, duration: 100 })] });
    hidden.hidden = true;
    const muted = fixtureAudioTrack({ clips: [fixtureClip({ id: "m", mediaType: "audio", start: 0, duration: 100 })] });
    muted.muted = true;
    const child = makeTimeline({ tracks: [hidden, muted, fixtureAudioTrack({ clips: [fixtureClip({ id: "s", mediaType: "audio", start: 0, duration: 100 })] })] });
    expect(nestFlatten(carrier(), child, true).videoTracks).toEqual([]);
    expect(nestFlatten(carrier(), child, false).audioTracks.map((t) => t.map((c) => c.id))).toEqual([["nest/s"]]);
  });
});
