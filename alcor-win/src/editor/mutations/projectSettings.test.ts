import { describe, expect, it } from "vitest";
import { makeTimelineMarker, makeKeyframe, makeKeyframeTrack, makeAnimPair, makeCrop, makeMediaAsset } from "../../model";
import { applyTimelineSettings, canvasPresetResolution, canvasPresets, checkProjectSettings, parseCustomFrameRate } from "./projectSettings";
import { Fixtures, makeEditor, timelineCopy } from "./testFixtures";

describe("EditorViewModel - applyTimelineSettings", () => {
  it("undoRestoresExactFramesAfterFpsRounding", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 1000 });
    clip.trimEndFrame = 897;
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const before = timelineCopy(e);

    applyTimelineSettings(e, 24, 1280, 720);
    e.undo();

    expect(e.timeline).toEqual(before);
  });

  it("rescalesOpacityFadesByFpsRatio", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.fadeInFrames = 30;
    clip.fadeOutFrames = 30;
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyTimelineSettings(e, 60, 1920, 1080);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.fadeInFrames).toBe(60);
    expect(updated.fadeOutFrames).toBe(60);
  });

  it("rescalesAllKeyframeTracksByFpsRatio", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(15, 0.5)]);
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(15, makeAnimPair(0.1, 0.2))]);
    clip.scaleTrack = makeKeyframeTrack([makeKeyframe(15, makeAnimPair(0.5, 0.5))]);
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(15, 45)]);
    clip.cropTrack = makeKeyframeTrack([makeKeyframe(15, makeCrop({ left: 0.1 }))]);
    clip.volumeTrack = makeKeyframeTrack([makeKeyframe(15, -6)]);

    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyTimelineSettings(e, 60, 1920, 1080);
    const u = e.timeline.tracks[0].clips[0];

    expect(u.durationFrames).toBe(120);
    for (const track of [u.opacityTrack, u.positionTrack, u.scaleTrack, u.rotationTrack, u.cropTrack, u.volumeTrack]) {
      expect(track?.keyframes.map((k) => k.frame)).toEqual([30]);
    }
  });

  it("fpsRetimeDedupesRoundedKeyframesLastValueWins", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 20 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(1, 0.2), makeKeyframe(2, 0.8)]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyTimelineSettings(e, 15, 1920, 1080);
    const kfs = e.timeline.tracks[0].clips[0].opacityTrack?.keyframes ?? [];
    expect(kfs.map((k) => k.frame)).toEqual([1]);
    expect(kfs[0]?.value).toBe(0.8);
  });

  it("fpsRetimeKeepsSameTrackClipsNonOverlappingAfterRounding", () => {
    const first = Fixtures.clip({ id: "c1", start: 2, duration: 1 });
    const second = Fixtures.clip({ id: "c2", start: 3, duration: 1 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [first, second] })]);
    applyTimelineSettings(e, 12, 1920, 1080);
    const clips = [...e.timeline.tracks[0].clips].sort((a, b) => a.startFrame - b.startFrame);
    expect(clips[0].startFrame + clips[0].durationFrames).toBeLessThanOrEqual(clips[1].startFrame);
  });

  it("fpsChangeRescalesEveryTimeline", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "a", start: 30, duration: 30 })] })]);
    const second = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "b", start: 60, duration: 60 })] })] });
    e.withoutRegistration(() => {
      e.doc.timelines.push(second);
    });
    e.liveViewStates[second.id] = { playheadFrame: 90, zoomScale: 4, scrollOffsetX: 0 };

    applyTimelineSettings(e, 60, e.timeline.width, e.timeline.height);

    expect(e.timelines.every((t) => t.fps === 60)).toBe(true);
    expect(e.timeline.tracks[0].clips[0].startFrame).toBe(60);
    const rescaled = e.timelines[1];
    expect(rescaled.tracks[0].clips[0].startFrame).toBe(120);
    expect(rescaled.tracks[0].clips[0].durationFrames).toBe(120);
    expect(e.liveViewStates[second.id]?.playheadFrame).toBe(180);
  });

  it("noChangeStillMarksConfiguredWithoutUndoWhenIdentical", () => {
    const e = makeEditor([]);
    applyTimelineSettings(e, 30, 1920, 1080);
    e.undo();
    expect(e.timeline.settingsConfigured).toBe(false);
  });
});

describe("applyTimelineSettings - fps stability", () => {
  it("undoRestoresPlayheadRangeZoomAndViewStates", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 30, duration: 60 })] })]);
    e.ui.currentFrame = 45;
    e.ui.zoomScale = 2;
    e.ui.selectedTimelineRange = { startFrame: 30, endFrame: 60 };
    e.liveViewStates["other"] = { playheadFrame: 10, zoomScale: 3, scrollOffsetX: 5 };

    applyTimelineSettings(e, 60, e.timeline.width, e.timeline.height);
    expect(e.ui.currentFrame).toBe(90);
    expect(e.ui.selectedTimelineRange).toEqual({ startFrame: 60, endFrame: 120 });
    expect(e.ui.zoomScale).toBe(1);
    expect(e.liveViewStates["other"]).toEqual({ playheadFrame: 20, zoomScale: 1.5, scrollOffsetX: 5 });

    e.undo();
    expect(e.ui.currentFrame).toBe(45);
    expect(e.ui.selectedTimelineRange).toEqual({ startFrame: 30, endFrame: 60 });
    expect(e.ui.zoomScale).toBe(2);
    expect(e.liveViewStates["other"]).toEqual({ playheadFrame: 10, zoomScale: 3, scrollOffsetX: 5 });

    e.redo();
    expect(e.ui.currentFrame).toBe(90);
    expect(e.timeline.fps).toBe(60);
  });

  it("keepsVisibleDurationConstantOnZoom", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 0, duration: 30 })] })]);
    e.ui.zoomScale = 4;
    const before = e.ui.zoomScale * e.timeline.fps;
    applyTimelineSettings(e, 24, e.timeline.width, e.timeline.height);
    expect(e.ui.zoomScale * e.timeline.fps).toBeCloseTo(before, 9);
  });

  it("stopsPlaybackBeforeRescaling", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 0, duration: 30 })] })]);
    e.ui.isPlaying = true;
    applyTimelineSettings(e, 60, e.timeline.width, e.timeline.height);
    expect(e.ui.isPlaying).toBe(false);
  });

  it("rescalesMarkersIncludingRanges", () => {
    const e = makeEditor([], { markers: [makeTimelineMarker({ id: "p", name: "p", startFrame: 30 }), makeTimelineMarker({ id: "r", name: "r", startFrame: 30, durationFrames: 15 })] });
    applyTimelineSettings(e, 60, e.timeline.width, e.timeline.height);
    const [point, range] = e.timeline.markers;
    expect([point.startFrame, point.durationFrames]).toEqual([60, 0]);
    expect([range.startFrame, range.durationFrames]).toEqual([60, 30]);
  });

  it("rescalesTextWordTimingsWithDuration", () => {
    const clip = Fixtures.clip({ id: "t", start: 0, duration: 30 });
    clip.mediaType = "text";
    clip.wordTimings = [{ text: "a", startFrame: 0, endFrame: 15 }, { text: "b", startFrame: 15, endFrame: 30 }];
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyTimelineSettings(e, 60, e.timeline.width, e.timeline.height);
    expect(e.timeline.tracks[0].clips[0].wordTimings).toEqual([
      { text: "a", startFrame: 0, endFrame: 30 },
      { text: "b", startFrame: 30, endFrame: 60 },
    ]);
  });

  it("linkedClipsStayAlignedWhenOnlyOneTrackClampsAfterRounding", () => {
    const a = Fixtures.clip({ id: "a", start: 1, duration: 1 });
    const b = Fixtures.clip({ id: "b", start: 2, duration: 2 });
    b.linkGroupId = "L";
    const audio = Fixtures.clip({ id: "audio", start: 2, duration: 2 });
    audio.linkGroupId = "L";
    const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] }), Fixtures.audioTrack({ clips: [audio] })]);
    applyTimelineSettings(e, 15, e.timeline.width, e.timeline.height);
    const v = e.timeline.tracks[0].clips.find((c) => c.id === "b");
    const au = e.timeline.tracks[1].clips[0];
    expect(au.startFrame).toBe(v?.startFrame);
    expect(au.durationFrames).toBe(v?.durationFrames);
  });

  it("roundTripUndoChainRestoresEveryStep", () => {
    const clip = Fixtures.clip({ id: "c", start: 7, duration: 101 });
    clip.trimStartFrame = 13;
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const original = timelineCopy(e);
    const states = [timelineCopy(e)];
    for (const fps of [24, 60, 30]) {
      applyTimelineSettings(e, fps, e.timeline.width, e.timeline.height);
      states.push(timelineCopy(e));
    }
    for (let i = states.length - 2; i >= 0; i--) {
      e.undo();
      expect(e.timeline).toEqual(states[i]);
    }
    expect(e.timeline).toEqual(original);
  });

  it("rescaleAccumulatesRoundingLikeSwift", () => {
    const clip = Fixtures.clip({ id: "c", start: 7, duration: 101 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    for (const fps of [24, 60, 30]) applyTimelineSettings(e, fps, e.timeline.width, e.timeline.height);
    const c = e.timeline.tracks[0].clips[0];
    expect(Math.abs(c.startFrame - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.durationFrames - 101)).toBeLessThanOrEqual(2);
  });

  it("refusesNonIntegerOrNonPositiveFps", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 0, duration: 30 })] })]);
    for (const fps of [0, -5, 29.97, Number.NaN]) applyTimelineSettings(e, fps, e.timeline.width, e.timeline.height);
    expect(e.timeline.fps).toBe(30);
    expect(e.store.canUndo).toBe(false);
  });

  it("changeToSameFpsKeepsPlayheadAndRange", () => {
    const e = makeEditor([]);
    e.ui.currentFrame = 33;
    applyTimelineSettings(e, 30, 1280, 720);
    expect(e.ui.currentFrame).toBe(33);
  });
});

describe("checkProjectSettings", () => {
  const video = makeMediaAsset({ id: "v", url: "/v", type: "video", name: "v", duration: 1 });
  video.sourceWidth = 3840;
  video.sourceHeight = 2160;
  video.sourceFPS = 59.94;

  it("autoDetectsOnFirstClip", () => {
    const e = makeEditor([]);
    expect(checkProjectSettings(e, [video]).kind).toBe("proceed");
    expect(e.timeline.width).toBe(3840);
    expect(e.timeline.fps).toBe(60);
    expect(e.timeline.settingsConfigured).toBe(true);
  });

  it("reportsMismatchWhenConfiguredAndEmpty", () => {
    const e = makeEditor([]);
    applyTimelineSettings(e, 30, 1920, 1080);
    const action = checkProjectSettings(e, [video]);
    expect(action).toEqual({ kind: "mismatch", clipFPS: 60, clipWidth: 3840, clipHeight: 2160 });
  });

  it("ignoresSubFrameSourceFps", () => {
    const odd = makeMediaAsset({ id: "o", url: "/o", type: "video", name: "o", duration: 1 });
    odd.sourceFPS = 0.2;
    const e = makeEditor([]);
    checkProjectSettings(e, [odd]);
    expect(e.timeline.fps).toBe(30);
  });

  it("proceedsWhenTimelineHasClips", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 10 })] })]);
    applyTimelineSettings(e, 30, 1920, 1080);
    expect(checkProjectSettings(e, [video]).kind).toBe("proceed");
  });
});

describe("canvas and frame-rate presets", () => {
  it("canvasPresetsResolveToEvenDimensions", () => {
    const sizes = Object.fromEntries(canvasPresets.map((p) => [p.label, canvasPresetResolution(p)]));
    expect(sizes["YouTube 16:9 1080p"]).toEqual({ width: 1920, height: 1080 });
    expect(sizes["YouTube 16:9 4K"]).toEqual({ width: 3840, height: 2160 });
    expect(sizes["TikTok / Reels / Shorts 9:16"]).toEqual({ width: 1080, height: 1920 });
    expect(sizes["Instagram Square 1:1"]).toEqual({ width: 1080, height: 1080 });
    expect(sizes["Instagram Portrait 4:5"]).toEqual({ width: 1080, height: 1350 });
    for (const r of Object.values(sizes)) expect(r.width % 2 === 0 && r.height % 2 === 0).toBe(true);
    expect(sizes["Cinema 2.39:1"].height).toBe(1080);
  });

  it("customFrameRateAcceptsOnlyWholeNumbersInRange", () => {
    expect(parseCustomFrameRate(" 48 ")).toBe(48);
    for (const bad of ["", "0", "121", "29.97", "-5", "abc"]) expect(parseCustomFrameRate(bad)).toBeUndefined();
  });
});
