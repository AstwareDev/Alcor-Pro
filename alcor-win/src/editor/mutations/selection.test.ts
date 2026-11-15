import { describe, expect, it } from "vitest";
import { selectAllClips } from "./tracks";
import { selectForward, selectForwardFromCurrentSelection, selectPreviewClip } from "./selection";
import {
  clearTimelineRange,
  keepValidTimelineRangeOrClear,
  markTimelineRangeEnd,
  markTimelineRangeStart,
  setTimelineRange,
  timelineRangeContains,
  timelineRangeIsValid,
  timelineRangeNormalized,
  validSelectedTimelineRange,
} from "./timelineRange";
import { Fixtures, makeEditor, selectGap } from "./testFixtures";

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe("EditorViewModel - track selection", () => {
  it("selectsEveryClipOnTargetTrackOnly", () => {
    const editor = makeEditor([
      Fixtures.videoTrack({
        id: "target",
        clips: [
          Fixtures.clip({ id: "video", mediaType: "video", start: 0, duration: 30 }),
          Fixtures.clip({ id: "title", mediaType: "text", start: 30, duration: 30 }),
        ],
      }),
      Fixtures.audioTrack({ id: "other", clips: [Fixtures.clip({ id: "audio", mediaType: "audio", start: 0, duration: 60 })] }),
    ]);
    editor.ui.selectedClipIds = new Set(["audio"]);
    editor.ui.selectedTimelineMarkerIds = new Set(["marker"]);
    selectGap(editor, 1, 60, 90);
    expect(selectAllClips(editor, "target")).toBe(true);
    expect(sorted(editor.ui.selectedClipIds)).toEqual(["title", "video"]);
    expect(editor.ui.selectedGap).toBeNull();
    expect(editor.ui.selectedTimelineMarkerIds.size).toBe(0);
  });

  it("unavailableTrackPreservesSelection", () => {
    const editor = makeEditor([Fixtures.videoTrack({ id: "empty" })]);
    editor.ui.selectedClipIds = new Set(["existing"]);
    selectGap(editor, 0, 0, 30);
    expect(selectAllClips(editor, "empty")).toBe(false);
    expect(selectAllClips(editor, "missing")).toBe(false);
    expect(sorted(editor.ui.selectedClipIds)).toEqual(["existing"]);
    expect(editor.ui.selectedGap).not.toBeNull();
  });
});

describe("Timeline range selection", () => {
  it("normalizesReversedRanges", () => {
    const range = timelineRangeNormalized({ startFrame: 90, endFrame: 30 });
    expect(range.startFrame).toBe(30);
    expect(range.endFrame).toBe(90);
    expect(timelineRangeIsValid(range)).toBe(true);
  });

  it("containsUsesHalfOpenBounds", () => {
    const range = { startFrame: 30, endFrame: 90 };
    expect(timelineRangeContains(range, 30)).toBe(true);
    expect(timelineRangeContains(range, 89)).toBe(true);
    expect(timelineRangeContains(range, 90)).toBe(false);
  });
});

describe("EditorViewModel - timeline range", () => {
  it("markStartAndEndUsePlayhead", () => {
    const editor = makeEditor();
    editor.ui.currentFrame = 30;
    markTimelineRangeStart(editor);
    editor.ui.currentFrame = 90;
    markTimelineRangeEnd(editor);
    expect(editor.ui.selectedTimelineRange).toEqual({ startFrame: 30, endFrame: 90 });
  });

  it("invalidRangeClearsOnCommit", () => {
    const editor = makeEditor();
    setTimelineRange(editor, 30, 30);
    keepValidTimelineRangeOrClear(editor);
    expect(editor.ui.selectedTimelineRange).toBeNull();
  });

  it("validSelectedTimelineRangeNormalizesAndRejectsInvalidRanges", () => {
    const editor = makeEditor();
    setTimelineRange(editor, 90, 30);
    expect(validSelectedTimelineRange(editor)).toEqual({ startFrame: 30, endFrame: 90 });
    setTimelineRange(editor, 30, 30);
    expect(validSelectedTimelineRange(editor)).toBeNull();
    clearTimelineRange(editor);
    expect(editor.ui.selectedTimelineRange).toBeNull();
  });
});

describe("EditorViewModel - select forward", () => {
  it("selectForwardOnTrackIncludesAnchorAndLaterClipsOnlyOnAnchorTrack", () => {
    const e = makeEditor([
      Fixtures.videoTrack({
        clips: [
          Fixtures.clip({ id: "before", start: 0, duration: 20 }),
          Fixtures.clip({ id: "anchor", start: 30, duration: 20 }),
          Fixtures.clip({ id: "after", start: 70, duration: 20 }),
        ],
      }),
      Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "other", mediaType: "audio", start: 40, duration: 20 })] }),
    ]);
    selectForward(e, "anchor", "track");
    expect(sorted(e.ui.selectedClipIds)).toEqual(["after", "anchor"]);
  });

  it("selectForwardOnAllTracksUsesAnchorFrameAcrossTimeline", () => {
    const e = makeEditor([
      Fixtures.videoTrack({
        clips: [Fixtures.clip({ id: "before", start: 0, duration: 20 }), Fixtures.clip({ id: "anchor", start: 30, duration: 20 })],
      }),
      Fixtures.audioTrack({
        clips: [
          Fixtures.clip({ id: "sameFrame", mediaType: "audio", start: 30, duration: 20 }),
          Fixtures.clip({ id: "after", mediaType: "audio", start: 90, duration: 20 }),
        ],
      }),
    ]);
    selectForward(e, "anchor", "allTracks");
    expect(sorted(e.ui.selectedClipIds)).toEqual(["after", "anchor", "sameFrame"]);
  });

  it("selectForwardExpandsLinkedPartners", () => {
    const anchor = Fixtures.clip({ id: "anchor", start: 30, duration: 20 });
    anchor.linkGroupId = "g1";
    const linkedAudio = Fixtures.clip({ id: "linkedAudio", mediaType: "audio", start: 10, duration: 20 });
    linkedAudio.linkGroupId = "g1";
    const e = makeEditor([Fixtures.videoTrack({ clips: [anchor] }), Fixtures.audioTrack({ clips: [linkedAudio] })]);
    selectForward(e, "anchor", "track");
    expect(sorted(e.ui.selectedClipIds)).toEqual(["anchor", "linkedAudio"]);
  });

  it("currentSelectionUsesEarliestSelectedClipAsAnchor", () => {
    const e = makeEditor([
      Fixtures.videoTrack({
        clips: [
          Fixtures.clip({ id: "first", start: 20, duration: 20 }),
          Fixtures.clip({ id: "second", start: 60, duration: 20 }),
          Fixtures.clip({ id: "third", start: 100, duration: 20 }),
        ],
      }),
    ]);
    e.ui.selectedClipIds = new Set(["second", "third"]);
    selectForwardFromCurrentSelection(e, "track");
    expect(sorted(e.ui.selectedClipIds)).toEqual(["second", "third"]);
  });
});

describe("EditorViewModel - preview selection", () => {
  it("selectingClipClearsGapSelection", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "clip", start: 0, duration: 20 })] })]);
    selectGap(editor, 0, 50, 100);
    editor.ui.selectedTimelineMarkerIds = new Set(["marker"]);
    selectPreviewClip(editor, "clip");
    expect(sorted(editor.ui.selectedClipIds)).toEqual(["clip"]);
    expect(editor.ui.selectedGap).toBeNull();
    expect(editor.ui.selectedTimelineMarkerIds.size).toBe(0);
  });

  it("selectingSelectedClipPreservesMultiSelection", () => {
    const editor = makeEditor([
      Fixtures.videoTrack({
        clips: [Fixtures.clip({ id: "first", start: 0, duration: 20 }), Fixtures.clip({ id: "second", start: 100, duration: 20 })],
      }),
    ]);
    editor.ui.selectedClipIds = new Set(["first", "second"]);
    editor.ui.selectedTimelineMarkerIds = new Set(["marker"]);
    selectPreviewClip(editor, "first");
    expect(sorted(editor.ui.selectedClipIds)).toEqual(["first", "second"]);
    expect(editor.ui.selectedTimelineMarkerIds.size).toBe(0);
  });
});
