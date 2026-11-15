import { describe, expect, it } from "vitest";
import { makeAnimPair, makeKeyframe, makeKeyframeTrack } from "../../model";
import { fixtureClip } from "../../model/fixtures";
import { centerPixelAt, motionKeyframePoints, motionPathPoints, topLeftForCenterPixel } from "./motionPath";

const size = { width: 1000, height: 500 };

function movingClip() {
  const clip = fixtureClip({ start: 20, duration: 60 });
  clip.transform.width = 0.5;
  clip.transform.height = 0.5;
  clip.positionTrack = makeKeyframeTrack([
    makeKeyframe(0, makeAnimPair(0, 0), "linear"),
    makeKeyframe(40, makeAnimPair(0.5, 0.5), "linear"),
  ]);
  return clip;
}

describe("motion path", () => {
  it("keyframe dots sit at the clip center", () => {
    const dots = motionKeyframePoints(movingClip(), size);
    expect(dots.map((d) => d.offset)).toEqual([0, 40]);
    expect(dots[0]?.point).toEqual({ x: 250, y: 125 });
    expect(dots[1]?.point).toEqual({ x: 750, y: 375 });
  });

  it("the path samples from first to last keyframe and is empty with a single keyframe", () => {
    const clip = movingClip();
    const pts = motionPathPoints(clip, size).split(" ");
    expect(pts[0]).toBe("250.0,125.0");
    expect(pts[pts.length - 1]).toBe("750.0,375.0");
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0, 0))]);
    expect(motionPathPoints(clip, size)).toBe("");
  });

  it("dragging a dot converts the center back to the stored top-left", () => {
    const clip = movingClip();
    const p = centerPixelAt(clip, 60, size);
    const tl = topLeftForCenterPixel(clip, 60, p, size);
    expect(tl.x).toBeCloseTo(0.5, 9);
    expect(tl.y).toBeCloseTo(0.5, 9);
    expect(topLeftForCenterPixel(clip, 60, { x: 500, y: 250 }, size)).toEqual({ x: 0.25, y: 0.25 });
  });
});
