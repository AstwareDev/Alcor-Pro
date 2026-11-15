import { describe, expect, it } from "vitest";
import { makeStaticEffect } from "../model/effect";
import { fixtureAudioTrack, fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { makeClip, makeTimeline, makeTrack, type Clip, type Timeline } from "../model/timeline";
import { makeTransition, type Transition } from "../model/transition";
import {
  buildAudioGraph, buildFrameGraph, collectMediaLayers, type AdjustmentLayer, type MediaLayer, type TransitionLayer,
} from "../preview/frameGraph";
import { activeTransitionAt, transitionMaxFrames, transitionProgress, transitionSpan } from "./transitionMath";
import { pruneTrackTransitions } from "./pruneTransitions";

const fps = 30;
const media = { resolveMediaDuration: () => 10 };

function cutTimeline(tr: Partial<Transition> = {}, extra: { trimStart?: number; trimEnd?: number } = {}): { tl: Timeline; a: Clip; b: Clip; t: Transition } {
  // a: source 1.0 s … 3.0 s of a 10 s file (handles both sides); b: source 0 … 2 s (no head handle).
  const a = fixtureClip({ id: "a", start: 0, duration: 60, trimStart: 30, trimEnd: 210, ...extra });
  const b = fixtureClip({ id: "b", start: 60, duration: 60, mediaRef: "media-2" });
  const t = makeTransition({ fromClipId: "a", toClipId: "b", durationFrames: 20, ...tr });
  const track = makeTrack({ type: "video", clips: [a, b], transitions: [t] });
  return { tl: makeTimeline({ fps, width: 320, height: 180, tracks: [track] }), a, b, t };
}

const at = (tl: Timeline, frame: number) => buildFrameGraph({ timelines: [tl] }, tl.id, frame, media);

describe("transition span math", () => {
  it("places the span around, after or before the cut", () => {
    expect(transitionSpan(60, 20, "center")).toEqual({ start: 50, end: 70 });
    expect(transitionSpan(60, 21, "center")).toEqual({ start: 50, end: 71 });
    expect(transitionSpan(60, 20, "start")).toEqual({ start: 60, end: 80 });
    expect(transitionSpan(60, 20, "end")).toEqual({ start: 40, end: 60 });
  });

  it("progress is sampled at frame centres", () => {
    const span = { start: 50, end: 70 };
    expect(transitionProgress(span, 50)).toBeCloseTo(0.025);
    expect(transitionProgress(span, 69)).toBeCloseTo(0.975);
    expect(transitionProgress(span, 60)).toBeCloseTo(0.525);
  });

  it("each clip gives at most half its length", () => {
    expect(transitionMaxFrames("center", 60, 60)).toBe(60);
    expect(transitionMaxFrames("center", 10, 60)).toBe(11);
    expect(transitionMaxFrames("start", 60, 20)).toBe(10);
    expect(transitionMaxFrames("end", 20, 60)).toBe(10);
    expect(transitionMaxFrames("center", 1, 60)).toBe(1);
    expect(transitionMaxFrames("center", 1, 1)).toBe(0);
  });

  it("finds the active transition only inside its span", () => {
    const { tl } = cutTimeline();
    const track = tl.tracks[0];
    if (!track) throw new Error("track");
    expect(activeTransitionAt(track, 49)).toBeUndefined();
    expect(activeTransitionAt(track, 50)?.transition.id).toBe(track.transitions?.[0]?.id);
    expect(activeTransitionAt(track, 69)).toBeDefined();
    expect(activeTransitionAt(track, 70)).toBeUndefined();
  });
});

describe("pruneTrackTransitions", () => {
  it("is a no-op when everything is valid and drops stale or overlapping transitions", () => {
    const { tl, t } = cutTimeline();
    const track = tl.tracks[0];
    if (!track) throw new Error("track");
    const before = track.transitions;
    pruneTrackTransitions(track);
    expect(track.transitions).toBe(before);
    track.transitions = [t, makeTransition({ fromClipId: "a", toClipId: "b", durationFrames: 4 }), makeTransition({ fromClipId: "x", toClipId: "b", durationFrames: 4 })];
    pruneTrackTransitions(track);
    expect(track.transitions).toEqual([t]);
    track.clips[1] = { ...(track.clips[1] as Clip), startFrame: 61 };
    pruneTrackTransitions(track);
    expect(track.transitions).toBeUndefined();
  });
});

describe("frame graph during a transition", () => {
  it("is a single transition layer inside the span and plain clips outside", () => {
    const { tl } = cutTimeline();
    expect(at(tl, 49).layers.map((l) => l.kind)).toEqual(["media"]);
    for (const frame of [50, 59, 60, 69]) {
      const layers = at(tl, frame).layers;
      expect(layers.map((l) => l.kind)).toEqual(["transition"]);
    }
    expect(at(tl, 70).layers.map((l) => l.key)).toEqual(["b"]);
    const mid = at(tl, 55).layers[0] as TransitionLayer;
    expect(mid.transitionKind).toBe("crossDissolve");
    expect(mid.progress).toBeCloseTo((55 - 50 + 0.5) / 20);
    expect(mid.from?.key).toBe("a");
    expect(mid.to?.key).toBe("b");
  });

  it("collects the media layers of both sides (decoders must open both clips)", () => {
    const { tl } = cutTimeline();
    const keys = collectMediaLayers(at(tl, 55).layers, []).map((l) => l.key).sort();
    expect(keys).toEqual(["a", "b"]);
  });

  it("outgoing clip plays into its trimmed handle; incoming clip holds its first frame without one", () => {
    const { tl } = cutTimeline();
    const inside = (at(tl, 59).layers[0] as TransitionLayer).from as MediaLayer;
    expect(inside.sourceTime).toBeCloseTo(1 + 59 / fps);
    const past = (at(tl, 65).layers[0] as TransitionLayer).from as MediaLayer;
    expect(past.sourceTime).toBeCloseTo(1 + 65 / fps);
    const head = (at(tl, 55).layers[0] as TransitionLayer).to as MediaLayer;
    expect(head.sourceTime).toBeCloseTo(0);
    const onCut = (at(tl, 62).layers[0] as TransitionLayer).to as MediaLayer;
    expect(onCut.sourceTime).toBeCloseTo(2 / fps);
  });

  it("freezes the edge frame when the clip has no handle", () => {
    const { tl } = cutTimeline({}, { trimEnd: 0, trimStart: 0 });
    const past = (at(tl, 68).layers[0] as TransitionLayer).from as MediaLayer;
    expect(past.sourceTime).toBeCloseTo(59 / fps);
    const last = (at(tl, 59).layers[0] as TransitionLayer).from as MediaLayer;
    expect(last.sourceTime).toBeCloseTo(59 / fps);
  });

  it("partial handles play out, then hold the last source frame", () => {
    const { tl } = cutTimeline({}, { trimStart: 0, trimEnd: 3 });
    const sourceAt = (frame: number) => ((at(tl, frame).layers[0] as TransitionLayer).from as MediaLayer).sourceTime;
    expect(sourceAt(61)).toBeCloseTo(61 / fps);
    expect(sourceAt(63)).toBeCloseTo(62 / fps);
    expect(sourceAt(69)).toBeCloseTo(62 / fps);
  });

  it("start and end alignment move the span, using handles on the outer side", () => {
    const start = cutTimeline({ alignment: "start" }).tl;
    expect(at(start, 59).layers.map((l) => l.kind)).toEqual(["media"]);
    expect(at(start, 60).layers.map((l) => l.kind)).toEqual(["transition"]);
    expect(at(start, 79).layers.map((l) => l.kind)).toEqual(["transition"]);
    expect(at(start, 80).layers.map((l) => l.key)).toEqual(["b"]);
    const end = cutTimeline({ alignment: "end" }).tl;
    expect(at(end, 39).layers.map((l) => l.kind)).toEqual(["media"]);
    expect(at(end, 40).layers.map((l) => l.kind)).toEqual(["transition"]);
    expect(at(end, 60).layers.map((l) => l.key)).toEqual(["b"]);
  });

  it("an offline side leaves the other side drawing", () => {
    const { tl } = cutTimeline();
    const graph = buildFrameGraph({ timelines: [tl] }, tl.id, 55, { ...media, missingMediaRefs: new Set(["media-2"]) });
    const layer = graph.layers[0] as TransitionLayer;
    expect(layer.from?.key).toBe("a");
    expect(layer.to).toBeUndefined();
  });

  it("tracks without transitions build exactly as before", () => {
    const track = fixtureVideoTrack({ clips: [fixtureClip({ id: "a", start: 0, duration: 60 }), fixtureClip({ id: "b", start: 60, duration: 60 })] });
    const tl = makeTimeline({ fps, width: 320, height: 180, tracks: [track] });
    expect(at(tl, 59).layers.map((l) => l.key)).toEqual(["a"]);
    expect(at(tl, 60).layers.map((l) => l.key)).toEqual(["b"]);
  });
});

describe("audio crossfade", () => {
  function withAudio() {
    const { tl } = cutTimeline();
    const a = tl.tracks[0]?.clips[0] as Clip;
    const b = tl.tracks[0]?.clips[1] as Clip;
    a.linkGroupId = "g1";
    b.linkGroupId = "g2";
    const aa = fixtureClip({ id: "aa", mediaType: "audio", start: 0, duration: 60, trimStart: 30, trimEnd: 210 });
    const ab = fixtureClip({ id: "ab", mediaType: "audio", mediaRef: "media-2", start: 60, duration: 60, trimStart: 30 });
    aa.linkGroupId = "g1";
    ab.linkGroupId = "g2";
    tl.tracks.push(fixtureAudioTrack({ clips: [aa, ab] }));
    return tl;
  }
  const sources = (tl: Timeline, frame: number) => buildAudioGraph({ timelines: [tl] }, tl.id, frame, media).sources;

  it("fades the linked audio of both clips over the span and plays them past their ends", () => {
    const tl = withAudio();
    expect(sources(tl, 49).map((s) => [s.key, s.gain])).toEqual([["aa", 1]]);
    const s50 = sources(tl, 50);
    expect(s50.map((s) => s.key).sort()).toEqual(["aa", "ab"]);
    expect(s50.find((s) => s.key === "aa")?.gain).toBeCloseTo(1);
    expect(s50.find((s) => s.key === "ab")?.gain).toBeCloseTo(0);
    const s60 = sources(tl, 60);
    expect(s60.find((s) => s.key === "aa")?.gain).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(s60.find((s) => s.key === "ab")?.gain).toBeCloseTo(Math.sin(Math.PI / 4));
    const s65 = sources(tl, 65);
    expect(s65.find((s) => s.key === "aa")?.sourceTime).toBeCloseTo(1 + 65 / fps);
    expect(s65.find((s) => s.key === "ab")?.sourceTime).toBeCloseTo(1 + 5 / fps);
    expect(sources(tl, 70).map((s) => s.key)).toEqual(["ab"]);
    expect(sources(tl, 70)[0]?.gain).toBe(1);
  });

  it("the incoming audio is silent where its source has no head handle", () => {
    const tl = withAudio();
    const ab = tl.tracks[1]?.clips[1] as Clip;
    ab.trimStartFrame = 2;
    expect(sources(tl, 52).map((s) => s.key)).toEqual(["aa"]);
  });

  it("exposes the next frame's crossfade level for the exporter", () => {
    const tl = withAudio();
    const s = sources(tl, 69).find((x) => x.key === "ab");
    expect(s?.tailFade).toBeCloseTo(1);
  });

  it("leaves unlinked audio alone", () => {
    const tl = withAudio();
    for (const c of tl.tracks[1]?.clips ?? []) delete c.linkGroupId;
    expect(sources(tl, 55).map((s) => [s.key, s.gain])).toEqual([["aa", 1]]);
  });
});

describe("adjustment layers in the frame graph", () => {
  const adjustment = (extra: Partial<Clip> = {}): Clip =>
    makeClip({ id: "adj", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 10, durationFrames: 30, adjustment: true, ...extra });

  it("sits above the tracks below it and only exists with effects", () => {
    const withEffect = adjustment({ effects: [makeStaticEffect("color.contrast", { amount: 1.2 })] });
    const tl = makeTimeline({
      fps, width: 320, height: 180,
      tracks: [makeTrack({ type: "video", clips: [withEffect] }), fixtureVideoTrack({ clips: [fixtureClip({ id: "v", start: 0, duration: 60 })] })],
    });
    expect(at(tl, 5).layers.map((l) => l.key)).toEqual(["v"]);
    const layers = at(tl, 20).layers;
    expect(layers.map((l) => l.kind)).toEqual(["media", "adjustment"]);
    expect((layers[1] as AdjustmentLayer).effects).toHaveLength(1);
    expect(at(tl, 40).layers.map((l) => l.key)).toEqual(["v"]);
    const bare = makeTimeline({ fps, width: 320, height: 180, tracks: [makeTrack({ type: "video", clips: [adjustment()] })] });
    expect(at(bare, 20).layers).toEqual([]);
  });

  it("carries opacity and masks, and drops at zero opacity", () => {
    const clip = adjustment({ opacity: 0.4, effects: [makeStaticEffect("color.contrast", { amount: 1.2 })] });
    const tl = makeTimeline({ fps, width: 320, height: 180, tracks: [makeTrack({ type: "video", clips: [clip] })] });
    expect((at(tl, 20).layers[0] as AdjustmentLayer).opacity).toBeCloseTo(0.4);
    clip.opacity = 0;
    expect(at(tl, 20).layers).toEqual([]);
  });

  it("an adjustment layer makes no audio and no media layer", () => {
    const clip = adjustment({ effects: [makeStaticEffect("color.contrast", { amount: 1.2 })] });
    const tl = makeTimeline({ fps, width: 320, height: 180, tracks: [makeTrack({ type: "video", clips: [clip] })] });
    expect(collectMediaLayers(at(tl, 20).layers, [])).toEqual([]);
    expect(buildAudioGraph({ timelines: [tl] }, tl.id, 20, media).sources).toEqual([]);
  });
});
