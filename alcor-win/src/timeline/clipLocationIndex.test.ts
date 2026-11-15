import { describe, expect, it } from "vitest";
import { makeTimeline } from "../model";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import { Editor, makeEditorDocument } from "../editor/editor";

function makeEditor(): Editor {
  const doc = makeEditorDocument();
  const timeline = fixtureTimeline({
    tracks: [
      fixtureVideoTrack({
        clips: [fixtureClip({ id: "v1", start: 0, duration: 30 }), fixtureClip({ id: "v2", start: 30, duration: 30 })],
      }),
      fixtureAudioTrack({ clips: [fixtureClip({ id: "a1", mediaType: "audio", start: 0, duration: 60 })] }),
    ],
  });
  timeline.id = doc.timelines[0]?.id ?? timeline.id;
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  return new Editor(doc);
}

describe("EditorViewModel - clip location index", () => {
  it("findsClipsAcrossTracks", () => {
    const e = makeEditor();
    expect(e.findClip("v2")).toEqual({ trackIndex: 0, clipIndex: 1 });
    expect(e.findClip("a1")).toEqual({ trackIndex: 1, clipIndex: 0 });
    expect(e.findClip("missing")).toBeNull();
  });

  it("indexFollowsMutations", () => {
    const e = makeEditor();
    e.findClip("v1");
    e.perform("Remove", () => {
      e.timeline.tracks[0]?.clips.splice(0, 1);
    });
    expect(e.findClip("v1")).toBeNull();
    expect(e.findClip("v2")).toEqual({ trackIndex: 0, clipIndex: 0 });
  });

  it("indexFollowsUndo", () => {
    const e = makeEditor();
    e.perform("Opacity", () => {
      const clip = e.timeline.tracks[0]?.clips[0];
      if (clip) clip.opacity = 0.5;
    });
    e.findClip("v1");
    e.undo();
    expect(e.clipFor("v1")?.opacity).toBe(1.0);
  });

  it("indexFollowsActiveTimelineSwitch", () => {
    const e = makeEditor();
    e.findClip("v1");
    const second = makeTimeline({
      id: "second",
      tracks: [fixtureVideoTrack({ clips: [fixtureClip({ id: "other", start: 0, duration: 30 })] })],
    });
    e.perform("Switch", () => {
      e.timelines.push(second);
      e.doc.activeTimelineId = "second";
    });
    expect(e.findClip("v1")).toBeNull();
    expect(e.findClip("other")).toEqual({ trackIndex: 0, clipIndex: 0 });
  });
});
