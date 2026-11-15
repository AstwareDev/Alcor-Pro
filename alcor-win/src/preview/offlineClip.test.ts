import { describe, expect, it } from "vitest";
import { setUnprocessableMediaRef } from "../media/libraryCore";
import { Fixtures, makeEditor } from "../editor/mutations/testFixtures";
import { offlineOverlayAt, timelineFrameState } from "./offlineClip";

function setup(overlap = false) {
  const a = Fixtures.clip({ id: "a", mediaRef: "m1", start: 0, duration: 100 });
  const b = Fixtures.clip({ id: "b", mediaRef: "m2", start: overlap ? 0 : 200, duration: 100 });
  return makeEditor([Fixtures.videoTrack({ clips: [a] }), Fixtures.videoTrack({ clips: [b] })]);
}

describe("timelineFrameState", () => {
  it("isNoneWhenNothingIsOffline", () => {
    expect(timelineFrameState(setup(), 10).kind).toBe("none");
  });

  it("reportsTheOfflineClipUnderThePlayhead", () => {
    const editor = setup();
    editor.ui.missingMediaRefs = new Set(["m1"]);
    expect(timelineFrameState(editor, 10)).toMatchObject({ kind: "offline" });
    expect(timelineFrameState(editor, 100).kind).toBe("none");
  });

  it("anotherUsableClipCoversTheFrame", () => {
    const editor = setup(true);
    editor.ui.missingMediaRefs = new Set(["m2"]);
    expect(timelineFrameState(editor, 10).kind).toBe("covered");
  });

  it("hiddenAndAudioTracksAreIgnored", () => {
    const editor = setup();
    editor.ui.missingMediaRefs = new Set(["m1"]);
    editor.withoutRegistration(() => {
      editor.timeline.tracks[0].hidden = true;
    });
    expect(timelineFrameState(editor, 10).kind).toBe("none");
  });
});

describe("offlineOverlayAt", () => {
  it("carriesTheAssetPathAndUnprocessableFlag", () => {
    const editor = setup();
    editor.withoutRegistration(() => {
      editor.doc.mediaAssets.push({ id: "m1", url: "/x/a.mp4", type: "video", name: "a", duration: 1, hasAudio: false, generationStatus: { kind: "none" } });
    });
    editor.ui.offlineMediaRefs = new Set(["m1"]);
    expect(offlineOverlayAt(editor, 5)).toEqual({ assetId: "m1", path: "/x/a.mp4", isUnprocessable: false });
    setUnprocessableMediaRef(editor, "m1", true);
    expect(offlineOverlayAt(editor, 5)?.isUnprocessable).toBe(true);
  });
});
