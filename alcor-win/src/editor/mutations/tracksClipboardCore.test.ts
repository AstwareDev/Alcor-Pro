import { describe, expect, it } from "vitest";
import { makeMediaAsset, makeTimeline, TrackNameValidationError } from "../../model";
import {
  copySelectedClipsToClipboard,
  duplicateClipsToPositions,
  pasteClips,
  pasteClipsAtPlayhead,
  canPasteClips,
} from "./clipboard";
import {
  cropFittingAspect,
  displayedCropAspectRatio,
  fitTransform,
  fitTransformForAsset,
  mediaCanvasAspectForAsset,
  mediaCanvasAspectForClip,
  placeClip,
  seekToFrame,
  skipBackward,
  skipForward,
  sourceDimensions,
  stepBackward,
  stepForward,
} from "./core";
import { existingTrack, newTrackAt, placeDroppedAssets, resolveAudioDropTarget, resolveVisualDropTarget } from "./linking";
import {
  commitTrackReorder,
  insertTrack,
  removeTracks,
  reorderTrackLive,
  setTrackHeight,
  setTrackName,
  timelineTrackDisplayLabel,
  toggleTrackMute,
  toggleTrackSyncLock,
} from "./tracks";
import { Fixtures, allClips, clipById, makeAsset, makeEditor, setup, sortedByStart, timelineCopy } from "./testFixtures";

describe("tracks", () => {
  it("insertTrackClampsToTypeZoneAndUndoes", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "v1" }), Fixtures.audioTrack({ id: "a1" })]);
    const before = e.timeline;
    expect(insertTrack(e, 99, "video")).toBe(1);
    expect(insertTrack(e, 0, "audio")).toBe(2);
    expect(e.timeline.tracks.map((t) => t.type)).toEqual(["video", "video", "audio", "audio"]);
    expect(e.store.undoActionName).toBe("Add Track");
    e.undo();
    e.undo();
    expect(e.timeline).toBe(before);
  });

  it("displayLabelsCountVideoUpwardsAndAudioDownwards", () => {
    const e = makeEditor([
      Fixtures.videoTrack(),
      Fixtures.videoTrack(),
      Fixtures.audioTrack(),
      Fixtures.audioTrack(),
    ]);
    expect([0, 1, 2, 3].map((i) => timelineTrackDisplayLabel(e, i))).toEqual(["V2", "V1", "A1", "A2"]);
    expect(timelineTrackDisplayLabel(e, 9)).toBe("");
  });

  it("nameSurvivesComputedDesignationReorder", () => {
    const e = makeEditor([Fixtures.videoTrack(), Fixtures.videoTrack()]);
    const trackId = e.timeline.tracks[0].id;

    expect(setTrackName(e, trackId, "  B-roll  ")).toBe(true);
    expect(timelineTrackDisplayLabel(e, 0)).toBe("V2");
    expect(e.timeline.tracks[0].name).toBe("B-roll");

    reorderTrackLive(e, trackId, 1);
    expect(timelineTrackDisplayLabel(e, 1)).toBe("V1");
    expect(e.timeline.tracks[1].name).toBe("B-roll");
    expect(() => setTrackName(e, trackId, "Bad\nName")).toThrow(TrackNameValidationError);
    expect(e.timeline.tracks[1].name).toBe("B-roll");
  });

  it("setTrackNameValidatesNormalizesAndSkipsNoOps", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "v1" })]);
    expect(setTrackName(e, "v1", "  Main  ")).toBe(true);
    expect(e.timeline.tracks[0].name).toBe("Main");
    expect(setTrackName(e, "v1", "Main")).toBe(false);
    expect(setTrackName(e, "ghost", "x")).toBe(false);
    expect(() => setTrackName(e, "v1", "bad\nname")).toThrow(TrackNameValidationError);
    expect(setTrackName(e, "v1", "   ")).toBe(true);
    expect(e.timeline.tracks[0].name).toBeUndefined();
    e.undo();
    expect(e.timeline.tracks[0].name).toBe("Main");
  });

  it("liveReorderCommitsAsOneUndoStep", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "a" }), Fixtures.videoTrack({ id: "b" }), Fixtures.audioTrack({ id: "x" })]);
    const before = timelineCopy(e);
    reorderTrackLive(e, "a", 5);
    expect(e.timeline.tracks.map((t) => t.id)).toEqual(["b", "a", "x"]);
    expect(e.store.canUndo).toBe(false);
    commitTrackReorder(e, before);
    expect(e.store.undoActionName).toBe("Reorder Track");
    e.undo();
    expect(e.timeline).toEqual(before);
    expect(e.store.canUndo).toBe(false);
    commitTrackReorder(e, before);
    expect(e.store.canUndo).toBe(false);
  });

  it("togglesAndHeightRecordNamedUndoSteps", () => {
    const e = makeEditor([Fixtures.videoTrack()]);
    toggleTrackMute(e, 0);
    expect(e.timeline.tracks[0].muted).toBe(true);
    expect(e.store.undoActionName).toBe("Mute Track");
    toggleTrackMute(e, 0);
    expect(e.store.undoActionName).toBe("Unmute Track");
    toggleTrackMute(e, 7);
    setTrackHeight(e, 0, 1000);
    expect(e.timeline.tracks[0].displayHeight).toBe(200);
    setTrackHeight(e, 0, 1);
    expect(e.timeline.tracks[0].displayHeight).toBe(32);
  });

  it("syncLockCannotBeDroppedOnMulticamTrack", () => {
    const clip = Fixtures.clip({ id: "c", start: 0, duration: 30 });
    clip.multicamGroupId = "mc";
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    setup(e, () => {
      e.doc.multicamGroups.push({ id: "mc", name: "Interview", members: [], masterMemberId: "" });
    });
    toggleTrackSyncLock(e, 0);
    expect(e.timeline.tracks[0].syncLocked).toBe(true);
    expect(e.ui.toast?.message).toContain("Interview");
    expect(e.store.canUndo).toBe(false);
  });

  it("removeTracksIsNoOpForUnknownIds", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "a" })]);
    removeTracks(e, ["ghost"]);
    expect(e.store.canUndo).toBe(false);
    removeTracks(e, ["a"]);
    expect(e.timeline.tracks).toEqual([]);
    expect(e.store.undoActionName).toBe("Remove Track");
  });
});

describe("clipboard", () => {
  it("copyThenPasteAtPlayheadClonesWithFreshIdsAndOneUndoStep", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 10, duration: 20 });
    const c2 = Fixtures.clip({ id: "c2", start: 40, duration: 20 });
    const e = makeEditor([Fixtures.videoTrack({ id: "t", clips: [c1, c2] })]);
    e.ui.selectedClipIds = new Set(["c1", "c2"]);
    copySelectedClipsToClipboard(e);
    expect(canPasteClips(e)).toBe(true);
    const before = e.timeline;
    e.ui.currentFrame = 100;
    pasteClipsAtPlayhead(e);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.map((c) => c.startFrame)).toEqual([10, 40, 100, 130]);
    expect(new Set(clips.map((c) => c.id)).size).toBe(4);
    expect(e.ui.selectedClipIds.size).toBe(2);
    expect([...e.ui.selectedClipIds].every((id) => id !== "c1" && id !== "c2")).toBe(true);
    expect(e.store.undoActionName).toBe("Paste Clips");
    e.undo();
    expect(e.timeline).toBe(before);
  });

  it("pasteDropsLoneLinkGroupAndRegroupsPairs", () => {
    const v = Fixtures.clip({ id: "v", start: 0, duration: 20 });
    v.linkGroupId = "g";
    const a = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 20 });
    a.linkGroupId = "g";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    e.ui.selectedClipIds = new Set(["v", "a"]);
    copySelectedClipsToClipboard(e);
    pasteClips(e, 0, 50);
    const pasted = allClips(e).filter((c) => c.startFrame === 50);
    expect(pasted.length).toBe(2);
    expect(pasted[0].linkGroupId).toBeDefined();
    expect(pasted[0].linkGroupId).toBe(pasted[1].linkGroupId);
    expect(pasted[0].linkGroupId).not.toBe("g");

    e.ui.selectedClipIds = new Set(["v"]);
    copySelectedClipsToClipboard(e);
    pasteClips(e, 0, 200);
    const lone = allClips(e).filter((c) => c.startFrame === 200);
    expect(lone.length).toBe(1);
    expect(lone[0].linkGroupId).toBeUndefined();
  });

  it("pasteOverwritesWhatItLandsOn", () => {
    const src = Fixtures.clip({ id: "src", start: 0, duration: 20 });
    const under = Fixtures.clip({ id: "under", start: 100, duration: 60 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [src, under] })]);
    e.ui.selectedClipIds = new Set(["src"]);
    copySelectedClipsToClipboard(e);
    pasteClips(e, 0, 120);
    const clips = sortedByStart(e.timeline.tracks[0].clips);
    expect(clips.map((c) => [c.startFrame, c.durationFrames])).toEqual([[0, 20], [100, 20], [120, 20], [140, 20]]);
  });

  it("pasteSkipsIncompatibleTracksAndEmptyClipboardIsNoOp", () => {
    const e = makeEditor([Fixtures.audioTrack()]);
    pasteClips(e, 0, 0);
    expect(e.store.canUndo).toBe(false);
    const v = Fixtures.clip({ id: "v", start: 0, duration: 20 });
    const e2 = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack()]);
    e2.ui.selectedClipIds = new Set(["v"]);
    copySelectedClipsToClipboard(e2);
    pasteClips(e2, 1, 0);
    expect(e2.store.canUndo).toBe(false);
  });

  it("duplicateClipsToPositionsCopiesAndSelectsTheCopies", () => {
    const c = Fixtures.clip({ id: "c", start: 0, duration: 20 });
    c.multicamGroupId = "mc";
    const e = makeEditor([Fixtures.videoTrack({ clips: [c] }), Fixtures.videoTrack()]);
    duplicateClipsToPositions(e, [{ clipId: "c", toTrack: 1, toFrame: 30 }]);
    expect(e.timeline.tracks[0].clips.length).toBe(1);
    const copy = e.timeline.tracks[1].clips[0];
    expect(copy.startFrame).toBe(30);
    expect(copy.id).not.toBe("c");
    expect(copy.multicamGroupId).toBeUndefined();
    expect([...e.ui.selectedClipIds]).toEqual([copy.id]);
    expect(e.store.undoActionName).toBe("Duplicate Clip");
  });
});

describe("core", () => {
  it("fitTransformLetterboxesAndPillarboxes", () => {
    expect(fitTransform(1920, 1080, 1920, 1080)).toMatchObject({ width: 1, height: 1 });
    const wide = fitTransform(2000, 1000, 1000, 1000);
    expect(wide.width).toBe(1);
    expect(wide.height).toBeCloseTo(0.5);
    const tall = fitTransform(1000, 2000, 1000, 1000);
    expect(tall.width).toBeCloseTo(0.5);
    expect(tall.height).toBe(1);
    expect(fitTransform(0, 100, 100, 100)).toMatchObject({ width: 1, height: 1 });
  });

  it("assetAndClipAspectsFollowTheCanvas", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", mediaRef: "m", start: 0, duration: 10 })] })]);
    const asset = makeAsset({ id: "m", type: "video", duration: 1, sourceWidth: 1000, sourceHeight: 1000 });
    expect(fitTransformForAsset(e, asset).width).toBeCloseTo(1080 / 1920);
    expect(mediaCanvasAspectForAsset(asset, 1920, 1080)).toBeCloseTo(1080 / 1920);
    expect(mediaCanvasAspectForAsset(makeAsset({ id: "n", type: "video", duration: 1 }), 1920, 1080)).toBeUndefined();
    setup(e, () => {
      e.doc.mediaAssets.push(asset);
    });
    expect(sourceDimensions(e, clipById(e, "c"))).toEqual({ width: 1000, height: 1000 });
    expect(mediaCanvasAspectForClip(e, clipById(e, "c"))).toBeCloseTo(1080 / 1920);
  });

  it("sourceDimensionsFallsBackToNestedTimelineSize", () => {
    const nest = Fixtures.clip({ id: "n", mediaRef: "child", start: 0, duration: 10 });
    nest.sourceClipType = "sequence";
    const e = makeEditor([Fixtures.videoTrack({ clips: [nest] })]);
    setup(e, () => {
      e.doc.timelines.push(makeTimeline({ id: "child", width: 800, height: 600 }));
    });
    expect(sourceDimensions(e, clipById(e, "n"))).toEqual({ width: 800, height: 600 });
  });

  it("cropFittingAspectSplitsTheExcessByAnchor", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", mediaRef: "m", start: 0, duration: 10 })] })]);
    setup(e, () => {
      e.doc.mediaAssets.push(makeAsset({ id: "m", type: "video", duration: 1, sourceWidth: 2000, sourceHeight: 1000 }));
    });
    const c = clipById(e, "c");
    expect(cropFittingAspect(e, c, 1)).toEqual({ left: 0.25, top: 0, right: 0.25, bottom: 0 });
    expect(cropFittingAspect(e, c, 1, 0, 0)).toEqual({ left: 0, top: 0, right: 0.5, bottom: 0 });
    expect(cropFittingAspect(e, c, 2)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(cropFittingAspect(e, c, 4).top).toBeCloseTo(0.25);
    const ratio = displayedCropAspectRatio(e, c);
    expect(ratio).toEqual({ horizontal: 2, vertical: 1 });
  });

  it("seekHelpersClampToTheTimeline", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 100 })] })]);
    seekToFrame(e, 500);
    expect(e.ui.currentFrame).toBe(100);
    seekToFrame(e, -5);
    expect(e.ui.currentFrame).toBe(0);
    stepForward(e);
    skipForward(e);
    expect(e.ui.currentFrame).toBe(6);
    stepBackward(e);
    skipBackward(e, 50);
    expect(e.ui.currentFrame).toBe(0);
  });

  it("placeClipLinksAudioAndTrimsTheTailFromTheAssetDuration", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "v" }), Fixtures.audioTrack({ id: "a" })]);
    const asset = makeAsset({ id: "m", type: "video", duration: 4, hasAudio: true, sourceWidth: 1920, sourceHeight: 1080 });
    const ids = placeClip(e, asset, 0, 10, 60, { trimStartFrame: 30 });
    expect(ids.length).toBe(2);
    const v = clipById(e, ids[0]);
    const a = clipById(e, ids[1]);
    expect(v.linkGroupId).toBeDefined();
    expect(v.linkGroupId).toBe(a.linkGroupId);
    expect(a.mediaType).toBe("audio");
    expect(a.sourceClipType).toBe("video");
    expect([v.trimStartFrame, v.trimEndFrame]).toEqual([30, 30]);
    expect(e.timeline.tracks[1].clips[0].id).toBe(a.id);
    expect(placeClip(e, asset, 9, 0, 10)).toEqual([]);
  });

  it("placeClipWithSourceSegmentUsesSegmentStartAndRemainingTail", () => {
    const e = makeEditor([Fixtures.videoTrack({ id: "v" })]);
    const asset = makeAsset({ id: "m", type: "video", duration: 10, hasAudio: false });
    const [id] = placeClip(e, asset, 0, 0, 60, { sourceSegment: { lowerBound: 2, upperBound: 4 } });
    const c = clipById(e, id ?? "");
    expect([c.trimStartFrame, c.trimEndFrame]).toEqual([60, 180]);
  });

  it("dropTargetsMirrorAcrossTheZoneDivider", () => {
    const e = makeEditor([Fixtures.videoTrack(), Fixtures.videoTrack(), Fixtures.audioTrack(), Fixtures.audioTrack()]);
    expect(resolveVisualDropTarget(e, existingTrack(2))).toEqual(existingTrack(1));
    expect(resolveVisualDropTarget(e, existingTrack(3))).toEqual(existingTrack(0));
    expect(resolveVisualDropTarget(e, newTrackAt(3))).toEqual(newTrackAt(1));
    expect(resolveAudioDropTarget(e, existingTrack(1))).toEqual(existingTrack(2));
    expect(resolveAudioDropTarget(e, existingTrack(0))).toEqual(existingTrack(3));
    expect(resolveAudioDropTarget(e, newTrackAt(1))).toEqual(newTrackAt(3));
    const empty = makeEditor();
    expect(resolveVisualDropTarget(empty, existingTrack(0))).toEqual(newTrackAt(0));
    expect(resolveAudioDropTarget(empty, existingTrack(0))).toEqual(newTrackAt(1));
  });

  it("placeDroppedAssetsOnAnEmptyTimelineCreatesTracksInOneUndoStep", () => {
    const e = makeEditor();
    const before = e.timeline;
    const asset = makeMediaAsset({ id: "m", url: "/tmp/m", type: "video", name: "m", duration: 2 });
    asset.hasAudio = true;
    placeDroppedAssets(e, [asset], newTrackAt(0), 0, { ripple: false });
    expect(e.timeline.tracks.map((t) => t.type)).toEqual(["video", "audio"]);
    expect(e.timeline.tracks.every((t) => t.clips.length === 1)).toBe(true);
    expect(e.timeline.tracks[0].clips[0].linkGroupId).toBe(e.timeline.tracks[1].clips[0].linkGroupId);
    expect(e.store.undoActionName).toBe("Add Clips");
    e.undo();
    expect(e.timeline).toBe(before);
    expect(e.store.canUndo).toBe(false);
  });
});
