import { describe, expect, it } from "vitest";
import { makeCrop, type Timeline } from "../../model";
import { clipDisplayLabel } from "./core";
import { decomposeNest, nestSelectedClips, nestTimeline } from "./nesting";
import { Fixtures, makeEditor, setup, timelineCopy } from "./testFixtures";

const newTrackAt0 = { kind: "newTrackAt", index: 0 } as const;

describe("Nesting — drop flow", () => {
  it("nestTimelineCreatesLinkedClipsAndUndoes", () => {
    const e = makeEditor();
    const child: Timeline = Fixtures.timeline({
      tracks: [
        Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 60 })] }),
        Fixtures.audioTrack({ clips: [Fixtures.clip({ mediaType: "audio", start: 0, duration: 60 })] }),
      ],
    });
    child.name = "Intro";
    setup(e, (ed) => ed.doc.timelines.push(child));

    expect(nestTimeline(e, child.id, newTrackAt0, 30)).toBe(true);

    const videoClips = e.timeline.tracks.find((t) => t.type === "video")?.clips ?? [];
    const audioClips = e.timeline.tracks.find((t) => t.type === "audio")?.clips ?? [];
    expect(videoClips).toHaveLength(1);
    expect(videoClips[0].mediaType).toBe("sequence");
    expect(videoClips[0].mediaRef).toBe(child.id);
    expect(videoClips[0].startFrame).toBe(30);
    expect(videoClips[0].durationFrames).toBe(60);
    expect(audioClips).toHaveLength(1);
    expect(audioClips[0].sourceClipType).toBe("sequence");
    expect(audioClips[0].linkGroupId).toBe(videoClips[0].linkGroupId);
    expect(clipDisplayLabel(e, videoClips[0])).toBe("Intro");

    e.undo();
    expect(e.timeline.tracks.every((t) => t.clips.length === 0)).toBe(true);
  });

  it("nestSelectedClipsMovesSelectionIntoNewTimeline", () => {
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "t1", start: 0, duration: 20 }), Fixtures.clip({ id: "t2", start: 40, duration: 20 })] }),
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "v1", start: 30, duration: 60 })] }),
      Fixtures.audioTrack({
        clips: [Fixtures.clip({ id: "a1", mediaType: "audio", start: 30, duration: 30 }), Fixtures.clip({ id: "a2", mediaType: "audio", start: 100, duration: 10 })],
      }),
    ]);
    const before = timelineCopy(e);
    e.ui.selectedClipIds = new Set(["t2", "v1", "a1"]);

    nestSelectedClips(e);

    const child = e.timelines.find((t) => t.name === "Nest 1");
    expect(child).toBeDefined();
    expect(child?.tracks.map((t) => t.type)).toEqual(["video", "video", "audio"]);
    expect(child?.tracks[0].clips.map((c) => c.startFrame)).toEqual([10]);
    expect(child?.tracks[1].clips.map((c) => c.startFrame)).toEqual([0]);
    expect(child?.tracks[2].clips.map((c) => c.startFrame)).toEqual([0]);
    expect(Math.max(...(child?.tracks.flatMap((t) => t.clips.map((c) => c.startFrame + c.durationFrames)) ?? [0]))).toBe(60);

    const videoLane = e.timeline.tracks.find((t) => t.type === "video");
    const audioLane = e.timeline.tracks.find((t) => t.type === "audio");
    expect(e.timeline.tracks).toHaveLength(2);
    const v = videoLane?.clips.find((c) => c.sourceClipType === "sequence");
    const a = audioLane?.clips.find((c) => c.sourceClipType === "sequence");
    expect(v?.startFrame).toBe(30);
    expect(v?.durationFrames).toBe(60);
    expect(a?.mediaType).toBe("audio");
    expect(v?.linkGroupId).toBeDefined();
    expect(v?.linkGroupId).toBe(a?.linkGroupId);
    expect(videoLane?.clips.some((c) => c.id === "t1")).toBe(true);
    expect(audioLane?.clips.some((c) => c.id === "a2")).toBe(true);
    expect(e.ui.selectedClipIds).toEqual(new Set([v?.id, a?.id]));

    e.undo();
    expect(e.timeline).toEqual(before);
    expect(e.timelines).toHaveLength(1);
  });

  it("nestSelectedClipsKeepsUnselectedClipInsideSpan", () => {
    const e = makeEditor([
      Fixtures.videoTrack({
        clips: [
          Fixtures.clip({ id: "s1", start: 0, duration: 20 }),
          Fixtures.clip({ id: "mid", start: 30, duration: 20 }),
          Fixtures.clip({ id: "s2", start: 60, duration: 20 }),
        ],
      }),
    ]);
    e.ui.selectedClipIds = new Set(["s1", "s2"]);

    nestSelectedClips(e);

    const all = e.timeline.tracks.flatMap((t) => t.clips);
    expect(all.some((c) => c.id === "mid")).toBe(true);
    const carrier = all.find((c) => c.sourceClipType === "sequence");
    expect(carrier?.startFrame).toBe(0);
    expect(carrier?.durationFrames).toBe(80);
    expect(e.timeline.tracks).toHaveLength(2);
  });

  it("nestSelectedClipsRegeneratesGroupIdsInChild", () => {
    const v = Fixtures.clip({ id: "v", start: 0, duration: 30 });
    v.linkGroupId = "g1";
    const a = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 30 });
    a.linkGroupId = "g1";
    const e = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    e.ui.selectedClipIds = new Set(["v"]);

    nestSelectedClips(e);

    const child = e.timelines.find((t) => t.name === "Nest 1");
    const moved = child?.tracks.flatMap((t) => t.clips)[0];
    expect(moved).toBeDefined();
    expect(moved?.linkGroupId).not.toBe("g1");
    expect(e.timeline.tracks.flatMap((t) => t.clips).some((c) => c.id === "a" && c.linkGroupId === "g1")).toBe(true);
  });

  it("decomposeReplacesNestWithChildClipsInPlace", () => {
    const e = makeEditor();
    const linked = Fixtures.clip({ id: "cv", start: 0, duration: 40 });
    linked.linkGroupId = "g1";
    const linkedAudio = Fixtures.clip({ id: "ca", mediaType: "audio", start: 0, duration: 40, volume: 0.8 });
    linkedAudio.linkGroupId = "g1";
    const child = Fixtures.timeline({
      tracks: [
        Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "top", start: 10, duration: 20 })] }),
        Fixtures.videoTrack({ clips: [linked] }),
        Fixtures.audioTrack({ clips: [linkedAudio] }),
      ],
    });
    setup(e, (ed) => ed.doc.timelines.push(child));
    expect(nestTimeline(e, child.id, newTrackAt0, 100)).toBe(true);
    const nestId = e.timeline.tracks.find((t) => t.type === "video")?.clips[0].id ?? "";
    const nestVolume = 0.5;
    const carrierIdx = e.timeline.tracks.findIndex((t) => t.type === "audio");
    setup(e, (ed) => {
      ed.timeline.tracks[carrierIdx].clips[0].volume = nestVolume;
    });
    const before = timelineCopy(e);

    decomposeNest(e, nestId);

    const videoTracks = e.timeline.tracks.filter((t) => t.type === "video");
    const audioTracks = e.timeline.tracks.filter((t) => t.type === "audio");
    expect(videoTracks).toHaveLength(2);
    expect(audioTracks).toHaveLength(1);
    expect(videoTracks[0].clips.map((c) => c.startFrame)).toEqual([110]);
    expect(videoTracks[1].clips.map((c) => c.startFrame)).toEqual([100]);
    expect(audioTracks[0].clips.map((c) => c.startFrame)).toEqual([100]);
    const v = videoTracks[1].clips[0];
    const a = audioTracks[0].clips[0];
    expect(v.id).not.toBe("cv");
    expect(a.id).not.toBe("ca");
    expect(v.linkGroupId).toBeDefined();
    expect(v.linkGroupId).toBe(a.linkGroupId);
    expect(v.linkGroupId).not.toBe("g1");
    expect(Math.abs(a.volume - 0.8 * nestVolume)).toBeLessThan(0.0001);
    expect(e.ui.toast).toBeNull();

    e.undo();
    expect(e.timeline).toEqual(before);
  });

  it("composeThenDecomposeRoundTripsToOriginalTracks", () => {
    const e = makeEditor([
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "capIntro", start: 0, duration: 25 }), Fixtures.clip({ id: "cap", start: 30, duration: 40 })] }),
      Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "vIntro", start: 0, duration: 25 }), Fixtures.clip({ id: "v", start: 30, duration: 60 })] }),
      Fixtures.audioTrack({
        clips: [Fixtures.clip({ id: "aIntro", mediaType: "audio", start: 0, duration: 25 }), Fixtures.clip({ id: "a", mediaType: "audio", start: 30, duration: 60 })],
      }),
    ]);
    e.ui.selectedClipIds = new Set(["cap", "v", "a"]);

    nestSelectedClips(e);
    const carrier = e.timeline.tracks.flatMap((t) => t.clips).find((c) => c.mediaType === "sequence");
    decomposeNest(e, carrier?.id ?? "");

    expect(e.timeline.tracks).toHaveLength(3);
    expect(e.timeline.tracks[0].clips.map((c) => c.startFrame)).toEqual([0, 30]);
    expect(e.timeline.tracks[1].clips.map((c) => c.startFrame)).toEqual([0, 30]);
    expect(e.timeline.tracks[2].clips.map((c) => c.startFrame)).toEqual([0, 30]);
    expect(e.timeline.tracks[1].clips[1].durationFrames).toBe(60);
    expect(e.timeline.tracks.some((t) => t.clips.length === 0)).toBe(false);
  });

  it("decomposeWarnsWhenGroupLookIsDiscarded", () => {
    const e = makeEditor();
    const child = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 30 })] })] });
    setup(e, (ed) => ed.doc.timelines.push(child));
    expect(nestTimeline(e, child.id, newTrackAt0, 0)).toBe(true);
    const nestId = e.timeline.tracks[0].clips[0].id;
    setup(e, (ed) => {
      ed.timeline.tracks[0].clips[0].crop = makeCrop({ left: 0.2 });
    });

    decomposeNest(e, nestId);
    expect(e.ui.toast).not.toBeNull();
    expect(e.timeline.tracks[0].clips.some((c) => c.sourceClipType === "sequence")).toBe(false);
  });

  it("nestRejectsCyclesAndEmptyTimelines", () => {
    const e = makeEditor();
    const empty = Fixtures.timeline();
    setup(e, (ed) => ed.doc.timelines.push(empty));
    expect(nestTimeline(e, empty.id, newTrackAt0, 0)).toBe(false);

    setup(e, (ed) => {
      ed.timeline.tracks = [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 30 })] })];
    });
    expect(nestTimeline(e, e.doc.activeTimelineId, newTrackAt0, 0)).toBe(false);

    const b = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 30 })] })] });
    setup(e, (ed) => ed.doc.timelines.push(b));
    const aId = e.doc.activeTimelineId;
    expect(nestTimeline(e, b.id, newTrackAt0, 0)).toBe(true);
    setup(e, (ed) => {
      ed.doc.activeTimelineId = b.id;
    });
    expect(nestTimeline(e, aId, newTrackAt0, 0)).toBe(false);
  });
});
