import { describe, expect, it } from "vitest";
import { rippleDeleteRanges, rippleDeleteSelectedClips } from "./ripple";
import { makeFrameRange as FrameRange } from "../rippleEngine";
import { Fixtures, makeEditor, marker } from "./testFixtures";
import type { Editor } from "../editor";
import type { TimelineMarker } from "../../model";

function editorWith(markers: TimelineMarker[], ripple: boolean): Editor {
  const e = makeEditor(
    [
      Fixtures.videoTrack({
        clips: [
          Fixtures.clip({ id: "c1", start: 0, duration: 100, trimEnd: 50 }),
          Fixtures.clip({ id: "c2", start: 100, duration: 50 }),
        ],
      }),
    ],
    { markers },
  );
  e.ui.rippleTimelineMarkers = ripple;
  return e;
}

describe("EditorViewModel - ripple timeline markers", () => {
  it("rippleDeleteShiftsAndRemovesMarkersWhenEnabled", () => {
    const e = editorWith([marker("before", "Before", 10), marker("inside", "Inside", 45), marker("after", "After", 80)], true);
    const outcome = rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]);
    expect(outcome.kind).toBe("ok");
    expect(e.timeline.markers.map((m) => m.id)).toEqual(["before", "after"]);
    expect(e.timeline.markers.map((m) => m.startFrame)).toEqual([10, 70]);
  });

  it("rippleDeleteLeavesMarkersWhenDisabled", () => {
    const e = editorWith([marker("inside", "Inside", 45), marker("after", "After", 80)], false);
    const outcome = rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]);
    expect(outcome.kind).toBe("ok");
    expect(e.timeline.markers.map((m) => m.startFrame)).toEqual([45, 80]);
  });

  it("multiTrackRippleDeleteDoesNotOverShiftMarkers", () => {
    const e = makeEditor(
      [
        Fixtures.videoTrack({
          clips: [Fixtures.clip({ id: "v1", start: 0, duration: 50 }), Fixtures.clip({ id: "v2", start: 200, duration: 100 })],
        }),
        Fixtures.audioTrack({
          clips: [
            Fixtures.clip({ id: "a1", mediaType: "audio", start: 200, duration: 50 }),
            Fixtures.clip({ id: "a2", mediaType: "audio", start: 300, duration: 50 }),
          ],
        }),
      ],
      { markers: [marker("onPicture", "On picture", 220), marker("after", "After", 300)] },
    );
    e.ui.rippleTimelineMarkers = true;
    e.ui.selectedClipIds = new Set(["v1", "a1"]);
    rippleDeleteSelectedClips(e);
    expect(e.timeline.markers.map((m) => m.id)).toEqual(["onPicture", "after"]);
    expect(e.timeline.markers.map((m) => m.startFrame)).toEqual([170, 250]);
  });

  it("multiTrackRippleDeleteDoesNotFollowACollapsedHole", () => {
    const e = makeEditor(
      [
        Fixtures.videoTrack({
          clips: [Fixtures.clip({ id: "v1", start: 0, duration: 50 }), Fixtures.clip({ id: "v2", start: 200, duration: 100 })],
        }),
        Fixtures.audioTrack({
          clips: [
            Fixtures.clip({ id: "a1", mediaType: "audio", start: 100, duration: 150 }),
            Fixtures.clip({ id: "a2", mediaType: "audio", start: 300, duration: 50 }),
          ],
        }),
      ],
      { markers: [marker("onPicture", "On picture", 220)] },
    );
    e.ui.rippleTimelineMarkers = true;
    e.ui.selectedClipIds = new Set(["v1", "a1"]);
    rippleDeleteSelectedClips(e);
    expect(e.timeline.markers.map((m) => m.startFrame)).toEqual([170]);
  });

  it("markerRippleUndoesWithTheEdit", () => {
    const e = editorWith([marker("after", "After", 80)], true);
    const outcome = rippleDeleteRanges(e, "c1", [FrameRange(40, 50)]);
    expect(outcome.kind).toBe("ok");
    expect(e.timeline.markers[0].startFrame).toBe(70);
    e.undo();
    expect(e.timeline.markers[0].startFrame).toBe(80);
    e.redo();
    expect(e.timeline.markers[0].startFrame).toBe(70);
  });
});
