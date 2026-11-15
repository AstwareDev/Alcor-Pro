import { describe, expect, it } from "vitest";
import {
  VolumeScale,
  clipCropAt,
  cropIsIdentity,
  makeCrop,
  makeRGBA,
  makeTextAnimation,
  makeTextStyle,
  rgbaFromHex,
  type Clip,
  type MediaAsset,
} from "../../model";
import { placeClip } from "../../editor/mutations/core";
import { insertTrack, timelineTrackDisplayLabel } from "../../editor/mutations/tracks";
import { Fixtures, setup } from "../../editor/mutations/testFixtures";
import { ToolHarness } from "./testHarness";
import { visibleClips } from "./timelineTools";

type Json = Record<string, unknown>;

const textOf = ToolHarness.textOf;

function parse(result: Parameters<typeof textOf>[0]): Json {
  return JSON.parse(textOf(result)) as Json;
}

function receipts(json: Json): Json[] {
  return (json.clips as Json[] | undefined) ?? [];
}

function sortedByStart(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

function setupWithVideoTrack(): { h: ToolHarness; asset: MediaAsset } {
  const h = new ToolHarness();
  insertTrack(h.editor, 0, "video");
  const asset = h.addAsset({ type: "video" });
  return { h, asset };
}

async function addedClip(h: ToolHarness, asset: MediaAsset, duration = 60): Promise<string> {
  await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: duration }] });
  return h.editor.timeline.tracks[0].clips[0].id;
}

function setupLinkedPair(): { h: ToolHarness; videoId: string; audioId: string } {
  const h = new ToolHarness();
  insertTrack(h.editor, 0, "video");
  const asset = h.addAsset({ type: "video", duration: 5, hasAudio: true });
  const ids = placeClip(h.editor, asset, 0, 0, 60);
  return { h, videoId: ids[0], audioId: ids[1] };
}

function setupClipForKeyframes(): { h: ToolHarness; clipId: string } {
  const h = new ToolHarness();
  insertTrack(h.editor, 0, "video");
  const asset = h.addAsset({ type: "video" });
  const ids = placeClip(h.editor, asset, 0, 0, 60);
  return { h, clipId: ids[0] };
}

function textClip(p: { id: string; start: number; duration: number }): Clip {
  return Fixtures.clip({ id: p.id, mediaRef: "text", mediaType: "text", start: p.start, duration: p.duration });
}

function clipOf(h: ToolHarness, id: string): Clip {
  const clip = h.editor.clipFor(id);
  if (!clip) throw new Error(`clip ${id} not found`);
  return clip;
}

function timelineClipById(json: Json, clipId: string): Json | undefined {
  return ((json.tracks as Json[] | undefined) ?? [])
    .flatMap((t) => (t.clips as Json[] | undefined) ?? [])
    .find((c) => typeof c.id === "string" && clipId.startsWith(c.id));
}

describe("ToolExecutor — clip handlers", () => {
  // MARK: - set_clip_properties speed

  it("setSpeedRescalesDurationToPreserveSource", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    const result = await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 2.0 });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(2.0);
    expect(clip.durationFrames).toBe(50);
  });

  it("setSpeedWithExplicitDurationKeepsThatDuration", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    const result = await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 2.0, durationFrames: 80 });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(2.0);
    expect(clip.durationFrames).toBe(80);
  });

  it("setHalfSpeedDoublesDuration", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    await h.runRaw("set_clip_properties", { clipIds: ["c1"], speed: 0.5 });
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(0.5);
    expect(clip.durationFrames).toBe(200);
  });

  it("setSpeedRescalesTextWordTimings", async () => {
    const clip = textClip({ id: "caption", start: 0, duration: 120 });
    clip.textContent = "one two";
    clip.wordTimings = [{ text: "one", startFrame: 0, endFrame: 60 }, { text: "two", startFrame: 60, endFrame: 120 }];
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("set_clip_properties", { clipIds: ["caption"], speed: 2.0 });

    expect(result.isError, textOf(result)).toBe(false);
    const updated = h.editor.timeline.tracks[0].clips[0];
    expect(updated.durationFrames).toBe(60);
    expect(updated.wordTimings).toEqual([
      { text: "one", startFrame: 0, endFrame: 30 },
      { text: "two", startFrame: 30, endFrame: 60 },
    ]);
  });

  // MARK: - add_clips

  it("addClipsPlacesClipOnTrack", async () => {
    const { h, asset } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 60 }] });
    expect(result.isError, textOf(result)).toBe(false);
    const clips = h.editor.timeline.tracks[0].clips;
    expect(clips.length).toBe(1);
    expect(clips[0].startFrame).toBe(0);
    expect(clips[0].durationFrames).toBe(60);
    expect(clips[0].mediaRef).toBe(asset.id);
  });

  it("addClipsRejectsOutOfRangeTrackIndex", async () => {
    const { h, asset } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 99, startFrame: 0, endFrame: 30 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("out of range");
  });

  it("addClipsRejectsMissingMediaRef", async () => {
    const { h } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: "no-such-asset", trackIndex: 0, startFrame: 0, endFrame: 30 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("not found");
  });

  it("addClipsRejectsIncompatibleAssetForTrack", async () => {
    const h = new ToolHarness();
    insertTrack(h.editor, 0, "video");
    const audio = h.addAsset({ type: "audio" });
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: audio.id, trackIndex: 0, startFrame: 0, endFrame: 30 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not compatible");
  });

  it("addClipsRejectsZeroDuration", async () => {
    const { h, asset } = setupWithVideoTrack();
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 0 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("endFrame");
  });

  it("addClipsRejectsEmptyEntries", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("add_clips", { entries: [] });
    expect(result.isError).toBe(true);
  });

  it("addClipsAutoCreatesTrackWhenIndexOmitted", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video" });
    const initialCount = h.editor.timeline.tracks.length;
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, endFrame: 30 }] });
    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(initialCount + 1);
    const createdTrack = h.editor.timeline.tracks.find((t) => t.type === "video");
    expect(createdTrack?.clips[0]?.mediaRef).toBe(asset.id);
  });

  it("addClipsSharesOneTrackForMultipleVisualEntriesWhenOmitted", async () => {
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video" });
    const b = h.addAsset({ type: "image" });
    const initialCount = h.editor.timeline.tracks.length;
    const result = await h.runRaw("add_clips", {
      entries: [
        { mediaRef: a.id, startFrame: 0, endFrame: 30 },
        { mediaRef: b.id, startFrame: 60, endFrame: 90 },
      ],
    });
    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(initialCount + 1);
    const videoTracks = h.editor.timeline.tracks.filter((t) => t.type === "video");
    expect(videoTracks.length).toBe(1);
    expect(videoTracks[0]?.clips.length).toBe(2);
  });

  it("addClipsCreatesSeparateTracksForVideoAndAudioWhenOmitted", async () => {
    const h = new ToolHarness();
    const video = h.addAsset({ type: "video" });
    const audio = h.addAsset({ type: "audio" });
    const initial = h.editor.timeline.tracks.length;
    const result = await h.runRaw("add_clips", {
      entries: [
        { mediaRef: video.id, startFrame: 0, endFrame: 30 },
        { mediaRef: audio.id, startFrame: 0, endFrame: 30 },
      ],
    });
    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(initial + 2);
    const videoTracks = h.editor.timeline.tracks.filter((t) => t.type === "video");
    const audioTracks = h.editor.timeline.tracks.filter((t) => t.type === "audio");
    expect(videoTracks.length).toBe(1);
    expect(audioTracks.length).toBe(1);
    expect(videoTracks[0]?.clips[0]?.mediaRef).toBe(video.id);
    expect(audioTracks[0]?.clips[0]?.mediaRef).toBe(audio.id);
  });

  it("addClipsAudioBeforeVideoAllOmittedRoutesByType", async () => {
    const h = new ToolHarness();
    const audio1 = h.addAsset({ type: "audio" });
    const video = h.addAsset({ type: "video" });
    const audio2 = h.addAsset({ type: "audio" });
    const result = await h.runRaw("add_clips", {
      entries: [
        { mediaRef: audio1.id, startFrame: 0, endFrame: 30 },
        { mediaRef: video.id, startFrame: 0, endFrame: 30 },
        { mediaRef: audio2.id, startFrame: 60, endFrame: 90 },
      ],
    });
    expect(result.isError, textOf(result)).toBe(false);
    const videoTracks = h.editor.timeline.tracks.filter((t) => t.type === "video");
    const audioTracks = h.editor.timeline.tracks.filter((t) => t.type === "audio");
    expect(videoTracks.length).toBe(1);
    expect(audioTracks.length).toBe(1);
    expect(videoTracks[0]?.clips.length).toBe(1);
    expect(audioTracks[0]?.clips.length).toBe(2);
    const audioRefs = (audioTracks[0]?.clips ?? []).map((c) => c.mediaRef).sort();
    expect(audioRefs).toEqual([audio1.id, audio2.id].sort());
    expect(videoTracks[0]?.clips[0]?.mediaRef).toBe(video.id);
  });

  it("addClipsRejectsMixedTrackIndexUsage", async () => {
    const h = new ToolHarness();
    insertTrack(h.editor, 0, "video");
    const a = h.addAsset({ type: "video" });
    const b = h.addAsset({ type: "video" });
    const result = await h.runRaw("add_clips", {
      entries: [
        { mediaRef: a.id, trackIndex: 0, startFrame: 0, endFrame: 30 },
        { mediaRef: b.id, startFrame: 60, endFrame: 90 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Mixed trackIndex");
  });

  it("addClipsOmittingAudioTrackIndexAppendsBelowLinkedAudio", async () => {
    const h = new ToolHarness();
    const video = h.addAsset({ type: "video", hasAudio: true });
    const music = h.addAsset({ type: "audio" });

    const videoResult = await h.runRaw("add_clips", { entries: [{ mediaRef: video.id, startFrame: 0, endFrame: 30 }] });
    expect(videoResult.isError, textOf(videoResult)).toBe(false);

    const musicResult = await h.runRaw("add_clips", { entries: [{ mediaRef: music.id, startFrame: 0, endFrame: 30 }] });
    expect(musicResult.isError, textOf(musicResult)).toBe(false);

    const audioTracks = h.editor.timeline.tracks.map((element, offset) => ({ element, offset })).filter((t) => t.element.type === "audio");
    expect(audioTracks.length).toBe(2);

    const linkedTrack = audioTracks[0];
    const musicTrack = audioTracks[1];
    expect(timelineTrackDisplayLabel(h.editor, linkedTrack.offset)).toBe("A1");
    expect(timelineTrackDisplayLabel(h.editor, musicTrack.offset)).toBe("A2");
    expect(linkedTrack.element.clips.some((c) => c.linkGroupId !== undefined)).toBe(true);
    expect(musicTrack.element.clips.some((c) => c.mediaRef === music.id && c.linkGroupId === undefined)).toBe(true);
  });

  // MARK: - remove_clips

  it("removeClipsDropsClipsByIds", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", {
      entries: [
        { mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 30 },
        { mediaRef: asset.id, trackIndex: 0, startFrame: 60, endFrame: 90 },
      ],
    });
    const clipId = sortedByStart(h.editor.timeline.tracks[0].clips)[0].id;

    const result = await h.runRaw("remove_clips", { clipIds: [clipId] });
    expect(result.isError).toBe(false);
    expect(h.editor.timeline.tracks[0].clips.length).toBe(1);
    expect(h.editor.timeline.tracks[0].clips[0].startFrame).toBe(60);
  });

  it("removeClipsPrunesTrackWhenLastClipGoes", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 30 }] });
    const clipId = h.editor.timeline.tracks[0].clips[0].id;

    const result = await h.runRaw("remove_clips", { clipIds: [clipId] });
    expect(result.isError).toBe(false);
    expect(h.editor.timeline.tracks.length, "empty track should be pruned after last clip removed").toBe(0);
  });

  it("removeClipsMessageMentionsPrunedTracks", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 30 }] });
    const clipId = h.editor.timeline.tracks[0].clips[0].id;

    const json = await h.runOK("remove_clips", { clipIds: [clipId] });
    const removed = json.removedClipIds as string[] | undefined;
    expect(removed?.length).toBe(1);
    expect(removed?.[0]?.length ?? 99).toBeLessThan(36);
    const notes = ((json.notes as string[] | undefined) ?? []).join(" ");
    expect(notes, `expected track-shift note, got: ${notes}`).toContain("Track indices shifted");
  });

  it("removeClipsOmitsTrackShiftNoteWhenNoTrackPruned", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", {
      entries: [
        { mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 30 },
        { mediaRef: asset.id, trackIndex: 0, startFrame: 60, endFrame: 90 },
      ],
    });
    const clipId = sortedByStart(h.editor.timeline.tracks[0].clips)[0].id;

    const json = await h.runOK("remove_clips", { clipIds: [clipId] });
    const notes = ((json.notes as string[] | undefined) ?? []).join(" ");
    expect(notes, `no track was pruned but the shift note appeared: ${notes}`).not.toContain("Track indices shifted");
  });

  it("removeClipsRejectsMissingIds", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("remove_clips", { clipIds: ["does-not-exist"] });
    expect(result.isError).toBe(true);
  });

  // MARK: - split_clips

  it("splitClipRejectsFrameOutsideClipRange", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 60 }] });
    const clipId = h.editor.timeline.tracks[0].clips[0].id;

    const result = await h.runRaw("split_clips", { splits: [{ clipId, atFrame: 60 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("outside");
  });

  it("splitClipsMultipleFramesOnSameClip", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 90 }] });

    const result = await h.runRaw("split_clips", { trackIndex: 0, frames: [30, 60] });
    expect(result.isError, textOf(result)).toBe(false);
    const clips = sortedByStart(h.editor.timeline.tracks[0].clips);
    expect(clips.length).toBe(3);
    expect(clips[0].startFrame === 0 && clips[0].durationFrames === 30).toBe(true);
    expect(clips[1].startFrame === 30 && clips[1].durationFrames === 30).toBe(true);
    expect(clips[2].startFrame === 60 && clips[2].durationFrames === 30).toBe(true);
  });

  it("splitClipsDedupsDuplicateFrames", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 90 }] });
    const json = await h.runOK("split_clips", { trackIndex: 0, frames: [30, 30] });
    expect(h.editor.timeline.tracks[0].clips.length).toBe(2);
    const frames = receipts(json).map((c) => c.frames);
    expect(frames).toEqual([[0, 30], [30, 90]]);
  });

  it("splitClipsRejectsSeamFrame", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 90 }] });
    await h.runRaw("split_clips", { trackIndex: 0, frames: [30] });
    const result = await h.runRaw("split_clips", { trackIndex: 0, frames: [30] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not strictly inside");
  });

  it("splitClipsRejectsBothAndNeitherMode", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 90 }] });
    const clipId = h.editor.timeline.tracks[0].clips[0].id;

    const both = await h.runRaw("split_clips", { splits: [{ clipId, atFrame: 30 }], trackIndex: 0, frames: [60] });
    expect(both.isError).toBe(true);

    const neither = await h.runRaw("split_clips", {});
    expect(neither.isError).toBe(true);
  });

  it("splitClipsEmptySplitsFallsThroughToTrackMode", async () => {
    const { h, asset } = setupWithVideoTrack();
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 0, endFrame: 90 }] });
    const result = await h.runRaw("split_clips", { splits: [], trackIndex: 0, frames: [30] });
    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks[0].clips.length).toBe(2);
  });

  // MARK: - move_clips

  it("moveClipsChangesTrackAndFrame", async () => {
    const { h, asset } = setupWithVideoTrack();
    insertTrack(h.editor, 0, "video");
    const destTrackId = h.editor.timeline.tracks[1].id;
    const clipId = await addedClip(h, asset);

    const result = await h.runRaw("move_clips", { moves: [{ clipId, toTrack: 1, toFrame: 100 }] });
    expect(result.isError, textOf(result)).toBe(false);
    const loc = h.editor.findClip(clipId);
    expect(loc, "clip disappeared after move").not.toBeNull();
    if (loc) {
      const destTrack = h.editor.timeline.tracks[loc.trackIndex];
      expect(destTrack.id).toBe(destTrackId);
      expect(destTrack.clips[loc.clipIndex].startFrame).toBe(100);
    }
  });

  it("moveClipsRequiresAtLeastOneOfTrackOrFrame", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("move_clips", { moves: [{ clipId }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("toTrack");
  });

  it("moveClipsRejectsIncompatibleTrack", async () => {
    const { h, asset } = setupWithVideoTrack();
    insertTrack(h.editor, 0, "audio");
    const clipId = await addedClip(h, asset);
    const audioIdx = h.editor.timeline.tracks.findIndex((t) => t.type === "audio");
    const result = await h.runRaw("move_clips", { moves: [{ clipId, toTrack: audioIdx }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("incompatible");
  });

  it("moveClipsRejectsMissingClipId", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("move_clips", { moves: [{ clipId: "ghost", toFrame: 30 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("not found");
  });

  it("moveClipsRejectsEmptyMovesArray", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("move_clips", { moves: [] });
    expect(result.isError).toBe(true);
  });

  // MARK: - move_clips: linked-partner propagation

  it("moveClipsFrameDeltaPropagatesToLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();
    const result = await h.runRaw("move_clips", { moves: [{ clipId: videoId, toFrame: 60 }] });
    expect(result.isError, textOf(result)).toBe(false);
    const videoClip = clipOf(h, videoId);
    const audioClip = clipOf(h, audioId);
    expect(videoClip.startFrame).toBe(60);
    expect(audioClip.startFrame, "linked audio should track the video's frame delta").toBe(60);
    const clip = receipts(parse(result))[0];
    expect(clip?.frames).toEqual([60, 120]);
    expect((clip?.audio as Json | undefined)?.id).toBeDefined();
  });

  it("moveClipsTrackChangeDoesNotMoveLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();
    insertTrack(h.editor, 0, "video");
    const audioLoc = h.editor.findClip(audioId);
    expect(audioLoc, "setup failed").not.toBeNull();
    if (!audioLoc) return;
    const audioTrackId = h.editor.timeline.tracks[audioLoc.trackIndex].id;

    const result = await h.runRaw("move_clips", { moves: [{ clipId: videoId, toTrack: 0, toFrame: 120 }] });
    expect(result.isError, textOf(result)).toBe(false);
    const newAudioLoc = h.editor.findClip(audioId);
    expect(newAudioLoc, "audio partner disappeared").not.toBeNull();
    if (!newAudioLoc) return;
    const audioClip = h.editor.timeline.tracks[newAudioLoc.trackIndex].clips[newAudioLoc.clipIndex];
    expect(h.editor.timeline.tracks[newAudioLoc.trackIndex].id, "linked audio should stay on its own track when video moves track").toBe(audioTrackId);
    expect(audioClip.startFrame, "linked audio should move by the same frame delta").toBe(120);
  });

  // MARK: - set_clip_properties

  it("setClipPropertiesChangesSpeedAndVolumeDb", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], speed: 2.0, volumeDb: -6.0 });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.speed).toBe(2.0);
    expect(Math.abs(clip.volume - VolumeScale.linearFromDb(-6))).toBeLessThan(0.0001);
  });

  it("setClipPropertiesAppliesUniformlyToMultipleClips", async () => {
    const { h, asset } = setupWithVideoTrack();
    const id1 = await addedClip(h, asset, 30);
    await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 60, endFrame: 90 }] });
    const second = h.editor.timeline.tracks[0].clips.find((c) => c.id !== id1);
    expect(second).toBeDefined();
    const id2 = second?.id ?? "";
    await h.runRaw("set_clip_properties", { clipIds: [id1, id2], volumeDb: -12.0 });
    for (const clip of h.editor.timeline.tracks[0].clips) {
      expect(Math.abs(clip.volume - VolumeScale.linearFromDb(-12)), "all listed clips share the property value").toBeLessThan(0.0001);
    }
  });

  it("setClipPropertiesSetsEdgeAdjustmentsOnVisualClips", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);

    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], edgeRounding: 0.4, edgeSoftness: 0.25 });

    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.clipFor(clipId)?.edgeRounding).toBe(0.4);
    expect(h.editor.clipFor(clipId)?.edgeSoftness).toBe(0.25);
  });

  it("setClipPropertiesSetsStaticCropAndClearsCropTrack", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "crop", keyframes: [[0, 0.1, 0.1, 0.1, 0.1]] });
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { left: 0.2, top: 0.1, right: 0.15, bottom: 0.05 } });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = clipOf(h, clipId);
    expect(clip.crop).toEqual(makeCrop({ left: 0.2, top: 0.1, right: 0.15, bottom: 0.05 }));
    expect(clip.cropTrack).toBeUndefined();
    expect(clipCropAt(clip, clip.startFrame)).toEqual(clip.crop);
  });

  it("setClipPropertiesCropMergesOmittedEdges", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    setup(h.editor, (e) => {
      e.timeline.tracks[0].clips[0].crop = makeCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 });
    });
    await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { left: 0.25 } });
    const clip = clipOf(h, clipId);
    expect(clip.crop).toEqual(makeCrop({ left: 0.25, top: 0.2, right: 0.3, bottom: 0.4 }));
  });

  it("setClipPropertiesCropMergesOmittedEdgesFromKeyedCrop", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "crop", keyframes: [[0, 0.1, 0.2, 0.3, 0.15]] });
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { left: 0.25 } });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = clipOf(h, clipId);
    expect(clip.crop).toEqual(makeCrop({ left: 0.25, top: 0.1, right: 0.2, bottom: 0.3 }));
    expect(clip.cropTrack).toBeUndefined();
  });

  it("setClipPropertiesCropKeepsPlayheadMergeWhenTimingClampsCropTrack", async () => {
    const { h, clipId } = setupClipForKeyframes();
    h.editor.ui.currentFrame = 20;
    await h.runRaw("set_keyframes", {
      clipId,
      property: "crop",
      keyframes: [
        [0, 0, 0, 0, 0, "linear"],
        [40, 0.5, 0.5, 0.5, 0.5, "linear"],
      ],
    });
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], durationFrames: 30, crop: { left: 0.2 } });
    expect(result.isError, textOf(result)).toBe(false);
    const clip = clipOf(h, clipId);
    expect(clip.crop).toEqual(makeCrop({ left: 0.2, top: 0.25, right: 0.25, bottom: 0.25 }));
    expect(clip.cropTrack).toBeUndefined();
    expect(clip.durationFrames).toBe(30);
  });

  it("setClipPropertiesCropAllZerosRestoresFullSource", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    setup(h.editor, (e) => {
      e.timeline.tracks[0].clips[0].crop = makeCrop({ left: 0.2, top: 0.1, right: 0.2, bottom: 0.1 });
    });
    await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { left: 0, top: 0, right: 0, bottom: 0 } });
    expect(cropIsIdentity(clipOf(h, clipId).crop)).toBe(true);
  });

  it("setClipPropertiesRejectsCropOnNonVisualClips", async () => {
    const clip = Fixtures.clip({ id: "audio", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    const result = await h.runRaw("set_clip_properties", { clipIds: [clip.id], crop: { left: 0.2 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("visual clips");
    expect(cropIsIdentity(clipOf(h, clip.id).crop)).toBe(true);
  });

  it("setClipPropertiesRejectsCropThatHidesTheSource", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { left: 0.5, right: 0.5 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("visible");
    expect(cropIsIdentity(clipOf(h, clipId).crop)).toBe(true);
  });

  it("setClipPropertiesRejectsNegativeCropInset", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { top: -0.1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("top");
  });

  it("setClipPropertiesRejectsUnknownCropKey", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], crop: { anchorX: 0.5 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("anchorX");
  });

  it("setClipPropertiesCropDoesNotPropagateToLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();
    await h.runRaw("set_clip_properties", { clipIds: [videoId], crop: { left: 0.2 } });
    expect(h.editor.clipFor(videoId)?.crop.left).toBe(0.2);
    expect(cropIsIdentity(clipOf(h, audioId).crop)).toBe(true);
  });

  it("setClipPropertiesSetsFadesWithoutClearingKeyframes", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 0.25], [30, 1.0]] });

    const json = await h.runOK("set_clip_properties", {
      clipIds: [clipId],
      fadeInFrames: 12,
      fadeOutFrames: 18,
      fadeInInterpolation: "smooth",
      fadeOutInterpolation: "linear",
    });

    const clip = clipOf(h, clipId);
    expect(clip.fadeInFrames).toBe(12);
    expect(clip.fadeOutFrames).toBe(18);
    expect(clip.fadeInInterpolation).toBe("smooth");
    expect(clip.fadeOutInterpolation).toBe("linear");
    expect(clip.opacityTrack?.keyframes.length).toBe(2);
    const receipt = receipts(json)[0];
    expect(receipt?.fadeInFrames).toBe(12);
    expect(receipt?.fadeOutFrames).toBe(18);
    expect((receipt?.keyframes as Json | undefined)?.opacity).toBeDefined();
  });

  it("setClipPropertiesRejectsOversizedFadesAtomically", async () => {
    const first = Fixtures.clip({ id: "first", start: 0, duration: 60 });
    const second = Fixtures.clip({ id: "second", start: 60, duration: 20 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [first, second] })] }));

    const result = await h.runRaw("set_clip_properties", { clipIds: [first.id, second.id], fadeInFrames: 15, fadeOutFrames: 10 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("second");
    expect(h.editor.clipFor(first.id)?.fadeInFrames).toBe(0);
    expect(h.editor.clipFor(second.id)?.fadeInFrames).toBe(0);
  });

  it("setClipPropertiesFadesDoNotPropagateToLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();

    const result = await h.runRaw("set_clip_properties", { clipIds: [videoId], fadeInFrames: 10, fadeOutFrames: 20 });

    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.clipFor(videoId)?.fadeInFrames).toBe(10);
    expect(h.editor.clipFor(videoId)?.fadeOutFrames).toBe(20);
    expect(h.editor.clipFor(audioId)?.fadeInFrames).toBe(0);
    expect(h.editor.clipFor(audioId)?.fadeOutFrames).toBe(0);
  });

  it("setClipPropertiesRejectsEdgeAdjustmentsOnNonVisualClips", async () => {
    const clip = Fixtures.clip({ id: "audio", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));

    const result = await h.runRaw("set_clip_properties", { clipIds: [clip.id], edgeRounding: 0.4, edgeSoftness: 0.25 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("visual clips");
  });

  it("setClipPropertiesRejectsUnknownKey", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], unknownField: 99 });
    expect(result.isError).toBe(true);
  });

  it("setClipPropertiesRejectsRemovedNormalizedVolume", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], volume: 0.5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown field(s) 'volume'");
  });

  it("setClipPropertiesRejectsMissingClipId", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("set_clip_properties", { clipIds: ["ghost"], speed: 2.0 });
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("not found");
  });

  it("setClipPropertiesRejectsTextFieldsAsUnknown", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], fontSize: 48 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown field");
  });

  it("updateTextRejectsNonTextClip", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("update_text", { clipIds: [clipId], style: { fontSize: 48 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("only applies to text");
  });

  it("updateTextRejectsRemovedTextStyleFields", async () => {
    const clip = textClip({ id: "title", start: 0, duration: 30 });
    clip.textStyle = makeTextStyle();
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], borderEnabled: false, shadowColor: "#000000" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown field");
  });

  it("setClipPropertiesRejectsEmptyClipIds", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("set_clip_properties", { clipIds: [], speed: 2.0 });
    expect(result.isError).toBe(true);
  });

  it("setClipPropertiesRejectsNoProperties", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId] });
    expect(result.isError).toBe(true);
  });

  it("setClipPropertiesRejectsOutOfRangeValues", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);
    const cases: [string, number][] = [
      ["speed", 0.0], ["speed", -2.0],
      ["volumeDb", 15.1], ["volumeDb", -60.1],
      ["opacity", -1.0],
      ["fadeInFrames", -1], ["fadeOutFrames", -1],
      ["edgeRounding", -0.1], ["edgeRounding", 1.1],
      ["edgeSoftness", -0.1], ["edgeSoftness", 1.1],
      ["trimStartFrame", -100],
    ];
    for (const [field, value] of cases) {
      const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], [field]: value });
      expect(result.isError, `${field}=${value} should be rejected`).toBe(true);
      expect(textOf(result), `error should name ${field}`).toContain(field);
    }
  });

  it("setClipPropertiesRejectsUnsupportedFadeInterpolation", async () => {
    const { h, asset } = setupWithVideoTrack();
    const clipId = await addedClip(h, asset);

    const result = await h.runRaw("set_clip_properties", { clipIds: [clipId], fadeInInterpolation: "hold" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("fadeInInterpolation");
  });

  it("setClipPropertiesDurationAndSpeedPropagateToLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();
    await h.runRaw("set_clip_properties", { clipIds: [videoId], durationFrames: 30, speed: 2.0 });
    const videoClip = clipOf(h, videoId);
    const audioClip = clipOf(h, audioId);
    expect(videoClip.durationFrames === 30 && audioClip.durationFrames === 30).toBe(true);
    expect(videoClip.speed === 2.0 && audioClip.speed === 2.0).toBe(true);
  });

  it("setClipPropertiesOpacityDoesNotPropagateToLinkedPartner", async () => {
    const { h, videoId, audioId } = setupLinkedPair();
    await h.runRaw("set_clip_properties", { clipIds: [videoId], opacity: 0.5 });
    expect(clipOf(h, videoId).opacity).toBe(0.5);
    expect(clipOf(h, audioId).opacity, "opacity is per-clip and must not propagate").toBe(1.0);
  });

  it("setClipPropertiesScalarClearsExistingKeyframeTrack", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, 0.0], [30, -60.0]] });
    await h.runRaw("set_clip_properties", { clipIds: [clipId], volumeDb: -6.0 });
    const clip = clipOf(h, clipId);
    expect(Math.abs(clip.volume - VolumeScale.linearFromDb(-6))).toBeLessThan(0.0001);
    expect(clip.volumeTrack).toBeUndefined();
  });

  // MARK: - set_keyframes

  it("setKeyframesSetsVolumeDb", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", {
      clipId,
      property: "volumeDb",
      keyframes: [[0, 0.0], [30, -6.0, "linear"], [60, -60.0]],
    });
    expect(result.isError, textOf(result)).toBe(false);
    const kfs = clipOf(h, clipId).volumeTrack?.keyframes ?? [];
    expect(kfs.length).toBe(3);
    expect(kfs[0].frame === 0 && kfs[0].value === 0 && kfs[0].interpolationOut === "smooth").toBe(true);
    expect(kfs[1].value).toBe(-6);
    expect(kfs[1].frame === 30 && kfs[1].interpolationOut === "linear").toBe(true);
    expect(kfs[2].frame === 60 && kfs[2].value === VolumeScale.floorDb).toBe(true);
  });

  it("setKeyframesClearsWhenEmpty", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 1.0], [30, 0.0]] });
    await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [] });
    expect(clipOf(h, clipId).opacityTrack).toBeUndefined();
  });

  it("setKeyframesSortsAndDedupes", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", {
      clipId,
      property: "volumeDb",
      keyframes: [[60, -12.0], [0, 0.0], [30, -6.0], [30, -3.0]],
    });
    expect(result.isError, textOf(result)).toBe(false);
    const kfs = clipOf(h, clipId).volumeTrack?.keyframes ?? [];
    expect(kfs.map((k) => k.frame)).toEqual([0, 30, 60]);
    expect(kfs[0].value).toBe(0);
    expect(kfs[1].value, "duplicate frame 30 keeps the last value (last-write-wins)").toBe(-3);
    expect(kfs[2].value).toBe(-12);
  });

  it("setKeyframesRejectsVolumeDbOutsideSupportedRange", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, 15.01]] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("between -60.0 and 15.0");
  });

  it("setKeyframesRejectsOpacityOutsideNormalizedRange", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", { clipId, property: "opacity", keyframes: [[0, 1.01]] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("between 0.0 and 1.0");
  });

  it("setKeyframesRejectsNonFiniteValues", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, Infinity]] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("finite");
  });

  it("setKeyframesAcceptsPositionAndCrop", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const posResult = await h.runRaw("set_keyframes", { clipId, property: "position", keyframes: [[0, 0.5, 0.5], [30, 0.7, 0.3, "linear"]] });
    expect(posResult.isError, textOf(posResult)).toBe(false);
    const cropResult = await h.runRaw("set_keyframes", { clipId, property: "crop", keyframes: [[0, 0, 0, 0, 0], [60, 0.1, 0.1, 0.1, 0.1]] });
    expect(cropResult.isError, textOf(cropResult)).toBe(false);
    const clip = clipOf(h, clipId);
    const pos = clip.positionTrack?.keyframes ?? [];
    expect(pos.length).toBe(2);
    expect(pos[0].value.a === 0.5 && pos[0].value.b === 0.5).toBe(true);
    expect(pos[1].value.a === 0.7 && pos[1].value.b === 0.3 && pos[1].interpolationOut === "linear").toBe(true);
    const crop = clip.cropTrack?.keyframes ?? [];
    expect(crop.length).toBe(2);
    const last = crop[1].value;
    expect(last.top === 0.1 && last.right === 0.1 && last.bottom === 0.1 && last.left === 0.1).toBe(true);
  });

  it("setKeyframesRejectsUnknownProperty", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", { clipId, property: "loudness", keyframes: [[0, 1.0]] });
    expect(result.isError).toBe(true);
  });

  it("setKeyframesRejectsRemovedNormalizedVolumeProperty", async () => {
    const { h, clipId } = setupClipForKeyframes();
    const result = await h.runRaw("set_keyframes", { clipId, property: "volume", keyframes: [[0, 1.0]] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown property 'volume'");
  });

  it("setKeyframesRejectsMissingClipId", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("set_keyframes", { clipId: "ghost", property: "volumeDb", keyframes: [[0, 0.0]] });
    expect(result.isError).toBe(true);
  });

  it("getTimelineEmitsTupleKeyframes", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, 0.0], [30, -60.0, "linear"]] });
    await h.runRaw("set_keyframes", { clipId, property: "position", keyframes: [[0, 0.5, 0.5], [60, 0.2, 0.8]] });
    const json = await h.runOK("get_timeline");
    const clip = timelineClipById(json, clipId);
    const kfs = clip?.keyframes as Json | undefined;
    expect(kfs, "keyframes should be present on the clip in get_timeline output").toBeDefined();
    const volRows = kfs?.volumeDb as unknown[][] | undefined;
    expect(volRows?.length).toBe(2);
    expect(Math.abs(((volRows?.[0][1] as number | undefined) ?? -1) - 0)).toBeLessThan(0.0001);
    expect(Math.abs(((volRows?.[1][1] as number | undefined) ?? -1) - -60)).toBeLessThan(0.0001);
    expect(volRows?.[0].length).toBe(2);
    expect(volRows?.[1].length).toBe(3);
    expect(volRows?.[1][2]).toBe("linear");
    const posRows = kfs?.position as unknown[][] | undefined;
    expect(posRows?.length).toBe(2);
    expect(posRows?.[0].length).toBe(3);
    expect(clip?.volumeTrack).toBeUndefined();
    expect(clip?.positionTrack).toBeUndefined();
  });

  it("getTimelineCollapsesConstantVolumeUsingDecibels", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, -60.0], [60, -60.0]] });
    const json = await h.runOK("get_timeline");
    const clip = timelineClipById(json, clipId);
    expect(clip?.volumeDb).toBe(-60);
    expect(clip?.keyframes).toBeUndefined();
  });

  it("getTimelineCollapsesConstantAndIdentityKeyframes", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "crop", keyframes: [[0, 0, 0, 0, 0.313], [36, 0, 0, 0, 0.313]] });
    await h.runRaw("set_keyframes", { clipId, property: "position", keyframes: [[0, 0, 0]] });
    const json = await h.runOK("get_timeline");
    const clip = timelineClipById(json, clipId);
    expect(clip?.keyframes).toBeUndefined();
    expect((clip?.crop as Json | undefined)?.left).toBe(0.313);
  });

  it("addClipsReportsOverwrittenAndTrimmedNeighbors", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video", duration: 10 });
    await h.runRaw("add_clips", {
      entries: [
        { mediaRef: asset.id, startFrame: 0, endFrame: 60 },
        { mediaRef: asset.id, startFrame: 90, endFrame: 120 },
      ],
    });
    const victim = h.editor.timeline.tracks[0].clips[1].id;

    const json = await h.runOK("add_clips", { entries: [{ mediaRef: asset.id, trackIndex: 0, startFrame: 40, endFrame: 120 }] });
    expect(receipts(json).map((c) => c.frames)).toEqual([[0, 40], [40, 120]]);
    const removed = json.removedClipIds as string[] | undefined;
    expect(removed?.length).toBe(1);
    expect(removed?.[0] !== undefined && victim.startsWith(removed[0])).toBe(true);
  });

  it("insertClipsCompressesDownstreamShiftIntoRule", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video", duration: 10 });
    const entries: Json[] = [];
    for (let i = 0; i < 4; i++) entries.push({ mediaRef: asset.id, startFrame: i * 30, endFrame: i * 30 + 30 });
    await h.runRaw("add_clips", { entries });

    const json = await h.runOK("insert_clips", {
      trackIndex: 0,
      atFrame: 30,
      entries: [{ mediaRef: asset.id, durationFrames: 60 }],
    });
    expect(receipts(json)[0]?.frames).toEqual([30, 90]);
    const shift = (json.shifted as Json[] | undefined)?.[0];
    expect(shift?.by).toBe(60);
    expect(shift?.count).toBe(3);
    expect(shift?.fromFrame).toBe(30);
  });

  it("addClipsAcceptsSourceSecondsSpan", async () => {
    const h = new ToolHarness();
    const asset = h.addAsset({ type: "video", duration: 10 });
    const json = await h.runOK("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, source: [2.0, 5.0] }] });
    const clip = receipts(json)[0];
    expect(clip?.frames).toEqual([0, 90]);
    expect(clip?.trimStartFrame).toBe(60);

    const mixed = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, source: [2.0, 5.0], endFrame: 30 }] });
    expect(mixed.isError).toBe(true);
  });

  it("setClipPropertiesEchoesResultingValuesAndKeyframeClear", async () => {
    const { h, clipId } = setupClipForKeyframes();
    await h.runRaw("set_keyframes", { clipId, property: "volumeDb", keyframes: [[0, 0.0], [30, -60.0]] });
    const json = await h.runOK("set_clip_properties", { clipIds: [clipId], volumeDb: -6.0, speed: 2.0 });
    const clip = receipts(json)[0];
    expect(clip?.volumeDb).toBe(-6);
    expect(clip?.speed).toBe(2.0);
    expect(clip?.keyframes).toBeUndefined();
    expect(((json.notes as string[] | undefined)?.[0]) ?? "").toContain("cleared existing keyframes");
  });

  it("setProjectSettingsReturnsChangedFieldsAsJSON", async () => {
    const h = new ToolHarness();
    const json = await h.runOK("set_project_settings", { fps: 60 });
    expect(json.fps).toBe(60);
    expect(json.changed).toEqual(["fps"]);
    expect(String(json.note)).toContain("re-read");

    const noop = await h.runOK("set_project_settings", { fps: 60 });
    expect(noop.changed).toEqual([]);
    expect(noop.note).toBe("Settings already matched.");
  });

  it("fpsOnlyProjectSettingsPreserveOversizedResolution", async () => {
    const timeline = Fixtures.timeline();
    timeline.width = 9000;
    timeline.height = 4500;
    const h = new ToolHarness(timeline);

    const json = await h.runOK("set_project_settings", { fps: 60 });

    expect(json.changed).toEqual(["fps"]);
    expect(h.editor.timeline.width).toBe(9000);
    expect(h.editor.timeline.height).toBe(4500);
  });

  it("visibleClipsListsTopDownAndCollapsesCaptionGroups", () => {
    const caption = Fixtures.clip({ id: "cap-0", mediaType: "text", start: 0, duration: 90 });
    caption.captionGroupId = "g1";
    const hiddenTrack = Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "hidden", start: 0, duration: 90 })] });
    hiddenTrack.hidden = true;
    const timeline = Fixtures.timeline({
      tracks: [
        Fixtures.videoTrack({ clips: [caption] }),
        hiddenTrack,
        Fixtures.videoTrack({
          clips: [Fixtures.clip({ id: "main", start: 0, duration: 60 }), Fixtures.clip({ id: "later", start: 60, duration: 30 })],
        }),
        Fixtures.audioTrack({ clips: [Fixtures.clip({ id: "aud", mediaType: "audio", start: 0, duration: 90 })] }),
      ],
    });
    expect(visibleClips(30, timeline)).toEqual(["g1", "main"]);
    expect(visibleClips(70, timeline)).toEqual(["g1", "later"]);
  });

  it("getTimelineFoldsLinkedAudioIntoVideoClip", async () => {
    const h = new ToolHarness();
    h.addAsset({ id: "av-src", duration: 10, hasAudio: true });
    await h.runRaw("add_clips", { entries: [{ mediaRef: "av-src", startFrame: 0, endFrame: 60 }] });
    const audioClip = h.editor.timeline.tracks.find((t) => t.type === "audio")?.clips[0];
    const audioId = audioClip?.id ?? "";
    expect(audioId).not.toBe("");
    await h.runRaw("set_clip_properties", { clipIds: [audioId], volumeDb: -60.0 });

    const json = await h.runOK("get_timeline");
    const tracks = (json.tracks as Json[] | undefined) ?? [];
    const videoTrack = tracks.find((t) => t.type === "video");
    const audioTrack = tracks.find((t) => t.type === "audio");

    const video = (videoTrack?.clips as Json[] | undefined)?.[0];
    const audio = video?.audio as Json | undefined;
    expect(typeof audio?.id === "string" && audioId.startsWith(audio.id)).toBe(true);
    expect(audio?.track).toBe(audioTrack?.index);
    expect(audio?.volumeDb).toBe(-60);
    expect(video?.linkGroupId).toBeUndefined();

    expect(audioTrack?.clips).toBeUndefined();
    expect(audioTrack?.linkedClips).toBe(1);
  });
});

describe("ToolExecutor — set_clip_properties", () => {
  it("transformPreservesRotation", async () => {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 60 });
    clip.transform.rotation = 45.0;
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    await h.runRaw("set_clip_properties", { clipIds: ["c1"], transform: { centerX: 0.3 } });

    const updated = h.editor.timeline.tracks[0].clips[0];
    expect(updated.transform.rotation).toBe(45.0);
  });

  it("updateTextCaptionGroupCollapsesToSummary", async () => {
    const clips: Clip[] = [];
    for (let i = 0; i < 3; i++) {
      const c = textClip({ id: `cap-${i}`, start: i * 30, duration: 30 });
      c.captionGroupId = "g1";
      c.textContent = `word${i}`;
      clips.push(c);
    }
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips })] }));

    const result = await h.runRaw("update_text", { captionGroupId: "g1", style: { color: "#FF0000" } });
    expect(result.isError, textOf(result)).toBe(false);
    const json = parse(result);
    expect(json.clips).toBeUndefined();
    const group = (json.captionGroups as Json[] | undefined)?.[0];
    expect(group?.captionGroupId).toBe("g1");
    expect(group?.clipCount).toBe(3);
    expect(group?.textPreview).toBe("word0 … word2");
  });

  it("updateTextSingleCaptionReceiptPreservesDeviantStyle", async () => {
    const clips: Clip[] = [];
    for (let i = 0; i < 3; i++) {
      const clip = textClip({ id: `cap-${i}`, start: i * 30, duration: 30 });
      clip.captionGroupId = "g1";
      clip.textContent = `word${i}`;
      clip.textStyle = makeTextStyle();
      clips.push(clip);
    }
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips })] }));

    const result = await h.runRaw("update_text", { clipIds: ["cap-1"], style: { color: "#FF0000" } });

    expect(result.isError, textOf(result)).toBe(false);
    const receipt = receipts(parse(result))[0];
    const color = (receipt?.textStyle as Json | undefined)?.color as Json | undefined;
    expect(receipt?.id).toBe("cap-1");
    expect(receipt?.captionGroupId).toBe("g1");
    expect(color?.r).toBeUndefined();
    expect(color?.g).toBe(0);
    expect(color?.b).toBe(0);
  });

  it("updateTextCaptionGroupAcceptsRichTextStyleFields", async () => {
    const a = textClip({ id: "cap-a", start: 0, duration: 30 });
    const b = textClip({ id: "cap-b", start: 30, duration: 30 });
    a.captionGroupId = "captions";
    b.captionGroupId = "captions";
    a.textContent = "one";
    b.textContent = "two";
    a.textStyle = makeTextStyle();
    b.textStyle = makeTextStyle();
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [a, b] })] }));

    const result = await h.runRaw("update_text", {
      captionGroupId: "captions",
      style: {
        alignment: "left",
        outline: { enabled: true, color: "#FFFFFF" },
        background: { enabled: true, color: "#00000080" },
      },
    });

    expect(result.isError, textOf(result)).toBe(false);
    expect(receipts(parse(result)).length).toBe(2);
    for (const clip of h.editor.timeline.tracks[0].clips) {
      expect(clip.textStyle?.alignment).toBe("left");
      expect(clip.textStyle?.border.enabled).toBe(true);
      expect(clip.textStyle?.border.color).toEqual(rgbaFromHex("#FFFFFF"));
      expect(clip.textStyle?.background.enabled).toBe(true);
      expect(clip.textStyle?.background.color).toEqual(rgbaFromHex("#00000080"));
    }
  });

  it("updateTextNestedColorPreservesSeparateOpacity", async () => {
    const clip = textClip({ id: "title", start: 0, duration: 60 });
    const style = makeTextStyle();
    style.shadow.color = makeRGBA({ r: 0, g: 0, b: 0, a: 0.25 });
    clip.textStyle = style;
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], style: { shadow: { color: "#FF0000" } } });

    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks[0].clips[0].textStyle?.shadow.color).toEqual({ r: 1, g: 0, b: 0, a: 0.25 });
  });

  it("updateTextAnimationPreservesExistingHighlight", async () => {
    const highlight = makeRGBA({ r: 1, g: 0, b: 0, a: 1 });
    const clip = textClip({ id: "title", start: 0, duration: 60 });
    clip.textContent = "Title";
    clip.textAnimation = makeTextAnimation({ preset: "highlightPop", perWordFrames: 12, highlight });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], animation: "wordSlide" });

    expect(result.isError, textOf(result)).toBe(false);
    const animation = h.editor.timeline.tracks[0].clips[0].textAnimation;
    expect(animation?.preset).toBe("wordSlide");
    expect(animation?.perWordFrames).toBe(12);
    expect(animation?.highlight).toEqual(highlight);
  });

  it("updateTextContentClearsWordTimings", async () => {
    const clip = textClip({ id: "title", start: 0, duration: 60 });
    clip.textContent = "old text";
    clip.textStyle = makeTextStyle();
    clip.wordTimings = [{ text: "old", startFrame: 0, endFrame: 30 }, { text: "text", startFrame: 30, endFrame: 60 }];
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], content: "new text" });

    expect(result.isError, textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks[0].clips[0].wordTimings).toBeUndefined();
  });
});
