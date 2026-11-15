import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clipBlurRadius,
  clipSetBlurKeyframeTrack,
  keyframeTrackSample,
  doubleInterpolator,
  makeAnimPair,
  makeKeyframe,
  makeKeyframeTrack,
  makeMediaAsset,
  makeTextAnimation,
  makeTextStyle,
  type Clip,
  type TextStyle,
} from "../../model";
import {
  applyClipProperties,
  applyClipSpeed,
  applyTextContent,
  applyTextStyle,
  applyTextStyles,
  cancelDebouncedCommit,
  clearRegion,
  commitClipProperties,
  commitClipSpeed,
  commitTextContent,
  commitTextStyle,
  debouncedCommitClipProperties,
  deleteMediaAssets,
  moveClips,
  removeClips,
  revertClipProperties,
  splitClip,
  splitClips,
  trimEndToPlayhead,
  trimStartToPlayhead,
  splitAtPlayhead,
  markPendingReplacement,
  replaceClipMediaRef,
} from "./clipMutations";
import { fitTransformForClip, pendingReplacements } from "./core";
import { editorHooks } from "./hooks";
import { Fixtures, clipById, makeAsset, makeEditor, setup, sortedByStart, timelineCopy } from "./testFixtures";

afterEach(() => {
  delete editorHooks.fitTextClipToContentIfNeeded;
  vi.useRealTimers();
});

describe("EditorViewModel - applyClipSpeed", () => {
  it("applyClipSpeedDoublesScalesDurationDownByHalf", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyClipSpeed(e, "c1", 2.0);
    const updated = e.timeline.tracks[0].clips[0];
    expect(updated.speed).toBe(2.0);
    expect(updated.durationFrames).toBe(30);
    expect(e.store.canUndo).toBe(false);
  });

  it("applyClipSpeedHalfDoublesDuration", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyClipSpeed(e, "c1", 0.5);
    expect(e.timeline.tracks[0].clips[0].durationFrames).toBe(120);
  });

  it("applyClipSpeedRipplesContiguousChainOnSameTrack", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const c2 = Fixtures.clip({ id: "c2", start: 60, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    applyClipSpeed(e, "c1", 2.0);
    const updated = sortedByStart(e.timeline.tracks[0].clips);
    expect(updated[0].durationFrames).toBe(30);
    expect(updated[1].startFrame).toBe(30);
  });

  it("applyClipSpeedDoesNotRippleNonContiguousFollowers", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const c2 = Fixtures.clip({ id: "c2", start: 100, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    applyClipSpeed(e, "c1", 2.0);
    expect(clipById(e, "c2").startFrame).toBe(100);
  });

  it("commitClipSpeedWithoutRippleLeavesContiguousNeighborsInPlace", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const c2 = Fixtures.clip({ id: "c2", start: 60, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    commitClipSpeed(e, ["c1"], 2.0, false);
    const updated = sortedByStart(e.timeline.tracks[0].clips);
    expect(updated[0].durationFrames).toBe(30);
    expect(updated[1].startFrame).toBe(60);
  });

  it("commitClipSpeedRipplesContiguousNeighborsByDefault", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const c2 = Fixtures.clip({ id: "c2", start: 60, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    commitClipSpeed(e, ["c1"], 2.0);
    const updated = sortedByStart(e.timeline.tracks[0].clips);
    expect(updated[0].durationFrames).toBe(30);
    expect(updated[1].startFrame).toBe(30);
  });

  it("applyClipSpeedRescalesKeyframesInsteadOfDroppingThem", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1.0), makeKeyframe(30, 0.5), makeKeyframe(59, 0.0)]);
    clip.scaleTrack = makeKeyframeTrack([makeKeyframe(59, makeAnimPair(2.0, 2.0))]);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);

    applyClipSpeed(e, "c1", 2.0);
    const updated = e.timeline.tracks[0].clips[0];

    expect(updated.durationFrames).toBe(30);
    expect(updated.opacityTrack?.keyframes.map((k) => k.frame)).toEqual([0, 15, 29]);
    expect(updated.scaleTrack?.keyframes.map((k) => k.frame)).toEqual([29]);
  });

  it("dragThenCommitIsOneUndoStepThatRestoresTheExactTimeline", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const c2 = Fixtures.clip({ id: "c2", start: 60, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1, c2] })]);
    const original = timelineCopy(e);
    applyClipSpeed(e, "c1", 1.5);
    applyClipSpeed(e, "c1", 2.0);
    expect(e.store.canUndo).toBe(false);
    commitClipSpeed(e, ["c1"], 2.0);
    expect(clipById(e, "c1").durationFrames).toBe(30);
    expect(e.store.undoActionName).toBe("Change Speed");
    e.undo();
    expect(e.timeline).toEqual(original);
    expect(e.store.canUndo).toBe(false);
    e.redo();
    expect(clipById(e, "c1").durationFrames).toBe(30);
    expect(clipById(e, "c2").startFrame).toBe(30);
  });

  it("commitClipSpeedWithUnchangedSpeedRecordsNothing", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 60 })] })]);
    commitClipSpeed(e, ["c1"], 1.0);
    expect(e.store.canUndo).toBe(false);
  });

  it("multicamClipsRefuseRetiming", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.multicamGroupId = "mc";
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    applyClipSpeed(e, "c1", 2.0);
    commitClipSpeed(e, ["c1"], 2.0);
    expect(e.timeline.tracks[0].clips[0].speed).toBe(1);
    expect(e.ui.toast?.message).toContain("Can't change speed on a multicam clip");
  });
});

describe("EditorViewModel - splitClip", () => {
  it("splitClipDividesAtFrameAndReturnsRightHalfId", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const rightIds = splitClip(e, "c1", 30);
    expect(rightIds.length).toBe(1);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.length).toBe(2);
    expect(clips[0].durationFrames).toBe(30);
    expect(clips[1].durationFrames).toBe(30);
    expect(clips[1].id).toBe(rightIds[0]);
  });

  it("splitClipReturnsEmptyForUnknownId", () => {
    const e = makeEditor();
    expect(splitClip(e, "ghost", 10)).toEqual([]);
  });

  it("splitAtClipBoundaryIsRejected", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    expect(splitClip(e, "c1", 0)).toEqual([]);
    expect(splitClip(e, "c1", 60)).toEqual([]);
    expect(e.timeline.tracks[0].clips.length).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("splitClipDoesNotCutAnotherClipOnSameTrack", () => {
    const e = makeEditor([
      Fixtures.videoTrack({
        clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 }), Fixtures.clip({ id: "c2", start: 30, duration: 30 })],
      }),
    ]);
    expect(splitClip(e, "c1", 45)).toEqual([]);
    expect(e.timeline.tracks[0].clips.length).toBe(2);
  });

  it("splitWithLinkedPartnerSplitsBothAndRegroupsRightHalves", () => {
    const v = Fixtures.clip({ id: "v", start: 0, duration: 60 });
    v.linkGroupId = "g1";
    const a = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 60 });
    a.linkGroupId = "g1";

    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    const before = e.timeline;
    const rightIds = new Set(splitClip(e, "v", 30));
    expect(rightIds.size, "both partners should split").toBe(2);

    const allClips = e.timeline.tracks.flatMap((t) => t.clips);
    const rightGroups = new Set(allClips.filter((c) => rightIds.has(c.id)).flatMap((c) => (c.linkGroupId ? [c.linkGroupId] : [])));
    expect(rightGroups.size).toBe(1);
    expect([...rightGroups][0]).not.toBe("g1");

    const leftIds = new Set(["v", "a"]);
    const leftGroups = new Set(allClips.filter((c) => leftIds.has(c.id)).flatMap((c) => (c.linkGroupId ? [c.linkGroupId] : [])));
    expect([...leftGroups]).toEqual(["g1"]);

    // One user intent, one undo entry, exact restore.
    e.undo();
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("splitClipsAtMultiplePointsCutsEachAndSkipsBoundaries", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 90 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const rightIds = splitClips(e, [
      { trackIndex: 0, atFrame: 30 },
      { trackIndex: 0, atFrame: 60 },
      { trackIndex: 0, atFrame: 30 },
    ]);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.map((c) => c.startFrame)).toEqual([0, 30, 60]);
    expect(clips.map((c) => c.durationFrames)).toEqual([30, 30, 30]);
    expect(rightIds.length).toBe(2);
    expect(e.store.undoActionName).toBe("Split Clips");
  });

  it("splitClipKeepsSegmentInterpolationOnRightHalf", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1.0, "hold"), makeKeyframe(30, 0.5)]);
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(20, 20.0)]);
    clipSetBlurKeyframeTrack(clip, makeKeyframeTrack([makeKeyframe(0, 0.0, "linear"), makeKeyframe(20, 20.0)]));
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const rightId = splitClip(e, "c1", 10)[0];
    const right = clipById(e, rightId);
    expect(right.opacityTrack && keyframeTrackSample(right.opacityTrack, 5, 0.0, doubleInterpolator)).toBe(1.0);
    expect(right.rotationTrack && keyframeTrackSample(right.rotationTrack, 5, 0.0, doubleInterpolator)).toBe(15.0);
    expect(clipBlurRadius(right, 15)).toBe(15.0);
  });

  it("splitClipZerosOpacityFadesAcrossCut", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.fadeInFrames = 15;
    clip.fadeOutFrames = 20;
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    splitClip(e, "c1", 30);
    const halves = sortedByStart(e.timeline.tracks[0].clips);
    expect(halves.length).toBe(2);
    expect(halves[0].fadeInFrames).toBe(15);
    expect(halves[0].fadeOutFrames).toBe(0);
    expect(halves[1].fadeInFrames).toBe(0);
    expect(halves[1].fadeOutFrames).toBe(20);
  });

  it("splitAtPlayheadSplitsEverySelectedClipAsOneUndoStep", () => {
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 60 })] }),
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c2", start: 0, duration: 60 })] }),
    ]);
    e.ui.selectedClipIds = new Set(["c1", "c2"]);
    e.ui.currentFrame = 20;
    splitAtPlayhead(e);
    expect(e.timeline.tracks.map((t) => t.clips.length)).toEqual([2, 2]);
    e.undo();
    expect(e.timeline.tracks.map((t) => t.clips.length)).toEqual([1, 1]);
    expect(e.store.canUndo).toBe(false);
  });

  it("trimToPlayheadTrimsSourceThroughSpeed", () => {
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 60, speed: 2 })] }),
    ]);
    e.ui.selectedClipIds = new Set(["c1"]);
    e.ui.currentFrame = 20;
    trimStartToPlayhead(e);
    let c = clipById(e, "c1");
    expect([c.startFrame, c.durationFrames, c.trimStartFrame]).toEqual([20, 40, 40]);
    e.ui.currentFrame = 50;
    trimEndToPlayhead(e);
    c = clipById(e, "c1");
    expect([c.startFrame, c.durationFrames, c.trimEndFrame]).toEqual([20, 30, 20]);
  });
});

describe("EditorViewModel - removeClips", () => {
  it("removeClipsPrunesEmptyTracksByDefault", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    removeClips(e, new Set(["c1"]));
    expect(e.timeline.tracks).toEqual([]);
  });

  it("removeClipsWithPruneFalseKeepsEmptyTracks", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    removeClips(e, new Set(["c1"]), false);
    expect(e.timeline.tracks.length).toBe(1);
    expect(e.timeline.tracks[0].clips).toEqual([]);
  });

  it("removeClipsIsNoOpForUnknownIds", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    removeClips(e, new Set(["ghost"]));
    expect(e.timeline.tracks[0].clips.length).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("removeClipsAlsoClearsSelection", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    e.ui.selectedClipIds = new Set(["c1", "ghost"]);
    removeClips(e, new Set(["c1"]));
    expect(e.ui.selectedClipIds.has("c1")).toBe(false);
  });

  it("removeClipsUndoRestoresTheTrackAndClip", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    const before = e.timeline;
    removeClips(e, new Set(["c1"]));
    expect(e.store.undoActionName).toBe("Remove Clip");
    e.undo();
    expect(e.timeline).toBe(before);
  });
});

describe("EditorViewModel - moveClips", () => {
  it("moveClipsMovesSingleClipToTargetTrackAndFrame", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1] }), Fixtures.videoTrack({ clips: [] })]);
    const destTrackId = e.timeline.tracks[1].id;
    moveClips(e, [{ clipId: "c1", toTrack: 1, toFrame: 100 }]);
    const loc = e.findClip("c1");
    if (!loc) throw new Error("clip lost");
    expect(e.timeline.tracks[loc.trackIndex].id).toBe(destTrackId);
    expect(e.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame).toBe(100);
  });

  it("moveClipsRejectsIncompatibleTrackType", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1] }), Fixtures.audioTrack({ clips: [] })]);
    moveClips(e, [{ clipId: "c1", toTrack: 1, toFrame: 100 }]);
    const loc = e.findClip("c1");
    if (!loc) throw new Error("clip lost");
    expect(e.timeline.tracks[loc.trackIndex].type).toBe("video");
    expect(e.store.canUndo).toBe(false);
  });

  it("moveClipsClampsNegativeFrameToZero", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1] }), Fixtures.videoTrack({ clips: [] })]);
    moveClips(e, [{ clipId: "c1", toTrack: 1, toFrame: -50 }]);
    const loc = e.findClip("c1");
    if (!loc) throw new Error("clip lost");
    expect(e.timeline.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame).toBe(0);
  });

  it("moveOverwritesBlockingClipAndUndoRestoresExactly", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const blocker = Fixtures.clip({ id: "blocker", start: 40, duration: 60, trimStart: 5 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [c1] }), Fixtures.videoTrack({ clips: [blocker] })]);
    const before = e.timeline;
    moveClips(e, [{ clipId: "c1", toTrack: 1, toFrame: 50 }]);
    expect(e.timeline.tracks.length).toBe(1);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.map((c) => [c.id, c.startFrame, c.durationFrames])).toEqual([
      ["blocker", 40, 10],
      ["c1", 50, 30],
      [clips[2].id, 80, 20],
    ]);
    expect(e.store.undoActionName).toBe("Move Clip");
    e.undo();
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("movingPartOfAMulticamGroupIsRefusedWithToast", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 30 });
    const b = Fixtures.clip({ id: "b", start: 0, duration: 30 });
    a.multicamGroupId = "mc";
    b.multicamGroupId = "mc";
    const e = makeEditor([Fixtures.videoTrack({ clips: [a] }), Fixtures.videoTrack({ clips: [b] })]);
    moveClips(e, [{ clipId: "a", toTrack: 0, toFrame: 100 }]);
    expect(e.timeline.tracks[0].clips[0].startFrame).toBe(0);
    expect(e.ui.toast?.message).toContain("Can't move part of multicam group");
    expect(e.store.canUndo).toBe(false);
  });
});

describe("EditorViewModel - clip property commits", () => {
  it("editingMultilineTextResizesAndUndoesTheTextBoxAtomically", () => {
    // Stand-in for TextLayout: box height grows with the number of lines, anchored on its center.
    editorHooks.fitTextClipToContentIfNeeded = (_e, clip) => {
      const lines = (clip.textContent ?? " ").split("\n").length;
      clip.transform.height = 0.1 * lines;
      return true;
    };
    const originalContent = "Text";
    const clip = Fixtures.clip({ id: "text", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    clip.textContent = originalContent;
    clip.textStyle = makeTextStyle();
    clip.transform = { ...clip.transform, width: 0.2, height: 0.1 };
    const originalTransform = structuredClone(clip.transform);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const multiline = "Text\nfasfasf\nfsafasff\nfasfsafsa\nfasfasfas\nfasfasffs";

    applyTextContent(e, clip.id, multiline);
    const resized = clipById(e, clip.id);
    expect(resized.textContent).toBe(multiline);
    expect(resized.transform.height).toBeGreaterThan(originalTransform.height);
    expect(resized.transform.centerY).toBe(originalTransform.centerY);
    expect(e.store.canUndo).toBe(false);

    commitTextContent(e, clip.id, multiline);
    expect(e.store.undoActionName).toBe("Change Text");
    e.undo();
    const restored = clipById(e, clip.id);
    expect(restored.textContent).toBe(originalContent);
    expect(restored.transform).toEqual(originalTransform);
    expect(e.store.canUndo).toBe(false);
  });

  it("scalingTextPreservesAuthoredStyleAndUndoesTheBoxAtomically", () => {
    editorHooks.fitTextClipToContentIfNeeded = (_e, clip) => {
      const scale = clip.textStyle?.fontScale ?? 1;
      clip.transform.width = 0.8 * scale;
      clip.transform.height = 0.4 * scale;
      return true;
    };
    const style = makeTextStyle({ tracking: 18, lineSpacing: 24 });
    const clip = Fixtures.clip({ id: "text", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    clip.textContent = "fasfasfasf\nsfsaf\nsfasfsaf";
    clip.textStyle = style;
    clip.transform = { ...clip.transform, width: 0.8, height: 0.4 };
    const original = structuredClone(clip);
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const setScale = (s: TextStyle): void => {
      s.fontScale = 0.25;
    };

    applyTextStyle(e, clip.id, setScale, true);
    const scaled = clipById(e, clip.id);
    expect(scaled.textStyle?.fontScale).toBe(0.25);
    expect(scaled.textStyle?.tracking).toBe(style.tracking);
    expect(scaled.textStyle?.lineSpacing).toBe(style.lineSpacing);
    expect(Math.abs(scaled.transform.width - original.transform.width * 0.25)).toBeLessThan(0.002);
    expect(Math.abs(scaled.transform.height - original.transform.height * 0.25)).toBeLessThan(0.002);

    commitTextStyle(e, clip.id, setScale, true);
    e.undo();
    expect(clipById(e, clip.id)).toEqual(original);
    expect(e.store.canUndo).toBe(false);
  });

  it("committingScaleResetCanReadActiveTimeline", () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    clip.transform.width = 0.5;
    clip.transform.height = 0.5;
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    const asset = makeMediaAsset({ id: clip.mediaRef, url: "/tmp/media.mov", type: "video", name: "media", duration: 1 });
    asset.sourceWidth = 1920;
    asset.sourceHeight = 1080;
    setup(e, () => {
      e.doc.mediaAssets = [asset];
    });

    commitClipProperties(
      e,
      [clip.id],
      (c) => {
        c.transform = fitTransformForClip(e, c);
      },
      "Reset Scale",
    );

    expect(clipById(e, clip.id).transform.width).toBe(1);
    expect(clipById(e, clip.id).transform.height).toBe(1);
    expect(e.store.undoActionName).toBe("Reset Scale");
  });

  it("commitClipPropertiesGroupsMultipleClipUndo", () => {
    const a = Fixtures.clip({ id: "a", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    const b = Fixtures.clip({ id: "b", mediaRef: "text", mediaType: "text", start: 30, duration: 30 });
    a.textContent = "one";
    b.textContent = "two";
    const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] })]);

    commitClipProperties(e, ["a", "b"], (c) => {
      c.textAnimation = makeTextAnimation({ preset: "wordSlide" });
    });

    expect(e.timeline.tracks[0].clips.every((c) => c.textAnimation?.preset === "wordSlide")).toBe(true);
    e.undo();
    expect(e.timeline.tracks[0].clips.every((c) => c.textAnimation === undefined)).toBe(true);
    expect(e.store.canUndo).toBe(false);
    e.redo();
    expect(e.timeline.tracks[0].clips.every((c) => c.textAnimation?.preset === "wordSlide")).toBe(true);
    expect(e.store.canRedo).toBe(false);
  });

  it("bulkClipPropertyPreviewCommitAndUndoResolveAcrossTracks", () => {
    const a = Fixtures.clip({ id: "a", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    const b = Fixtures.clip({ id: "b", mediaRef: "text", mediaType: "text", start: 30, duration: 30 });
    const c = Fixtures.clip({ id: "c", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [a, b] }), Fixtures.videoTrack({ clips: [c] })]);

    const selectedIds = ["c", "missing", "a"];
    applyClipProperties(e, selectedIds, (clip) => {
      clip.opacity = 0.25;
    });
    expect(e.store.canUndo).toBe(false);
    commitClipProperties(e, selectedIds, (clip) => {
      clip.opacity = 0.25;
    });

    expect(clipById(e, "a").opacity).toBe(0.25);
    expect(clipById(e, "b").opacity).toBe(1);
    expect(clipById(e, "c").opacity).toBe(0.25);
    e.undo();
    expect(clipById(e, "a").opacity).toBe(1);
    expect(clipById(e, "b").opacity).toBe(1);
    expect(clipById(e, "c").opacity).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("commitWithoutChangeRecordsNothing", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [a] })]);
    commitClipProperties(e, ["a"], (clip) => {
      clip.opacity = 1;
    });
    expect(e.store.canUndo).toBe(false);
  });

  it("livePreviewThatIsDraggedBackToTheOriginalRecordsNothing", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [a] })]);
    applyClipProperties(e, ["a"], (clip) => {
      clip.opacity = 0.4;
    });
    commitClipProperties(e, ["a"], (clip) => {
      clip.opacity = 1;
    });
    expect(clipById(e, "a").opacity).toBe(1);
    expect(e.store.canUndo).toBe(false);
  });

  it("bulkClipPropertyRevertRestoresMixedTextStylesAcrossTracks", () => {
    const a = Fixtures.clip({ id: "a", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    const b = Fixtures.clip({ id: "b", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    a.textStyle = makeTextStyle({ fontName: "Helvetica", fontSize: 48 });
    b.textStyle = makeTextStyle({ fontName: "Avenir", fontSize: 64 });
    const original = [structuredClone(a), structuredClone(b)];
    const e = makeEditor([Fixtures.videoTrack({ clips: [a] }), Fixtures.videoTrack({ clips: [b] })]);

    applyTextStyles(
      e,
      ["a", "b"],
      (s) => {
        s.fontName = "Courier";
      },
      true,
    );
    expect(clipById(e, "a").textStyle?.fontName).toBe("Courier");
    revertClipProperties(e, ["b", "missing", "a"]);

    expect(clipById(e, "a")).toEqual(original[0]);
    expect(clipById(e, "b")).toEqual(original[1]);
    expect(e.store.canUndo).toBe(false);
  });

  it("cancelDebouncedCommitPreventsPendingHighlightWrite", () => {
    vi.useFakeTimers();
    const clip = Fixtures.clip({ id: "caption", mediaRef: "text", mediaType: "text", start: 0, duration: 30 });
    clip.textAnimation = makeTextAnimation({ preset: "highlightPop", highlight: { r: 1, g: 0, b: 0, a: 1 } });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);

    debouncedCommitClipProperties(
      e,
      ["caption"],
      "textHighlight",
      (c: Clip) => {
        const animation = c.textAnimation ?? makeTextAnimation();
        animation.highlight = { r: 0, g: 0, b: 1, a: 1 };
        c.textAnimation = animation;
      },
      5,
    );
    cancelDebouncedCommit(e, "textHighlight");
    commitClipProperties(e, ["caption"], (c) => {
      delete c.textAnimation;
    });

    vi.advanceTimersByTime(20);
    expect(e.timeline.tracks[0].clips[0].textAnimation).toBeUndefined();
  });

  it("debouncedCommitCommitsOnceAfterTheDelay", () => {
    vi.useFakeTimers();
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    debouncedCommitClipProperties(e, ["c"], "k", (c) => {
      c.opacity = 0.3;
    }, 400);
    expect(clipById(e, "c").opacity).toBe(0.3);
    expect(e.store.canUndo).toBe(false);
    vi.advanceTimersByTime(400);
    expect(e.store.canUndo).toBe(true);
    e.undo();
    expect(clipById(e, "c").opacity).toBe(1);
  });
});

describe("EditorViewModel - clearRegion", () => {
  it("clearRegionRemovesClipFullyInside", () => {
    const inside = Fixtures.clip({ id: "inside", start: 50, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [inside] })]);
    clearRegion(e, 0, 0, 100);
    expect(e.timeline.tracks.length === 0 || e.timeline.tracks[0].clips.length === 0).toBe(true);
  });

  it("clearRegionTrimsLeftOverlapper", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 100 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    clearRegion(e, 0, 50, 200);
    const remaining = e.timeline.tracks[0].clips[0];
    expect(remaining.startFrame).toBe(0);
    expect(remaining.durationFrames).toBe(50);
    expect(remaining.trimEndFrame).toBe(50);
  });

  it("clearRegionTrimsRightOverlapper", () => {
    const clip = Fixtures.clip({ id: "c1", start: 100, duration: 100 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    clearRegion(e, 0, 0, 150);
    const remaining = e.timeline.tracks[0].clips[0];
    expect(remaining.startFrame).toBe(150);
    expect(remaining.durationFrames).toBe(50);
    expect(remaining.trimStartFrame).toBe(50);
  });

  it("clearRegionLeavesAdjacentClipUntouched", () => {
    const clip = Fixtures.clip({ id: "c1", start: 100, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    clearRegion(e, 0, 0, 100);
    expect(e.timeline.tracks[0].clips[0].startFrame).toBe(100);
    expect(e.timeline.tracks[0].clips[0].durationFrames).toBe(30);
    expect(e.store.canUndo).toBe(false);
  });

  it("clearRegionSplitsAnEnvelopingClipAndDropsTheMiddle", () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 200 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    clearRegion(e, 0, 50, 150);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.map((c) => [c.startFrame, c.durationFrames, c.trimStartFrame, c.trimEndFrame])).toEqual([
      [0, 50, 0, 150],
      [150, 50, 150, 0],
    ]);
  });
});

describe("EditorViewModel - media swap and delete", () => {
  it("replaceClipMediaRefSwapsLinkedClipsInOneUndoStep", () => {
    const v = Fixtures.clip({ id: "v", mediaRef: "old", start: 0, duration: 30 });
    v.linkGroupId = "g";
    const a = Fixtures.clip({ id: "a", mediaRef: "old", mediaType: "audio", start: 0, duration: 30 });
    a.linkGroupId = "g";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    const before = timelineCopy(e);
    replaceClipMediaRef(e, "v", "new", { resetTrim: true });
    expect(clipById(e, "v").mediaRef).toBe("new");
    expect(clipById(e, "a").mediaRef).toBe("new");
    expect(e.store.undoActionName).toBe("Replace Clip Source");
    e.undo();
    expect(e.timeline).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("markPendingReplacementFlagsTheLinkedClipsSharingMedia", () => {
    const v = Fixtures.clip({ id: "v", mediaRef: "m", start: 0, duration: 30 });
    v.linkGroupId = "g";
    const a = Fixtures.clip({ id: "a", mediaRef: "m", mediaType: "audio", start: 0, duration: 30 });
    a.linkGroupId = "g";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    markPendingReplacement(e, "v");
    expect([...pendingReplacements(e)].sort()).toEqual(["a", "v"]);
  });

  it("deleteMediaAssetsRemovesReferencingClipsAndUndoRestoresEverything", () => {
    const keep = Fixtures.clip({ id: "keep", mediaRef: "keepAsset", start: 0, duration: 30 });
    const drop = Fixtures.clip({ id: "drop", mediaRef: "dropAsset", start: 30, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [keep, drop] }), Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "d2", mediaRef: "dropAsset", start: 0, duration: 10 })] })]);
    setup(e, () => {
      e.doc.mediaAssets = [makeAsset({ id: "keepAsset", type: "video", duration: 1 }), makeAsset({ id: "dropAsset", type: "video", duration: 1 })];
    });
    const before = e.store.committed;
    e.ui.selectedClipIds = new Set(["drop", "keep"]);
    deleteMediaAssets(e, new Set(["dropAsset"]));
    expect(e.mediaAssets.map((a) => a.id)).toEqual(["keepAsset"]);
    expect(e.timeline.tracks.length).toBe(1);
    expect(e.timeline.tracks[0].clips.map((c) => c.id)).toEqual(["keep"]);
    expect([...e.ui.selectedClipIds]).toEqual(["keep"]);
    expect(e.store.undoActionName).toBe("Delete Media");
    e.undo();
    expect(e.store.committed).toEqual(before);
    deleteMediaAssets(e, new Set(["ghost"]));
    expect(e.store.canUndo).toBe(false);
  });
});
