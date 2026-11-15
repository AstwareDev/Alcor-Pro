import { describe, expect, it } from "vitest";
import {
  clipSetInterpolation, clipUpsertKeyframe, decodeKeyframe, decodeKeyframeTrack, doubleInterpolator, interpolationHandles,
  keyframeEase, keyframeTrackRebased, keyframeTrackSample, makeKeyframe, makeKeyframeTrack, cloneKeyframeTrack,
  type Interpolation,
} from "./keyframe";
import { decodeClip, clipOpacityAt } from "./timeline";
import { fixtureClip } from "./fixtures";
import { maskOpacityAt, makeMask } from "./mask";
import { decodeDouble } from "../util/jsonDecode";

const track = (interp: Interpolation, bezier?: [number, number, number, number]) =>
  makeKeyframeTrack([makeKeyframe(0, 0, interp, bezier), makeKeyframe(10, 100)]);
const at = (t: ReturnType<typeof track>, f: number) => keyframeTrackSample(t, f, 0, doubleInterpolator);

describe("keyframe easing", () => {
  it("keeps linear, hold and smooth exactly as before", () => {
    expect(at(track("linear"), 5)).toBe(50);
    expect(at(track("hold"), 9)).toBe(0);
    expect(at(track("smooth"), 2.5)).toBeCloseTo(100 * (0.25 * 0.25 * (3 - 0.5)), 6);
  });

  it("applies ease in, ease out and ease in-out", () => {
    expect(at(track("easeIn"), 2.5)).toBeLessThan(25);
    expect(at(track("easeOut"), 2.5)).toBeGreaterThan(25);
    expect(at(track("easeInOut"), 5)).toBeCloseTo(50, 3);
    expect(at(track("easeInOut"), 2.5)).toBeLessThan(25);
    expect(at(track("easeInOut"), 7.5)).toBeGreaterThan(75);
  });

  it("evaluates custom bezier handles and falls back to ease-in-out without them", () => {
    expect(at(track("bezier", [0, 0, 1, 1]), 4)).toBeCloseTo(40, 4);
    const overshoot = at(track("bezier", [0.34, 1.56, 0.64, 1]), 5);
    expect(overshoot).toBeGreaterThan(100);
    const bare = makeKeyframeTrack([{ frame: 0, value: 0, interpolationOut: "bezier" as const }, makeKeyframe(10, 100)]);
    expect(at(bare, 5)).toBeCloseTo(50, 3);
  });

  it("makeKeyframe only stores handles for bezier", () => {
    expect(makeKeyframe(0, 1, "linear", [0, 0, 1, 1]).bezier).toBeUndefined();
    expect(makeKeyframe(0, 1, "bezier", [0.1, 0.2, 0.3, 0.4]).bezier).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("decodes old files and round-trips the new interpolations and handles", () => {
    const old = decodeKeyframe({ frame: 3, value: 2, interpolationOut: "smooth" }, decodeDouble);
    expect(old).toEqual({ frame: 3, value: 2, interpolationOut: "smooth" });
    const t = track("bezier", [0.2, 0.4, 0.6, 1.4]);
    const back = decodeKeyframeTrack(JSON.parse(JSON.stringify(t)), decodeDouble);
    expect(back).toEqual(t);
    for (const i of ["easeIn", "easeOut", "easeInOut"] as const) {
      expect(decodeKeyframe(JSON.parse(JSON.stringify(makeKeyframe(0, 1, i))), decodeDouble).interpolationOut).toBe(i);
    }
  });

  it("rejects unknown interpolation names and drops malformed handles", () => {
    expect(() => decodeKeyframe({ frame: 0, value: 1, interpolationOut: "spring" }, decodeDouble)).toThrow();
    const kf = decodeKeyframe({ frame: 0, value: 1, interpolationOut: "bezier", bezier: [0.1, 2] }, decodeDouble);
    expect(kf.bezier).toBeUndefined();
    const clamped = decodeKeyframe({ frame: 0, value: 1, interpolationOut: "bezier", bezier: [-1, 0, 2, 1] }, decodeDouble);
    expect(clamped.bezier).toEqual([0, 0, 1, 1]);
  });

  it("clips round-trip eased keyframes and sample them in opacity", () => {
    const clip = fixtureClip({ start: 0, duration: 10 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0, "easeIn"), makeKeyframe(10, 1)]);
    const back = decodeClip(JSON.parse(JSON.stringify(clip)));
    expect(back.opacityTrack?.keyframes[0]?.interpolationOut).toBe("easeIn");
    expect(clipOpacityAt(back, 3)).toBeLessThan(0.3);
  });

  it("eases mask tracks", () => {
    const mask = makeMask({ opacity: 1 });
    mask.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 0, "easeOut"), makeKeyframe(10, 1)]);
    expect(maskOpacityAt(mask, 2.5)).toBeGreaterThan(0.25);
  });

  it("rebasing at a split keeps the easing of the cut segment", () => {
    const t = track("bezier", [0.2, 0.4, 0.6, 0.9]);
    const right = keyframeTrackRebased(t, 4, 0, doubleInterpolator);
    expect(right?.keyframes[0]?.interpolationOut).toBe("bezier");
    expect(right?.keyframes[0]?.bezier).toEqual([0.2, 0.4, 0.6, 0.9]);
  });

  it("setting an easing deletes stale handles and editing a value keeps the easing", () => {
    const clip = fixtureClip({ start: 0, duration: 10 });
    clip.opacityTrack = track("bezier", [0.2, 0.4, 0.6, 0.9]);
    clipUpsertKeyframe(clip, "opacityTrack", 0, 0.5);
    expect(clip.opacityTrack?.keyframes[0]?.interpolationOut).toBe("bezier");
    expect(clip.opacityTrack?.keyframes[0]?.bezier).toEqual([0.2, 0.4, 0.6, 0.9]);
    clipSetInterpolation(clip, "opacity", 0, "linear");
    expect("bezier" in (clip.opacityTrack?.keyframes[0] ?? {})).toBe(false);
  });

  it("cloneKeyframeTrack deep-copies handles", () => {
    const t = track("bezier", [0.2, 0.4, 0.6, 0.9]);
    const c = cloneKeyframeTrack(t);
    (c.keyframes[0]?.bezier as number[])[0] = 0.9;
    expect(t.keyframes[0]?.bezier?.[0]).toBe(0.2);
  });

  it("keyframeEase and interpolationHandles agree", () => {
    const kf = makeKeyframe(0, 0, "easeInOut");
    expect(interpolationHandles(kf)).toEqual([0.42, 0, 0.58, 1]);
    expect(keyframeEase(kf, 0.25)).toBeCloseTo(0.1291, 3);
    expect(interpolationHandles(makeKeyframe(0, 0, "hold"))).toBeUndefined();
  });
});
