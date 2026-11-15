import { describe, expect, it } from "vitest";
import { makeMulticamMember, makeMulticamSource, makeTrack, makeTextStyle } from "../../model";
import { setMediaIo } from "../../media/io";
import { makeFakeIo } from "../../media/fakeIo";
import { captionPreparationIsCurrent, importCaptions, placeCaptionsFromSubtitleAssets } from "../../captions/captionGeneration";
import { fakeMeasure, testGroupId } from "../../captions/testSupport";
import {
  captionTargets, captionTargetsForTracks, captionUsesVideoAudioExtraction, makeTextClipSpec, placeCaptionTrack, placeTextClips,
  transcriptionTargets, type TextClipSpec,
} from "./captions";
import { Fixtures, makeAsset, makeEditor, setup } from "./testFixtures";

const textSpec = (start: number, duration: number, content: string): TextClipSpec =>
  makeTextClipSpec({ trackIndex: 0, startFrame: start, durationFrames: duration, content, style: makeTextStyle() });

describe("CaptionPlacementTests", () => {
  it("bulkNonOverwritingPlacementMutatesTimelineOnce", () => {
    const e = makeEditor([Fixtures.videoTrack()]);
    const specs = Array.from({ length: 1_000 }, (_, i) => textSpec(i * 30, 30, `caption ${i}`));
    const ids = e.perform("Place", () => placeTextClips(e, specs, { clearExistingRegions: false, measure: fakeMeasure }));
    expect(ids).toHaveLength(specs.length);
    expect(e.timeline.tracks[0].clips.map((c) => c.startFrame)).toEqual(specs.map((s) => s.startFrame));
    expect(e.undo()).toBe("Place");
    expect(e.timeline.tracks[0].clips).toHaveLength(0);
  });

  it("textClipsStayOnInsertedTrackWhenAClipIsOverwritten", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 300 })] })]);
    setup(e, () => e.timeline.tracks.unshift(makeTrack({ type: "video" })));
    // spec b (same start, longer) fully covers spec a -> a is removed mid-placement.
    const ids = e.perform("Place", () =>
      placeTextClips(e, [textSpec(0, 20, "a"), textSpec(0, 100, "b"), textSpec(120, 30, "c")], { measure: fakeMeasure }),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(e.timeline.tracks).toHaveLength(2);
    expect(e.timeline.tracks[0].clips.every((c) => c.mediaType === "text")).toBe(true);
    expect(e.timeline.tracks[0].clips.length).toBeGreaterThan(0);
    expect(e.timeline.tracks[1].clips).toHaveLength(1);
    expect(e.timeline.tracks[1].clips[0].mediaType).toBe("video");
  });

  it("textClipPlacementNeverPrunesOtherEmptyTracks", () => {
    const e = makeEditor([Fixtures.videoTrack(), Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 100 })] })]);
    e.perform("Place", () => placeTextClips(e, [textSpec(0, 50, "hi")], { measure: fakeMeasure }));
    expect(e.timeline.tracks).toHaveLength(2);
    expect(e.timeline.tracks[0].clips).toHaveLength(1);
  });

  it("placeCaptionTrackInsertsATopTrackAsOneUndoStep", () => {
    const e = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 100 })] })]);
    const ids = placeCaptionTrack(e, [textSpec(0, 10, "a"), textSpec(10, 10, "b")], "Generate Captions", { measure: fakeMeasure });
    expect(ids).toHaveLength(2);
    expect(e.timeline.tracks).toHaveLength(2);
    expect(e.timeline.tracks[0].clips.map((c) => c.textContent)).toEqual(["a", "b"]);
    expect(e.undo()).toBe("Generate Captions");
    expect(e.timeline.tracks).toHaveLength(1);
    expect(e.redo()).toBe("Generate Captions");
    expect(e.timeline.tracks).toHaveLength(2);
  });

  it("placeCaptionTrackWithNoSpecsRecordsNothing", () => {
    const e = makeEditor([Fixtures.videoTrack()]);
    expect(placeCaptionTrack(e, [], "Generate Captions", { measure: fakeMeasure })).toEqual([]);
    expect(e.undo()).toBeNull();
  });
});

describe("CaptionTargetTests", () => {
  it("preparationTracksTimelineValueInsteadOfIdentity", () => {
    const source = Fixtures.clip({ id: "source", mediaRef: "source-media", mediaType: "audio", start: 0, duration: 90 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [source] })]);
    const timelineId = e.doc.activeTimelineId;
    const snapshot = e.timeline;
    expect(captionPreparationIsCurrent(e, timelineId, snapshot)).toBe(true);
    e.perform("Nudge", () => {
      e.timeline.tracks[0].clips[0].startFrame += 1;
    });
    expect(captionPreparationIsCurrent(e, timelineId, snapshot)).toBe(false);
  });

  it("largeCaptionSelectionResolvesWithinInteractionBudget", () => {
    const captions = Array.from({ length: 10_000 }, (_, i) =>
      Fixtures.clip({ id: `caption-${i}`, mediaRef: `caption-media-${i}`, mediaType: "text", start: i * 30, duration: 30 }),
    );
    const e = makeEditor([Fixtures.videoTrack({ clips: captions })]);
    const started = performance.now();
    const targets = captionTargets(e, captions.map((c) => c.id));
    expect(targets).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("linkedAndTrackTargetsChooseAudioSide", () => {
    const groupId = "linked-1";
    const video = { ...Fixtures.clip({ id: "video", mediaRef: "media-1", mediaType: "video", start: 0, duration: 100 }), linkGroupId: groupId };
    const audio = { ...Fixtures.clip({ id: "audio", mediaRef: "media-1", mediaType: "audio", start: 0, duration: 100 }), linkGroupId: groupId };
    const voice = Fixtures.clip({ id: "voice", mediaRef: "voice-media", mediaType: "audio", start: 120, duration: 100 });
    const music = Fixtures.clip({ id: "music", mediaRef: "music-media", mediaType: "audio", start: 240, duration: 100 });
    const e = makeEditor([
      Fixtures.videoTrack({ id: "video-track", clips: [video] }),
      Fixtures.audioTrack({ id: "audio-track", clips: [audio] }),
      Fixtures.audioTrack({ id: "voice-track", clips: [voice] }),
      Fixtures.audioTrack({ id: "music-track", clips: [music] }),
    ]);
    const ids = (clips: { id: string }[]) => clips.map((c) => c.id);
    expect(ids(captionTargets(e, []))).toEqual(["audio", "voice", "music"]);
    expect(ids(captionTargets(e, ["video"]))).toEqual(["video"]);
    expect(ids(captionTargetsForTracks(e, new Set(["voice-track"])))).toEqual(["voice"]);
    expect(ids(captionTargetsForTracks(e, new Set(["video-track", "audio-track"])))).toEqual(["audio"]);
    expect(captionTargetsForTracks(e, new Set(["video-track"]))).toEqual([]);
    expect(ids(captionTargetsForTracks(e, new Set(["audio-track"])))).toEqual(["audio"]);
  });

  it("explicitSelectionsCanChooseNonMasterMulticamMic", () => {
    const masterClip = { ...Fixtures.clip({ id: "master", mediaRef: "lapel", mediaType: "audio", start: 0, duration: 100 }), multicamGroupId: "group" };
    const roomClip = { ...Fixtures.clip({ id: "room", mediaRef: "room", mediaType: "audio", start: 0, duration: 100 }), multicamGroupId: "group" };
    const master = makeMulticamMember({ id: "master-member", mediaRef: "lapel", kind: "mic", angleLabel: "lapel" });
    const room = makeMulticamMember({ mediaRef: "room", kind: "mic", angleLabel: "room" });
    const e = makeEditor([
      Fixtures.audioTrack({ id: "master-track", clips: [masterClip] }),
      Fixtures.audioTrack({ id: "room-track", clips: [roomClip] }),
    ]);
    setup(e, () => {
      e.doc.multicamGroups.push(makeMulticamSource({ id: "group", name: "Interview", members: [master, room], masterMemberId: master.id }));
    });
    const ids = (clips: { id: string }[]) => clips.map((c) => c.id);
    expect(ids(captionTargets(e, []))).toEqual(["master"]);
    expect(ids(captionTargets(e, ["room"]))).toEqual(["room"]);
    expect(ids(captionTargets(e, ["master", "room"]))).toEqual(["master", "room"]);
    expect(ids(transcriptionTargets(e, ["room"]))).toEqual(["room"]);
    expect(ids(captionTargetsForTracks(e, new Set(["room-track"])))).toEqual(["room"]);
  });

  it("mediaMetadataFiltersCaptionSources", () => {
    const silent = Fixtures.clip({ id: "silent", mediaRef: "silent-media", mediaType: "video", start: 0, duration: 100 });
    const linkedAudio = Fixtures.clip({ id: "audio", mediaRef: "video-media", mediaType: "audio", start: 120, duration: 100 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [silent] }), Fixtures.audioTrack({ clips: [linkedAudio] })]);
    setup(e, () => {
      e.doc.mediaAssets.push(
        makeAsset({ id: "silent-media", type: "video", duration: 3, hasAudio: false }),
        makeAsset({ id: "video-media", type: "video", duration: 3, hasAudio: true }),
      );
    });
    expect(captionTargets(e, []).map((c) => c.id)).toEqual(["audio"]);
    expect(captionUsesVideoAudioExtraction(e, linkedAudio)).toBe(true);
  });
});

describe("SubtitleImportTests", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld.\n";
  const deps = { measure: fakeMeasure, newGroupId: testGroupId };

  function editorWithFile(contents: string) {
    const io = makeFakeIo();
    io.addFile("/proj/captions.srt", contents);
    setMediaIo(io);
    return makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 300 })] })]);
  }

  it("importPlacesCaptionsSyncedToFileTimecodesAsOneUndoStep", async () => {
    const e = editorWithFile(srt);
    const ids = await importCaptions(e, "/proj/captions.srt", deps);
    expect(ids).toHaveLength(2);
    const captions = e.timeline.tracks[0].clips;
    expect(captions.map((c) => c.textContent)).toEqual(["Hello.", "World."]);
    expect(captions.map((c) => c.startFrame)).toEqual([30, 90]);
    expect(captions.every((c) => c.mediaType === "text" && c.captionGroupId !== undefined)).toBe(true);
    expect(e.undo()).toBe("Add Captions");
    expect(e.timeline.tracks.flatMap((t) => t.clips).every((c) => c.mediaType !== "text")).toBe(true);
    expect(e.undo()).toBeNull();
    setMediaIo(undefined);
  });

  it("malformedSubtitleFilePlacesNoCaptions", async () => {
    const e = editorWithFile("garbage --> nonsense\nBroken.\n");
    await expect(importCaptions(e, "/proj/captions.srt", deps)).rejects.toThrow("Malformed cue timing at line 1.");
    expect(e.timeline.tracks.flatMap((t) => t.clips).every((c) => c.mediaType !== "text")).toBe(true);
    setMediaIo(undefined);
  });

  it("placeCaptionsReportsOfflineAssetWithoutMutating", async () => {
    const e = editorWithFile(srt);
    const before = e.timeline;
    e.ui.offlineMediaRefs = new Set(["missing"]);
    await placeCaptionsFromSubtitleAssets(e, [{ id: "missing", name: "captions", type: "subtitle", url: "/nonexistent/captions.srt" }], deps);
    expect(e.ui.toast?.kind).toBe("error");
    expect(e.timeline).toBe(before);
    expect(e.undo()).toBeNull();
    setMediaIo(undefined);
  });
});
