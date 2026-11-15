import { describe, expect, it } from "vitest";
import type { Editor } from "../editor";
import { linkTargets, unlinkTargets } from "./linking";
import { Fixtures, makeEditor } from "./testFixtures";

function editor(): Editor {
  const video = Fixtures.clip({ id: "v1", start: 0, duration: 60 });
  const audio = Fixtures.clip({ id: "a1", mediaType: "audio", start: 0, duration: 60 });
  video.linkGroupId = "g1";
  audio.linkGroupId = "g1";
  const looseVideo = Fixtures.clip({ id: "v2", start: 100, duration: 60 });
  const looseAudio = Fixtures.clip({ id: "a2", mediaType: "audio", start: 100, duration: 60 });
  return makeEditor([
    Fixtures.videoTrack({ clips: [video, looseVideo] }),
    Fixtures.audioTrack({ clips: [audio, looseAudio] }),
  ]);
}

const sorted = (s: Iterable<string> | null): string[] | null => (s === null ? null : [...s].sort());

describe("EditorViewModel - link eligibility", () => {
  it("linkTargetsAcceptsMixedTypeUnlinkedClips", () => {
    expect(sorted(linkTargets(editor(), new Set(["v2", "a2"])))).toEqual(["a2", "v2"]);
  });

  it("linkTargetsRejectsSingleClipAndSameType", () => {
    const e = editor();
    expect(linkTargets(e, new Set(["v2"]))).toBeNull();
    expect(linkTargets(e, new Set(["v1", "v2"]))?.has("a1")).toBe(true);
  });

  it("linkTargetsRejectsFullyLinkedGroup", () => {
    expect(linkTargets(editor(), new Set(["v1", "a1"]))).toBeNull();
  });

  it("linkTargetsRejectsUnknownIds", () => {
    expect(linkTargets(editor(), new Set(["v2", "missing"]))).toBeNull();
  });

  it("unlinkTargetsExpandsGroupAndSkipsUnlinked", () => {
    const e = editor();
    expect(sorted(unlinkTargets(e, new Set(["v1"])))).toEqual(["a1", "v1"]);
    expect(unlinkTargets(e, new Set(["v2", "a2"])).size).toBe(0);
  });
});
