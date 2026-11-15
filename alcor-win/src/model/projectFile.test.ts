import { describe, expect, it } from "vitest";
import { decodeProjectFile, decodeProjectFileText, makeProjectFile } from "./projectFile";
import { makeTimelineViewState } from "./timeline";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "./fixtures";

const via = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("Multi-timeline — persistence", () => {
  it("legacyBareTimelineDecodesAndWraps", () => {
    const legacy = fixtureTimeline({ fps: 24, tracks: [fixtureVideoTrack({ clips: [fixtureClip({ start: 0, duration: 10 })] })] });
    const file = decodeProjectFile(via(legacy));
    expect(file.timelines.length).toBe(1);
    expect(file.timelines[0]?.fps).toBe(24);
    expect(file.activeTimelineId).toBe(file.timelines[0]?.id);
    expect(file.openTimelineIds).toEqual([file.timelines[0]?.id]);
  });

  it("projectFileRoundTripsViewStateAndTabs", () => {
    const a = fixtureTimeline();
    a.name = "Main";
    a.tracks = [fixtureVideoTrack()];
    (a.tracks[0] as { displayHeight: number }).displayHeight = 88;
    const b = fixtureTimeline();
    b.name = "Vertical";
    const vs = makeTimelineViewState({ playheadFrame: 42, zoomScale: 7, scrollOffsetX: 300 });
    const file = makeProjectFile({
      timelines: [a, b], activeTimelineId: b.id, openTimelineIds: [a.id, b.id], viewStates: { [a.id]: vs },
    });
    const decoded = decodeProjectFile(via(file));
    expect(decoded.timelines.map((t) => t.name)).toEqual(["Main", "Vertical"]);
    expect(decoded.activeTimelineId).toBe(b.id);
    expect(decoded.openTimelineIds).toEqual([a.id, b.id]);
    expect(decoded.viewStates?.[a.id]).toEqual(vs);
    expect(decoded.timelines[0]?.tracks[0]?.displayHeight).toBe(88);
  });

  it("legacyTimelineWithoutIdGetsOne", () => {
    const file = decodeProjectFileText('{"fps": 30, "width": 1920, "height": 1080, "settingsConfigured": true, "tracks": []}');
    expect((file.timelines[0]?.id ?? "").length).toBeGreaterThan(0);
    expect(file.timelines[0]?.name).toBe("Timeline 1");
    expect(file.timelines[0]?.settingsConfigured).toBe(true);
  });

  it("timelineFolderIdPersists", () => {
    const t = fixtureTimeline();
    t.folderId = "f1";
    const file = makeProjectFile({ timelines: [t], activeTimelineId: t.id, openTimelineIds: [t.id] });
    expect(decodeProjectFile(via(file)).timelines[0]?.folderId).toBe("f1");
  });

  it("a project with no timelines and no legacy shape is rejected", () => {
    expect(() => decodeProjectFile({ timelines: [] })).toThrow();
    expect(() => decodeProjectFile("nope")).toThrow();
  });
});
