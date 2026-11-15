import { describe, expect, it } from "vitest";
import { makeTimelineMarker } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

describe("MCP timeline markers", () => {
  it("discoversCreatesReadsUpdatesAndUndoesMarker", async () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 100 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    expect(mcpServerTools().some((r) => r.definition.name === "manage_markers")).toBe(true);

    const create = await h.runOK("manage_markers", {
      action: "create",
      name: "Timeline note",
      startFrame: 20,
      durationFrames: 10,
      color: "#FF9500",
      comment: "Move subject left",
    });
    const markerId = (create.created as Json).markerId as string;
    expect(typeof markerId).toBe("string");
    const timeline = await h.runOK("get_timeline", { startFrame: 15, endFrame: 25 });
    const markers = timeline.markers as Json[];
    const marker = markers[0];
    expect(marker.name).toBe("Timeline note");
    expect(marker.endFrame).toBe(30);
    expect(marker.color).toBe("#FF9500FF");
    expect(marker.status).toBe("open");

    await h.runOK("manage_markers", {
      action: "update",
      markerId,
      startFrame: 40,
      color: "#34C759",
      comment: "Addressed",
      status: "review",
    });
    expect(h.editor.timeline.markers[0]?.startFrame).toBe(40);
    expect(h.editor.timeline.markers[0]?.comment).toBe("Addressed");
    expect(h.editor.timeline.markers[0]?.status).toBe("review");
    expect((await h.runRaw("manage_markers", { action: "update", markerId, status: "done" })).isError).toBe(true);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.timeline.markers[0]?.startFrame).toBe(20);
    expect(h.editor.timeline.markers[0]?.status).toBe("open");
  });

  it("rippleDeleteShiftsMarkersThroughMCP", async () => {
    const h = new ToolHarness(
      Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "clip", start: 0, duration: 100 })] })] }),
    );
    h.editor.ui.rippleTimelineMarkers = true;
    h.editor.withoutRegistration(() => {
      h.editor.timeline.markers = [
        makeTimelineMarker({ id: "inside", name: "Inside", startFrame: 45 }),
        makeTimelineMarker({ id: "after", name: "After", startFrame: 80 }),
      ];
    });
    const ripple = await h.runOK("ripple_delete_ranges", { trackIndex: 0, ranges: [[40, 50]] });
    expect(ripple.removedMarkerIds).toEqual(["inside"]);
    const markers = ripple.markers as Json[];
    expect(markers[0].markerId).toBe("after");
    expect(markers[0].startFrame).toBe(70);
    const timeline = await h.runOK("get_timeline", {});
    const readBack = (timeline.markers as Json[])[0];
    expect(readBack.startFrame).toBe(70);
  });
});
