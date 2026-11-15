import { describe, expect, it } from "vitest";
import {
  decodeTimelineMarker, makeTimelineMarker, timelineMarkerIntersects, timelineMarkerRescaleFrames,
} from "./timelineMarker";
import { decodeTimeline, timelineDisplayFrames, timelineTotalFrames } from "./timeline";
import { decodeProjectFile, makeProjectFile } from "./projectFile";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack, roundTrip } from "./fixtures";

describe("Timeline markers", () => {
  it("markersPersistWithoutChangingContentDuration", () => {
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 30 })] })] });
    timeline.markers = [
      makeTimelineMarker({
        name: "Review", startFrame: 40, durationFrames: 10, color: { r: 1, g: 0, b: 0, a: 1 }, comment: "Tighten", status: "review",
      }),
    ];
    const file = makeProjectFile({ timelines: [timeline] });
    const decoded = roundTrip(file, decodeProjectFile);
    expect(decoded.timelines[0]?.markers).toEqual(timeline.markers);
    expect(timelineTotalFrames(decoded.timelines[0] as typeof timeline)).toBe(30);
    expect(timelineDisplayFrames(decoded.timelines[0] as typeof timeline)).toBe(50);
    const object = JSON.parse(JSON.stringify(timeline)) as Record<string, unknown>;
    delete object["markers"];
    expect(decodeTimeline(object).markers).toEqual([]);
  });

  it("markersWithoutStatusDecodeAsOpen", () => {
    const timeline = fixtureTimeline();
    timeline.markers = [makeTimelineMarker({ name: "Existing marker", startFrame: 12, status: "review" })];
    const object = JSON.parse(JSON.stringify(timeline)) as { markers: Record<string, unknown>[] };
    delete object.markers[0]?.["status"];
    const decoded = decodeTimeline(object);
    expect(decoded.markers.length).toBe(1);
    expect(decoded.markers[0]?.status).toBe("open");
  });

  it("a marker missing a required key fails to decode, so the timeline falls back to no markers", () => {
    expect(() => decodeTimelineMarker({ id: "x", name: "n", startFrame: 1 })).toThrow();
  });

  it("range intersection is half-open for point markers", () => {
    const point = makeTimelineMarker({ name: "p", startFrame: 10 });
    expect(timelineMarkerIntersects(point, 10, 20)).toBe(true);
    expect(timelineMarkerIntersects(point, 0, 10)).toBe(false);
    const range = makeTimelineMarker({ name: "r", startFrame: 10, durationFrames: 5 });
    expect(timelineMarkerIntersects(range, 14, 30)).toBe(true);
    expect(timelineMarkerIntersects(range, 15, 30)).toBe(false);
  });

  it("rescaleFrames keeps ranges at least one frame", () => {
    const m = makeTimelineMarker({ name: "r", startFrame: 10, durationFrames: 1 });
    timelineMarkerRescaleFrames(m, 0.1);
    expect(m.startFrame).toBe(1);
    expect(m.durationFrames).toBe(1);
  });
});
