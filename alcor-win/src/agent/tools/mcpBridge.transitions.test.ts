import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import "./transitionGroup";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

function harness() {
  const track = Fixtures.videoTrack({
    clips: [Fixtures.clip({ id: "a", start: 0, duration: 60 }), Fixtures.clip({ id: "b", start: 60, duration: 60 })],
  });
  return new ToolHarness(Fixtures.timeline({ tracks: [track, Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "far", start: 200, duration: 30 })] })] }));
}

const transitions = (h: ToolHarness) => h.editor.timeline.tracks[0]?.transitions ?? [];

describe("MCP transitions and adjustment layers", () => {
  it("advertises the four tools", () => {
    const names = mcpServerTools().map((r) => r.definition.name);
    expect(names).toEqual(expect.arrayContaining(["add_transition", "update_transition", "remove_transition", "add_adjustment_layer"]));
  });

  it("adds, updates and removes a transition, each undoable", async () => {
    const h = harness();
    const added = await h.runOK("add_transition", { clipId: "a" });
    expect(added).toMatchObject({ kind: "crossDissolve", durationFrames: 15, alignment: "center", fromClipId: "a", toClipId: "b" });
    const id = added.transitionId as string;
    const updated = await h.runOK("update_transition", { transitionId: id, kind: "wipeLeft", durationSeconds: 1 });
    expect(updated).toMatchObject({ kind: "wipeLeft", durationFrames: 30 });
    await h.runOK("update_transition", { clipId: "a", alignment: "start" });
    expect(transitions(h)[0]?.alignment).toBe("start");
    await h.runOK("remove_transition", { clipId: "a" });
    expect(transitions(h)).toHaveLength(0);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(transitions(h)).toHaveLength(1);
  });

  it("validates input", async () => {
    const h = harness();
    expect((await h.runRaw("add_transition", { clipId: "far" })).isError).toBe(true);
    expect((await h.runRaw("add_transition", { clipId: "a", kind: "star" })).isError).toBe(true);
    expect((await h.runRaw("add_transition", { clipId: "a", durationSeconds: -1 })).isError).toBe(true);
    expect((await h.runRaw("add_transition", { clipId: "a", bogus: 1 })).isError).toBe(true);
    expect((await h.runRaw("update_transition", { clipId: "a", kind: "wipeLeft" })).isError).toBe(true);
    expect((await h.runRaw("remove_transition", {})).isError).toBe(true);
    await h.runOK("add_transition", { clipId: "a" });
    expect((await h.runRaw("add_transition", { clipId: "a" })).isError).toBe(true);
    expect((await h.runRaw("update_transition", { clipId: "a" })).isError).toBe(true);
    expect(transitions(h)).toHaveLength(1);
  });

  it("adds an adjustment layer on a new top track, or on a free track", async () => {
    const h = harness();
    const r = await h.runOK("add_adjustment_layer", { startFrame: 10, durationSeconds: 2 });
    const clip = h.editor.timeline.tracks[0]?.clips[0];
    expect(clip?.id.startsWith(r.clipId as string)).toBe(true);
    expect(clip).toMatchObject({ adjustment: true, startFrame: 10, durationFrames: 60, mediaType: "text" });
    expect(h.editor.timeline.tracks).toHaveLength(3);
    const onTrack = await h.runOK("add_adjustment_layer", { trackIndex: 2, startFrame: 0, durationFrames: 30 });
    expect(h.editor.timeline.tracks[2]?.clips.some((c) => c.id.startsWith(onTrack.clipId as string))).toBe(true);
    expect((await h.runRaw("add_adjustment_layer", { trackIndex: 2, startFrame: 10, durationFrames: 30 })).isError).toBe(true);
    expect((await h.runRaw("add_adjustment_layer", { startFrame: -1 })).isError).toBe(true);
  });
});
