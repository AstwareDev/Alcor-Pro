import { describe, expect, it } from "vitest";
import type { Clip, ClipType } from "../../model";
import {
  expandToLinkGroup,
  linkClips,
  linkGroupOffsets,
  linkIndex,
  linkedPartnerIds,
  unlinkClips,
} from "./linking";
import { Fixtures, makeEditor, allClips } from "./testFixtures";

function clipWithGroup(p: { id: string; group?: string; start?: number; duration?: number; mediaType?: ClipType }): Clip {
  const c = Fixtures.clip({ id: p.id, mediaType: p.mediaType ?? "video", start: p.start ?? 0, duration: p.duration ?? 30 });
  if (p.group !== undefined) c.linkGroupId = p.group;
  return c;
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe("EditorViewModel - linking", () => {
  // MARK: - linkIndex

  it("linkIndexMapsGroupIDsToMemberClipIDs", () => {
    const v = clipWithGroup({ id: "v", group: "g1" });
    const a = clipWithGroup({ id: "a", group: "g1", mediaType: "audio" });
    const solo = clipWithGroup({ id: "solo" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v, solo] }), Fixtures.audioTrack({ clips: [a] })]);
    const idx = linkIndex(editor);
    expect([...(idx.get("g1") ?? [])].sort()).toEqual(["a", "v"]);
    expect([...idx.values()].some((m) => m.includes("solo"))).toBe(false);
  });

  it("linkIndexIsEmptyForUngroupedTimeline", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })]);
    expect(linkIndex(editor).size).toBe(0);
  });

  // MARK: - expandToLinkGroup

  it("expandReturnsInputUnchangedWhenNoneAreLinked", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "a", start: 0, duration: 30 })] })]);
    expect(sorted(expandToLinkGroup(editor, new Set(["a"])))).toEqual(["a"]);
  });

  it("expandPullsInAllPartnersOfATouchedGroup", () => {
    const v = clipWithGroup({ id: "v", group: "g1" });
    const a = clipWithGroup({ id: "a", group: "g1", mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    expect(sorted(expandToLinkGroup(editor, new Set(["v"])))).toEqual(["a", "v"]);
  });

  it("expandHandlesMultipleGroupsIndependently", () => {
    const v1 = clipWithGroup({ id: "v1", group: "g1" });
    const a1 = clipWithGroup({ id: "a1", group: "g1", mediaType: "audio" });
    const v2 = clipWithGroup({ id: "v2", group: "g2", start: 100 });
    const a2 = clipWithGroup({ id: "a2", group: "g2", start: 100, mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v1, v2] }), Fixtures.audioTrack({ clips: [a1, a2] })]);
    expect(sorted(expandToLinkGroup(editor, new Set(["v1", "v2"])))).toEqual(["a1", "a2", "v1", "v2"]);
  });

  // MARK: - linkedPartnerIds

  it("linkedPartnersExcludeSelf", () => {
    const v = clipWithGroup({ id: "v", group: "g1" });
    const a = clipWithGroup({ id: "a", group: "g1", mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    expect(linkedPartnerIds(editor, "v")).toEqual(["a"]);
    expect(linkedPartnerIds(editor, "a")).toEqual(["v"]);
  });

  it("linkedPartnersIsEmptyForUngroupedClip", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "solo", start: 0, duration: 30 })] })]);
    expect(linkedPartnerIds(editor, "solo")).toEqual([]);
  });

  it("linkedPartnersIsEmptyForUnknownClip", () => {
    expect(linkedPartnerIds(makeEditor(), "ghost")).toEqual([]);
  });

  // MARK: - linkGroupOffsets

  it("linkGroupOffsetsReturnsEmptyWhenPartnersInSync", () => {
    const v = clipWithGroup({ id: "v", group: "g1", start: 100 });
    const a = clipWithGroup({ id: "a", group: "g1", start: 100, mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    expect(linkGroupOffsets(editor).size).toBe(0);
  });

  it("linkGroupOffsetsReportsDeltaForOutOfSyncPartner", () => {
    const v = clipWithGroup({ id: "v", group: "g1", start: 100 });
    const a = clipWithGroup({ id: "a", group: "g1", start: 110, mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    const offsets = linkGroupOffsets(editor);
    expect(offsets.get("v")).toBeUndefined();
    expect(offsets.get("a")).toBe(10);
  });

  it("linkGroupOffsetsIgnoresSingletonGroups", () => {
    const solo = clipWithGroup({ id: "solo", group: "g1" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [solo] })]);
    expect(linkGroupOffsets(editor).size).toBe(0);
  });

  // MARK: - linkClips / unlinkClips

  it("linkClipsStampsSharedGroupOnTwoOrMoreSelectedClips", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const c2 = Fixtures.clip({ id: "c2", mediaType: "audio", start: 0, duration: 30 });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [c1] }), Fixtures.audioTrack({ clips: [c2] })]);
    linkClips(editor, new Set(["c1", "c2"]));
    const groups = allClips(editor).flatMap((c) => (c.linkGroupId === undefined ? [] : [c.linkGroupId]));
    expect(groups.length).toBe(2);
    expect(new Set(groups).size, "both clips should share a single group id").toBe(1);
    expect(editor.store.undoActionName).toBe("Link");
  });

  it("linkClipsRequiresAtLeastTwoClips", () => {
    const c1 = Fixtures.clip({ id: "c1", start: 0, duration: 30 });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [c1] })]);
    linkClips(editor, new Set(["c1"]));
    expect(editor.timeline.tracks[0].clips[0].linkGroupId).toBeUndefined();
    expect(editor.store.canUndo).toBe(false);
  });

  it("unlinkClipsClearsGroupOnAllPartners", () => {
    const v = clipWithGroup({ id: "v", group: "g1" });
    const a = clipWithGroup({ id: "a", group: "g1", mediaType: "audio" });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v] }), Fixtures.audioTrack({ clips: [a] })]);
    const before = editor.timeline;
    unlinkClips(editor, new Set(["v"]));
    expect(editor.timeline.tracks[0].clips[0].linkGroupId).toBeUndefined();
    expect(editor.timeline.tracks[1].clips[0].linkGroupId).toBeUndefined();
    editor.undo();
    expect(editor.timeline).toBe(before);
  });
});
