import { describe, expect, it } from "vitest";
import { makeStaticEffect } from "../model/effect";
import { fixtureAudioTrack, fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { makeKeyframe, makeKeyframeTrack } from "../model/keyframe";
import { makeTextAnimation } from "../model/textAnimation";
import { makeTextStyle } from "../model/textStyle";
import { makeClip, makeTimeline, makeTrack, makeTransform, type Clip, type Timeline, type Track } from "../model/timeline";
import {
  affineTransform, audioEnvelopeGain, buildAudioGraph, buildFrameGraph, collectMediaLayers, mediaTiming, smoothSegments,
  smoothSubdivisions, type Affine, type FrameLayer, type GroupLayer, type MediaLayer, type TextLayer,
} from "./frameGraph";

const render = { width: 1920, height: 1080 };
const nat = { width: 1920, height: 1080 };

function approxEqual(a: Affine, b: Affine, eps = 1e-9): boolean {
  return Math.abs(a.a - b.a) < eps && Math.abs(a.b - b.b) < eps && Math.abs(a.c - b.c) < eps &&
    Math.abs(a.d - b.d) < eps && Math.abs(a.tx - b.tx) < eps && Math.abs(a.ty - b.ty) < eps;
}

function timeline(tracks: Track[], p: Partial<Timeline> = {}): Timeline {
  return makeTimeline({ fps: 30, width: 320, height: 180, tracks, ...p });
}

function textClip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return makeClip({ id, mediaRef: `text-${id}`, mediaType: "text", sourceClipType: "text", startFrame: start, durationFrames: duration, textContent: id, ...extra });
}

function nestClip(child: Timeline, p: Partial<Clip> = {}): Clip {
  return makeClip({ mediaRef: child.id, mediaType: "sequence", sourceClipType: "sequence", startFrame: 0, durationFrames: 60, ...p });
}

const ids = (layers: FrameLayer[]): string[] => layers.map((l) => l.key);
const graphAt = (t: Timeline, frame: number, extra: Timeline[] = []) => buildFrameGraph({ timelines: [t, ...extra] }, t.id, frame);

describe("CompositionBuilder.smoothSubdivisions", () => {
  it("emptyWhenSpanIsZero", () => expect(smoothSubdivisions(10, 10)).toEqual([]));
  it("emptyWhenSpanIsNegative", () => expect(smoothSubdivisions(20, 10)).toEqual([]));
  it("produces7InteriorPointsAtEvenSpacing", () => expect(smoothSubdivisions(0, 80)).toEqual([10, 20, 30, 40, 50, 60, 70]));
  it("interiorPointsAreShiftedByStart", () => expect(smoothSubdivisions(100, 180)).toEqual([110, 120, 130, 140, 150, 160, 170]));
  it("subdivisionCountIsAtMostSegmentsMinusOne", () => expect(smoothSubdivisions(0, 3).length).toBeLessThanOrEqual(smoothSegments - 1));
  it("returnsDistinctOffsetsInAscendingOrder", () => {
    for (const [a, b] of [[0, 1], [0, 3], [100, 110], [0, 1000]] as const) {
      const r = smoothSubdivisions(a, b);
      expect(new Set(r).size).toBe(r.length);
      expect(r).toEqual([...r].sort((x, y) => x - y));
    }
  });
  it("tightSpansCollapseDuplicateOffsets", () => expect(smoothSubdivisions(0, 1)).toEqual([0, 1]));
});

describe("CompositionBuilder.affineTransform", () => {
  it("defaultTransformWithMatchingSizesIsIdentity", () => {
    expect(approxEqual(affineTransform(makeTransform(), nat, render), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })).toBe(true);
  });
  it("halfSizeAtCenterScalesAndTranslates", () => {
    const r = affineTransform(makeTransform({ width: 0.5, height: 0.5 }), nat, render);
    expect(approxEqual(r, { a: 0.5, b: 0, c: 0, d: 0.5, tx: 480, ty: 270 })).toBe(true);
  });
  it("renderUpscalesBeyondNatSize", () => {
    const r = affineTransform(makeTransform(), nat, { width: 3840, height: 2160 });
    expect(r.a).toBeCloseTo(2, 9);
    expect(r.d).toBeCloseTo(2, 9);
    expect(r.tx).toBe(0);
    expect(r.ty).toBe(0);
  });
  it("flipHorizontalNegatesXScaleAndShiftsTx", () => {
    const r = affineTransform(makeTransform({ flipHorizontal: true }), nat, render);
    expect(r.a).toBeCloseTo(-1, 9);
    expect(r.d).toBeCloseTo(1, 9);
    expect(r.tx).toBeCloseTo(1920, 9);
    expect(r.ty).toBe(0);
  });
  it("flipVerticalNegatesYScaleAndShiftsTy", () => {
    const r = affineTransform(makeTransform({ flipVertical: true }), nat, render);
    expect(r.a).toBeCloseTo(1, 9);
    expect(r.d).toBeCloseTo(-1, 9);
    expect(r.tx).toBe(0);
    expect(r.ty).toBeCloseTo(1080, 9);
  });
  it("rotationAt180FlipsBothScales", () => {
    const r = affineTransform(makeTransform({ rotation: 180 }), nat, render);
    expect(approxEqual(r, { a: -1, b: 0, c: 0, d: -1, tx: 1920, ty: 1080 }, 1e-6)).toBe(true);
  });
  it("zeroRotationSkipsRotationBlockEntirely", () => {
    expect(approxEqual(affineTransform(makeTransform({ rotation: 0 }), nat, render), affineTransform(makeTransform(), nat, render))).toBe(true);
  });
  it("affineTransformWithZeroNatSizeProducesInfiniteOrNaNScale", () => {
    const r = affineTransform(makeTransform(), { width: 0, height: 0 }, render);
    expect(!Number.isFinite(r.a)).toBe(true);
  });
  it("positive rotation is clockwise on screen (top-left origin)", () => {
    const r = affineTransform(makeTransform({ rotation: 90 }), nat, render);
    // The source's top-right corner (1920, 0) rotates clockwise about (960, 540) to (1500, 1500).
    const x = r.a * 1920 + r.c * 0 + r.tx, y = r.b * 1920 + r.d * 0 + r.ty;
    expect(x).toBeCloseTo(1500, 6);
    expect(y).toBeCloseTo(1500, 6);
  });
});

describe("buildFrameGraph", () => {
  it("textInstructionsPreserveLayerOrderAcrossCaptionBoundaries", () => {
    const t = makeTimeline({ fps: 10, tracks: [
      fixtureVideoTrack({ clips: [textClip("top-a", 0, 10), textClip("top-b", 10, 10)] }),
      fixtureVideoTrack({ clips: [textClip("bottom", 0, 20)] }),
    ] });
    expect(ids(graphAt(t, 0).layers)).toEqual(["bottom", "top-a"]);
    expect(ids(graphAt(t, 10).layers)).toEqual(["bottom", "top-b"]);
  });

  it("orders layers bottom → top: last track is the bottom", () => {
    const t = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "top", start: 0, duration: 30 })] }), fixtureVideoTrack({ clips: [fixtureClip({ id: "bottom", start: 0, duration: 30 })] })]);
    expect(ids(graphAt(t, 5).layers)).toEqual(["bottom", "top"]);
  });

  it("skips hidden tracks, gaps and empty or zero-length clips", () => {
    const hidden = fixtureVideoTrack({ clips: [fixtureClip({ id: "hidden", start: 0, duration: 30 })] });
    hidden.hidden = true;
    const t = timeline([hidden, fixtureVideoTrack({ clips: [
      fixtureClip({ id: "zero", start: 0, duration: 0 }), fixtureClip({ id: "late", start: 20, duration: 10 }), textClip("", 0, 30),
    ] })]);
    expect(ids(graphAt(t, 5).layers)).toEqual([]);
    expect(ids(graphAt(t, 20).layers)).toEqual(["late"]);
    expect(ids(graphAt(t, 30).layers)).toEqual([]);
  });

  it("an overlapping clip in the same lane is never inserted", () => {
    const t = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "a", start: 0, duration: 30 }), fixtureClip({ id: "b", start: 20, duration: 30 })] })]);
    expect(ids(graphAt(t, 25).layers)).toEqual(["a"]);
    expect(ids(graphAt(t, 35).layers)).toEqual([]);
  });

  it("offline media does not occupy the lane", () => {
    const t = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "a", mediaRef: "gone", start: 0, duration: 30 }), fixtureClip({ id: "b", start: 20, duration: 30 })] })]);
    const g = buildFrameGraph({ timelines: [t] }, t.id, 25, { missingMediaRefs: new Set(["gone"]) });
    expect(ids(g.layers)).toEqual(["b"]);
  });

  it("audio tracks contribute no visual layers", () => {
    const t = timeline([fixtureAudioTrack({ clips: [fixtureClip({ id: "a", mediaType: "audio", start: 0, duration: 30 })] })]);
    expect(graphAt(t, 5).layers).toEqual([]);
  });

  it("omits fully transparent layers and clamps opacity with fades", () => {
    const fading = fixtureClip({ id: "f", start: 0, duration: 60 });
    fading.fadeInFrames = 30;
    fading.opacity = 2;
    const t = timeline([fixtureVideoTrack({ clips: [fading] })]);
    expect(graphAt(t, 0).layers).toEqual([]);
    expect(graphAt(t, 15).layers[0]?.opacity).toBeCloseTo(1, 9);
    expect(graphAt(t, 45).layers[0]?.opacity).toBe(1);
  });

  it("resolves source time through trim and speed", () => {
    const clip = fixtureClip({ id: "c", start: 10, duration: 60, trimStart: 30, speed: 2 });
    const t = timeline([fixtureVideoTrack({ clips: [clip] })]);
    const layer = graphAt(t, 40).layers[0] as MediaLayer;
    expect(layer.sourceStart).toBeCloseTo(1, 9);
    expect(layer.sourceRate).toBeCloseTo(2, 9);
    expect(layer.sourceTime).toBeCloseTo(1 + (30 / 30) * 2, 9);
  });

  it("fractional speed truncates source frames like insertClip", () => {
    const timing = mediaTiming(fixtureClip({ start: 0, duration: 7, speed: 1.5 }), 30);
    expect(timing?.sourceDuration).toBeCloseTo(10 / 30, 9);
    expect(timing?.rate).toBeCloseTo(10 / 7, 9);
  });

  it("clamps the inserted range to the media duration; empty ranges are not inserted", () => {
    expect(mediaTiming(fixtureClip({ start: 0, duration: 60 }), 30, 1)?.sourceDuration).toBeCloseTo(1, 9);
    expect(mediaTiming(fixtureClip({ start: 0, duration: 60, trimStart: 60 }), 30, 1)).toBeUndefined();
  });

  it("resolves transform, crop and effects at the frame", () => {
    const clip = fixtureClip({ id: "c", start: 0, duration: 60 });
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(60, 60, "linear")]);
    clip.effects = [
      { ...makeStaticEffect("color.exposure", { ev: 1 }), params: { ev: { track: makeKeyframeTrack([makeKeyframe(0, 0, "linear"), makeKeyframe(60, 3, "linear")]) } } },
      { ...makeStaticEffect("color.contrast", { amount: 1.2 }), enabled: false },
      makeStaticEffect("future.unknown", {}),
    ];
    const t = timeline([fixtureVideoTrack({ clips: [clip] })]);
    const layer = graphAt(t, 30).layers[0] as MediaLayer;
    expect(layer.transform.rotation).toBeCloseTo(30, 9);
    expect(layer.effects.map((e) => e.effect.type)).toEqual(["color.exposure"]);
    expect(layer.effects[0]?.params.values["ev"]).toBeCloseTo(1.5, 9);
    expect(layer.effectOffset).toBe(30);
  });

  it("flattens nested sequences into a group with the carrier's pipeline", () => {
    const child = timeline([
      fixtureVideoTrack({ clips: [fixtureClip({ id: "a", start: 0, duration: 30 })] }),
      fixtureVideoTrack({ clips: [fixtureClip({ id: "b", start: 30, duration: 30 })] }),
    ]);
    const carrier = nestClip(child, { id: "nest", opacity: 0.5, transform: makeTransform({ width: 0.5, height: 0.5 }) });
    const t = timeline([fixtureVideoTrack({ clips: [carrier] })]);
    const g1 = graphAt(t, 10, [child]).layers[0] as GroupLayer;
    expect(g1.kind).toBe("group");
    expect(g1.opacity).toBe(0.5);
    expect(g1.transform.width).toBe(0.5);
    expect(g1.natSize).toEqual({ width: 320, height: 180 });
    expect(ids(g1.children)).toEqual(["nest/a"]);
    expect(ids((graphAt(t, 40, [child]).layers[0] as GroupLayer).children)).toEqual(["nest/b"]);
  });

  it("nest gaps still render the (black) group and trimmed carriers remap child time", () => {
    const child = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "a", start: 20, duration: 40 })] })]);
    const carrier = nestClip(child, { id: "n", startFrame: 100, trimStartFrame: 10, durationFrames: 40 });
    const t = timeline([fixtureVideoTrack({ clips: [carrier] })]);
    const gap = graphAt(t, 105, [child]).layers[0] as GroupLayer;
    expect(gap.children).toEqual([]);
    const g = graphAt(t, 120, [child]).layers[0] as GroupLayer;
    const media = g.children[0] as MediaLayer;
    expect(media.clip.startFrame).toBe(110);
    expect(media.sourceTime).toBeCloseTo(10 / 30, 9);
  });

  it("two-level nests and a missing child timeline", () => {
    const grand = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "g", start: 0, duration: 60 })] })]);
    const middle = timeline([fixtureVideoTrack({ clips: [nestClip(grand, { id: "m" })] })]);
    const t = timeline([fixtureVideoTrack({ clips: [nestClip(middle, { id: "top" })] })]);
    const outer = graphAt(t, 5, [middle, grand]).layers[0] as GroupLayer;
    const inner = outer.children[0] as GroupLayer;
    expect(inner.kind).toBe("group");
    expect(ids(inner.children)).toEqual(["top/m/g"]);
    expect(collectMediaLayers(outer.children, []).map((l) => l.key)).toEqual(["top/m/g"]);
    expect(graphAt(t, 5).layers).toEqual([]);
  });

  it("text layers resolve style, fill mode and animation at the frame", () => {
    const text = textClip("hello world", 0, 60, {
      textStyle: makeTextStyle({ fontScale: 2 }),
      textAnimation: makeTextAnimation({ preset: "wordReveal", perWordFrames: 6 }),
      textFillMode: "inverted",
    });
    const t = timeline([fixtureVideoTrack({ clips: [text] })]);
    const layer = graphAt(t, 3).layers[0] as TextLayer;
    expect(layer.kind).toBe("text");
    expect(layer.blendMode).toBe("difference");
    expect(layer.text.style.fontSize).toBe(96 * 2);
    expect(layer.text.style.fontScale).toBe(1);
    expect(layer.text.style.shadow.enabled).toBe(false);
    expect(layer.text.mode).toBe("perWord");
    expect(layer.text.tokens.map((x) => x.text)).toEqual(["hello", "world"]);
    expect(layer.text.wordStates.length).toBe(2);
    expect(layer.effectSpatialScale).toBeCloseTo(180 / 1080, 9);
  });

  it("text blur becomes the first effect; generic gaussian effects are dropped for text", () => {
    const text = textClip("blur", 0, 60, {
      textStyle: { ...makeTextStyle(), blur: 5 },
      effects: [makeStaticEffect("blur.gaussian", { radius: 9 }), makeStaticEffect("stylize.invert")],
    });
    const layer = graphAt(timeline([fixtureVideoTrack({ clips: [text] })]), 0).layers[0] as TextLayer;
    expect(layer.effects.map((e) => e.effect.type)).toEqual(["blur.gaussian", "stylize.invert"]);
    expect(layer.effects[0]?.params.values["radius"]).toBe(5);
  });
});

describe("buildAudioGraph", () => {
  it("normalAudioClipsShareCompositionTrack: active clips with their gains", () => {
    const t = timeline([fixtureAudioTrack({ clips: [fixtureClip({ id: "a", mediaType: "audio", start: 0, duration: 30, volume: 0.5 }), fixtureClip({ id: "b", mediaType: "audio", start: 30, duration: 30 })] })]);
    const g = buildAudioGraph({ timelines: [t] }, t.id, 10);
    expect(g.sources.map((s) => s.key)).toEqual(["a"]);
    expect(g.sources[0]?.gain).toBeCloseTo(0.5, 6);
    expect(buildAudioGraph({ timelines: [t] }, t.id, 30).sources.map((s) => s.key)).toEqual(["b"]);
  });

  it("mutedAudioTrackIsExcludedFromComposition", () => {
    const track = fixtureAudioTrack({ clips: [fixtureClip({ id: "a", mediaType: "audio", start: 0, duration: 30 })] });
    track.muted = true;
    const t = timeline([track]);
    expect(buildAudioGraph({ timelines: [t] }, t.id, 10).sources).toEqual([]);
  });

  it("video-track clips carry no audio (linked audio clips do)", () => {
    const t = timeline([fixtureVideoTrack({ clips: [fixtureClip({ id: "v", start: 0, duration: 30 })] })]);
    expect(buildAudioGraph({ timelines: [t] }, t.id, 10).sources).toEqual([]);
  });

  it("fades ramp linearly between envelope breakpoints", () => {
    const clip = fixtureClip({ id: "a", mediaType: "audio", start: 0, duration: 100 });
    clip.fadeInFrames = 20;
    expect(audioEnvelopeGain(clip, 0)).toBeCloseTo(0, 6);
    expect(audioEnvelopeGain(clip, 10)).toBeCloseTo(0.5, 6);
    expect(audioEnvelopeGain(clip, 50)).toBeCloseTo(1, 6);
  });

  it("smooth fades use 8 linear sub-ramps (not the exact smoothstep)", () => {
    const clip = fixtureClip({ id: "a", mediaType: "audio", start: 0, duration: 100 });
    clip.fadeInFrames = 80;
    clip.fadeInInterpolation = "smooth";
    const s = (t: number): number => t * t * (3 - 2 * t);
    expect(audioEnvelopeGain(clip, 10)).toBeCloseTo(s(10 / 80), 5);
    expect(audioEnvelopeGain(clip, 15)).toBeCloseTo((s(10 / 80) + s(20 / 80)) / 2, 5);
  });

  it("nested audio folds static volumes and multiplies the top carrier's envelope", () => {
    const child = timeline([fixtureAudioTrack({ clips: [fixtureClip({ id: "c", mediaType: "audio", start: 0, duration: 60, volume: 0.5 })] })]);
    const carrier = makeClip({ id: "n", mediaRef: child.id, mediaType: "audio", sourceClipType: "sequence", startFrame: 0, durationFrames: 60, volume: 0.8 });
    const t = timeline([makeTrack({ type: "audio", clips: [carrier] })]);
    const g = buildAudioGraph({ timelines: [t, child] }, t.id, 10);
    expect(g.sources.map((s) => s.key)).toEqual(["n/c"]);
    expect(g.sources[0]?.gain).toBeCloseTo(0.5 * 0.8, 6);
  });
});
