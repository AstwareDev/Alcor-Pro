import { describe, expect, it } from "vitest";
import { clipUpsertKeyframe, makeKeyframe, makeKeyframeTrack, type Clip } from "../model";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import {
  keyframeLaneHit,
  keyframeLaneNavigationTargets,
  keyframeLaneTarget,
  minZoomScale,
  selectForwardFromCurrentSelection,
  selectForwardIds,
  timelineTrackDisplayLabel,
  trackClipIds,
  zoomAnchored,
  playheadAnchoredScrollX,
} from "./timelineInput";
import { laneRect, makeTimelineGeometry, xForFrame } from "./timelineGeometry";

describe("Timeline zoom", () => {
  it("minimumZoomUsesScrollableViewportWidth", () => {
    const timeline = fixtureTimeline({
      tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 100 })] })],
    });

    expect(minZoomScale(timeline, 600)).toBe(2);
  });

  it("zoomAnchoredKeepsFrameUnderCursor", () => {
    const r = zoomAnchored({ zoomScale: 4, minZoomScale: 0.05, factor: 2, anchorDocX: 400, scrollOriginX: 100 });
    // Frame 100 under the cursor stays at viewport x=300: 100 * 8 - 300.
    expect(r).toEqual({ newScale: 8, scrollX: 500 });
    expect(zoomAnchored({ zoomScale: 40, minZoomScale: 0.05, factor: 2, anchorDocX: 0, scrollOriginX: 0 })).toBeUndefined();
  });

  it("playheadAnchoredScrollKeepsVisiblePlayheadInPlace", () => {
    expect(playheadAnchoredScrollX({ previousZoom: 4, zoomScale: 8, activeFrame: 100, originX: 300, visibleWidth: 400 })).toBe(700);
    expect(playheadAnchoredScrollX({ previousZoom: 4, zoomScale: 4, activeFrame: 100, originX: 300, visibleWidth: 400 })).toBeUndefined();
  });
});

describe("EditorViewModel - select forward", () => {
  it("selectForwardOnTrackIncludesAnchorAndLaterClipsOnlyOnAnchorTrack", () => {
    const t = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({
          clips: [
            fixtureClip({ id: "before", start: 0, duration: 20 }),
            fixtureClip({ id: "anchor", start: 30, duration: 20 }),
            fixtureClip({ id: "after", start: 70, duration: 20 }),
          ],
        }),
        fixtureAudioTrack({ clips: [fixtureClip({ id: "other", mediaType: "audio", start: 40, duration: 20 })] }),
      ],
    });

    expect(selectForwardIds(t, "anchor", "track")).toEqual(new Set(["anchor", "after"]));
  });

  it("selectForwardOnAllTracksUsesAnchorFrameAcrossTimeline", () => {
    const t = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({
          clips: [fixtureClip({ id: "before", start: 0, duration: 20 }), fixtureClip({ id: "anchor", start: 30, duration: 20 })],
        }),
        fixtureAudioTrack({
          clips: [
            fixtureClip({ id: "sameFrame", mediaType: "audio", start: 30, duration: 20 }),
            fixtureClip({ id: "after", mediaType: "audio", start: 90, duration: 20 }),
          ],
        }),
      ],
    });

    expect(selectForwardIds(t, "anchor", "allTracks")).toEqual(new Set(["anchor", "sameFrame", "after"]));
  });

  it("selectForwardExpandsLinkedPartners", () => {
    const anchor = fixtureClip({ id: "anchor", start: 30, duration: 20 });
    anchor.linkGroupId = "g1";
    const linkedAudio = fixtureClip({ id: "linkedAudio", mediaType: "audio", start: 10, duration: 20 });
    linkedAudio.linkGroupId = "g1";
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [anchor] }), fixtureAudioTrack({ clips: [linkedAudio] })] });

    expect(selectForwardIds(t, "anchor", "track")).toEqual(new Set(["anchor", "linkedAudio"]));
  });

  it("currentSelectionUsesEarliestSelectedClipAsAnchor", () => {
    const t = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({
          clips: [
            fixtureClip({ id: "first", start: 20, duration: 20 }),
            fixtureClip({ id: "second", start: 60, duration: 20 }),
            fixtureClip({ id: "third", start: 100, duration: 20 }),
          ],
        }),
      ],
    });

    expect(selectForwardFromCurrentSelection(t, new Set(["second", "third"]), "track")).toEqual(new Set(["second", "third"]));
  });
});

describe("EditorViewModel - track selection", () => {
  it("selectsEveryClipOnTargetTrackOnly", () => {
    const t = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({
          id: "target",
          clips: [
            fixtureClip({ id: "video", mediaType: "video", start: 0, duration: 30 }),
            fixtureClip({ id: "title", mediaType: "text", start: 30, duration: 30 }),
          ],
        }),
        fixtureAudioTrack({ id: "other", clips: [fixtureClip({ id: "audio", mediaType: "audio", start: 0, duration: 60 })] }),
      ],
    });

    expect(trackClipIds(t, "target")).toEqual(new Set(["video", "title"]));
  });

  it("unavailableTrackPreservesSelection", () => {
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack({ id: "empty" })] });

    expect(trackClipIds(t, "empty")).toBeNull();
    expect(trackClipIds(t, "missing")).toBeNull();
  });
});

describe("EditorViewModel - track display label", () => {
  it("labelsVisualTracksTopToBottomThenAudio", () => {
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack(), fixtureVideoTrack(), fixtureAudioTrack()] });
    expect(timelineTrackDisplayLabel(t, 0)).toBe("V2");
    expect(timelineTrackDisplayLabel(t, 1)).toBe("V1");
    expect(timelineTrackDisplayLabel(t, 2)).toBe("A1");
  });

  it("outOfRangeIndexReturnsEmpty", () => {
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack()] });
    expect(timelineTrackDisplayLabel(t, 5)).toBe("");
  });

  it("visualTrackAfterAudioDoesNotTrap", () => {
    // Invariant-violating order (visual below audio) must not crash on the empty range.
    const text = fixtureVideoTrack();
    text.type = "text";
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack(), fixtureAudioTrack(), text] });
    expect(timelineTrackDisplayLabel(t, 2)).toBe("T1");
  });
});

describe("Timeline keyframe lanes - editor queries", () => {
  it("targetUsesEligibleClipUnderPlayheadAndReturnsNilForGaps", () => {
    const t = fixtureTimeline({
      tracks: [
        fixtureVideoTrack({
          id: "visual",
          clips: [
            fixtureClip({ id: "text", mediaType: "text", start: 0, duration: 20 }),
            fixtureClip({ id: "video", mediaType: "video", start: 30, duration: 20 }),
          ],
        }),
      ],
    });

    expect(keyframeLaneTarget(t, "visual", "opacity", 10)?.id).toBe("text");
    expect(keyframeLaneTarget(t, "visual", "scale", 10)?.id).toBe("text");
    expect(keyframeLaneTarget(t, "visual", "opacity", 25)).toBeUndefined();
    expect(keyframeLaneTarget(t, "visual", "crop", 10)).toBeUndefined();
    expect(keyframeLaneTarget(t, "visual", "crop", 35)?.id).toBe("video");
  });

  it("navigationCrossesClipBoundariesOnThePropertyLane", () => {
    const first = fixtureClip({ id: "first", start: 0, duration: 20 });
    first.opacityTrack = makeKeyframeTrack([makeKeyframe(5, 0.5)]);
    const second = fixtureClip({ id: "second", start: 30, duration: 20 });
    second.opacityTrack = makeKeyframeTrack([makeKeyframe(10, 0.8)]);
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack({ id: "visual", clips: [first, second] })] });

    let navigation = keyframeLaneNavigationTargets(t, "visual", "opacity", 25);
    expect(navigation.previous).toEqual({ clipId: "first", frame: 5 });
    expect(navigation.next).toEqual({ clipId: "second", frame: 40 });

    clipUpsertKeyframe(second, "opacityTrack", 35, 0.7);
    navigation = keyframeLaneNavigationTargets(t, "visual", "opacity", 25);
    expect(navigation.next).toEqual({ clipId: "second", frame: 35 });
  });

  it("laneHitResolvesClipAndAbsoluteFrame", () => {
    const clip: Clip = fixtureClip({ id: "clip", start: 10, duration: 30 });
    clip.opacityTrack = makeKeyframeTrack([makeKeyframe(5, 0.5)]);
    const t = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [clip] })] });
    const geometry = makeTimelineGeometry({
      pixelsPerFrame: 2,
      trackHeights: t.tracks.map((tr) => tr.displayHeight),
      laneProperties: [["opacity"]],
      bounds: { x: 0, y: 0, width: 500, height: 200 },
    });
    const lane = laneRect(geometry, 0, "opacity");
    expect(lane).toBeDefined();
    if (!lane) return;
    const point = { x: xForFrame(geometry, 15), y: lane.y + lane.height / 2 };

    const hit = keyframeLaneHit(t, new Set(), point, 0, "opacity", geometry);

    expect(hit?.clipId).toBe("clip");
    expect(hit?.frame).toBe(15);
  });
});
