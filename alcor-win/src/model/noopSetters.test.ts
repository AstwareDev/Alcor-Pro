import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  clipClampFadesToDuration, clipClampKeyframesToDuration, clipFreshenIds, clipRescaleKeyframes, clipRescaleWordTimings,
  clipSetDuration, clipSetFade, makeClip, type Clip,
} from "./timeline";
import { clipRemoveKeyframe, clipUpsertKeyframe, makeKeyframe, makeKeyframeTrack } from "./keyframe";
import { clipSetBlurKeyframeTrack, clipSetStaticBlurRadius } from "./clipEffectKeyframes";
import { deepEqual, setOptional } from "./equality";
import { clipSetTextFillMode } from "./textFillMode";
import { fixtureClip } from "./fixtures";

function noop(base: Clip, fn: (d: Clip) => void): void {
  expect(produce(base, fn)).toBe(base);
}

describe("no-op model setters leave Immer drafts unmodified", () => {
  const plain = Object.freeze(fixtureClip({ start: 0, duration: 100 }));
  const animated = produce(fixtureClip({ start: 0, duration: 100 }), (d) => {
    clipUpsertKeyframe(d, "opacityTrack", 10, 0.5);
    clipSetStaticBlurRadius(d, 4);
    d.linkGroupId = "L";
  });
  const text = produce(makeClip({ mediaRef: "", mediaType: "text", startFrame: 0, durationFrames: 100, textContent: "hi" }), (d) => {
    d.wordTimings = [{ text: "hi", startFrame: 0, endFrame: 100 }];
    clipSetStaticBlurRadius(d, 3);
  });

  it("clamp / rescale / duration on a clip without optional keys", () => {
    noop(plain, (d) => clipClampKeyframesToDuration(d));
    noop(plain, (d) => clipRescaleKeyframes(d, 1));
    noop(plain, (d) => clipClampFadesToDuration(d));
    noop(plain, (d) => clipSetDuration(d, 100));
    noop(plain, (d) => clipSetFade(d, "left", 0));
    noop(plain, (d) => clipRescaleWordTimings(d, 100));
  });

  it("clamp / rescale / duration on an animated clip", () => {
    noop(animated, (d) => clipClampKeyframesToDuration(d));
    noop(animated, (d) => clipRescaleKeyframes(d, 1));
    noop(animated, (d) => clipSetDuration(d, 100));
  });

  it("word timings rescale to the same duration", () => {
    noop(text, (d) => clipRescaleWordTimings(d, 100));
    noop(text, (d) => clipSetDuration(d, 100));
  });

  it("freshen ids with no group ids only changes the id", () => {
    const out = produce(plain, (d) => clipFreshenIds(d, new Map()));
    expect(out.id).not.toBe(plain.id);
    expect("linkGroupId" in out).toBe(false);
  });

  it("blur setters", () => {
    noop(plain, (d) => clipSetStaticBlurRadius(d, 0));
    noop(plain, (d) => clipSetBlurKeyframeTrack(d, undefined));
    noop(animated, (d) => clipSetStaticBlurRadius(d, 4));
    noop(animated, (d) => clipSetBlurKeyframeTrack(d, undefined));
  });

  it("keyframe setters", () => {
    noop(plain, (d) => clipRemoveKeyframe(d, "opacity", 5));
    noop(animated, (d) => clipRemoveKeyframe(d, "opacity", 50));
    noop(animated, (d) => clipUpsertKeyframe(d, "opacityTrack", 10, 0.5));
    noop(plain, (d) => clipSetTextFillMode(d, "color"));
  });

  it("removing the last keyframe deletes the track key", () => {
    const out = produce(animated, (d) => clipRemoveKeyframe(d, "opacity", 10));
    expect("opacityTrack" in out).toBe(false);
  });

  it("setOptional deletes for undefined and skips equal values", () => {
    const base = { a: makeKeyframeTrack([makeKeyframe(1, 2)]) } as { a?: ReturnType<typeof makeKeyframeTrack<number>>; b?: number };
    expect(produce(base, (d) => setOptional(d, "a", makeKeyframeTrack([makeKeyframe(1, 2)])))).toBe(base);
    expect(produce(base, (d) => setOptional(d, "b", undefined))).toBe(base);
    expect("a" in produce(base, (d) => setOptional(d, "a", undefined))).toBe(false);
    expect(deepEqual({ x: undefined }, {})).toBe(true);
  });
});
