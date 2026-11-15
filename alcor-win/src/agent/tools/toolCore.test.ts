import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { agentActivity, clearAgentActivity } from "../../editor/mutations/agentActivity";
import { layoutPlacement } from "../../editor/mutations/layout";
import { swapClipMedia } from "../../editor/mutations/mediaSwap";
import { canvasAspectDisplayLabel, canvasAspectRatioResolution, parseCanvasAspectRatio } from "../../editor/mutations/projectSettings";
import { nestBlockReason } from "../../editor/mutations/core";
import { clampInt, safeInt, argInt } from "./toolArgs";
import { shortIdMap } from "./toolExecutorShortId";
import { publishAgentChanges, timelineReadActivity } from "./toolExecutorAgentActivity";
import { registeredTool } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

const uuid = (first8: string): string => `${first8}-0000-0000-0000-000000000000`;

describe("short id round-trip", () => {
  const harness = (...ids: string[]) =>
    new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: ids.map((id, i) => Fixtures.clip({ id, start: i * 200, duration: 100 })) })] }));

  it("emitsShortPrefixForFullUuid", async () => {
    const id = uuid("ABCD1234");
    const text = ToolHarness.textOf(await harness(id).runRaw("get_timeline"));
    expect(text).toContain("ABCD1234");
    expect(text).not.toContain(id);
  });

  it("acceptsPrefixBackAsArgument", async () => {
    const h = harness(uuid("ABCD1234"));
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "ABCD1234", ranges: [[40, 50]] });
    expect(result.isError).toBe(false);
    expect(h.editor.timeline.tracks[0].clips.length).toBe(2);
  });

  it("fullUuidStillResolves", async () => {
    const id = uuid("ABCD1234");
    expect((await harness(id).runRaw("ripple_delete_ranges", { clipId: id, ranges: [[40, 50]] })).isError).toBe(false);
  });

  it("ambiguousPrefixIsRejected", async () => {
    const h = harness(uuid("ABCD1234"), "ABCD1234-FFFF-0000-0000-000000000000");
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "ABCD1234", ranges: [[40, 50]] });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result).toLowerCase()).toContain("ambiguous");
  });

  it("prefixExtendsPastSharedRun", () => {
    const a = uuid("ABCD1234");
    const b = "ABCD1234-FFFF-0000-0000-000000000000";
    const map = shortIdMap(new Set([a, b]));
    expect(map.get(a)).not.toBe(map.get(b));
    expect((map.get(a) ?? "").length).toBeGreaterThan(8);
  });

  it("unsharedIdGetsFloorLength", () => {
    const id = uuid("ABCD1234");
    expect(shortIdMap(new Set([id, uuid("EEEE9999")])).get(id)).toBe("ABCD1234");
  });
});

describe("Tool arg numeric overflow: no traps", () => {
  it("safeIntRejectsOverflowAndNonFinite", () => {
    for (const v of [1e19, -1e19, 1e300, NaN, Infinity, -Infinity]) expect(safeInt(v)).toBeUndefined();
    expect(safeInt(3.0)).toBe(3);
    expect(safeInt(3.9)).toBe(3);
    expect(safeInt(-3.9)).toBe(-3);
    expect(safeInt(0)).toBe(0);
  });

  it("clampIntNeverOverflows", () => {
    expect(clampInt(1e300, 0, 100)).toBe(100);
    expect(clampInt(-1e300, 0, 100)).toBe(0);
    expect(clampInt(NaN, 5, 100)).toBe(5);
    expect(clampInt(Infinity, 0, 100)).toBe(100);
    expect(clampInt(42.4, 0, 100)).toBe(42);
  });

  it("dictIntDoesNotTrapOnHugeJSONNumber", () => {
    const args = JSON.parse('{"startFrame": 1e19}') as Record<string, unknown>;
    expect(argInt(args, "startFrame")).toBeUndefined();
  });

  const one = () => new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "C1", start: 0, duration: 100 })] })] }));

  it("getTimelineSurvivesHugeStartFrame", async () => {
    const result = await one().runRaw("get_timeline", { startFrame: 1e19 });
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("rippleDeleteSurvivesHugeRange", async () => {
    const result = await one().runRaw("ripple_delete_ranges", { trackIndex: 0, units: "frames", ranges: [[0.0, 1e300]] });
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("setKeyframesRejectsOverflowFrame", async () => {
    const result = await one().runRaw("set_keyframes", { clipId: "C1", property: "opacity", keyframes: [[1e19, 0.5]] });
    expect(result.isError).toBe(true);
  });
});

describe("undo tool", () => {
  const harness = () => new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));

  it("undoRevertsOnlyTheMostRecentToolCall", async () => {
    const h = harness();
    await h.runRaw("split_clips", { trackIndex: 0, frames: [30] });
    expect(h.editor.timeline.tracks[0].clips.length).toBe(2);
    await h.runRaw("ripple_delete_ranges", { trackIndex: 0, ranges: [[40, 50]] });
    const result = await h.runRaw("undo");
    expect(result.isError).toBe(false);
    expect(h.editor.timeline.tracks[0].clips.map((c) => c.durationFrames)).toEqual([30, 70]);
  });

  it("addFirstImportedClipIncludesSettingsInAgentTransaction", async () => {
    const h = new ToolHarness();
    const original = h.editor.timeline;
    const asset = h.addAsset({ type: "video" });
    h.editor.withoutRegistration(() => {
      const a = h.editor.mediaAsset(asset.id);
      if (a) Object.assign(a, { sourceWidth: 1280, sourceHeight: 720 });
    });
    h.editor.store.reset(h.editor.store.committed);
    const result = await h.runRaw("add_clips", { entries: [{ mediaRef: asset.id, startFrame: 0, endFrame: 30 }] });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.timeline.width).toBe(1280);
    expect(h.editor.timeline.height).toBe(720);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.timeline).toEqual(original);
  });

  it("nothingToUndoIsAnError", async () => {
    const result = await new ToolHarness().runRaw("undo");
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toBe("Nothing to undo.");
  });

  it("noOpToolCallCreatesNoUndoEntry", async () => {
    const h = harness();
    await h.runOK("set_clip_properties", { clipIds: ["c1"], opacity: 1.0 });
    expect(h.editor.store.undoActionName).toBeNull();
  });
});

describe("Agent activity highlights", () => {
  it("classifierSeparatesAddedAndMutatedClips", () => {
    const mutated = Fixtures.clip({ id: "mutated", start: 0, duration: 10 });
    const removed = Fixtures.clip({ id: "removed", start: 20, duration: 10 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [mutated, removed] })] }));
    const before = h.editor.timeline;
    h.editor.perform("edit", () => {
      const clips = h.editor.timeline.tracks[0].clips;
      clips[0].startFrame = 5;
      clips.splice(1, 1);
      clips.push(Fixtures.clip({ id: "added", start: 30, duration: 10 }));
    });
    publishAgentChanges(before, h.editor.timeline, h.editor);
    expect([...agentActivity(h.editor)().addedClipIds]).toEqual(["added"]);
    expect([...agentActivity(h.editor)().mutatedClipIds]).toEqual(["mutated"]);
    clearAgentActivity(h.editor);
  });

  it("executorHighlightsOnlyActualPropertyChanges", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "clip", start: 0, duration: 30 })] })] }));
    await h.runOK("set_clip_properties", { clipIds: ["clip"], opacity: 1.0 });
    expect(agentActivity(h.editor)().mutatedClipIds.size).toBe(0);
    await h.runOK("set_clip_properties", { clipIds: ["clip"], opacity: 0.5 });
    expect([...agentActivity(h.editor)().mutatedClipIds]).toEqual(["clip"]);
    clearAgentActivity(h.editor);
  });

  it("onlyMutationToolsPublishTimelineChanges", () => {
    for (const name of ["inspect_timeline", "organize_media"]) expect(registeredTool(name)?.publishesTimelineChanges).not.toBe(true);
    for (const name of ["manage_tracks", "set_clip_properties", "copy_clip_settings"]) expect(registeredTool(name)?.publishesTimelineChanges).toBe(true);
  });

  it("mapsOnlyVisibleTimelineReads", () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "clip", start: 0, duration: 100 })] })] }));
    expect(timelineReadActivity("get_timeline", { startFrame: 10, endFrame: 5000 }, h.editor)?.range).toEqual({ start: 10, end: 100 });
    expect(timelineReadActivity("inspect_media", { clipId: "clip" }, h.editor)?.readClipIds.has("clip")).toBe(true);
    expect(timelineReadActivity("inspect_media", { clipId: "missing" }, h.editor)).toBeUndefined();
    expect(timelineReadActivity("add_clips", {}, h.editor)).toBeUndefined();
  });
});

describe("agent editor operations", () => {
  it("canvas aspect ratio parsing and resolution", () => {
    expect(canvasAspectRatioResolution(parseCanvasAspectRatio("16:9"), 1080)).toEqual({ width: 1920, height: 1080 });
    expect(canvasAspectRatioResolution(parseCanvasAspectRatio("9:16"), 1080)).toEqual({ width: 1080, height: 1920 });
    expect(() => parseCanvasAspectRatio("0:1")).toThrow();
    expect(() => parseCanvasAspectRatio("a:b")).toThrow();
    expect(canvasAspectDisplayLabel(1920, 1080)).toBe("16:9");
  });

  it("layoutPlacement fits a slot", () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c", start: 0, duration: 30 })] })] }));
    const clip = h.editor.clipFor("c");
    if (!clip) throw new Error("clip");
    const p = layoutPlacement(h.editor, clip, { x: 0, y: 0, w: 0.5, h: 1 }, "fill");
    expect(p.transform.width).toBeCloseTo(0.5);
    expect(p.transform.height).toBeCloseTo(1);
  });

  it("swapClipMedia validates type and keeps one undo step", () => {
    const clip = Fixtures.clip({ id: "c", mediaRef: "old", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    const asset = h.addAsset({ id: "new", type: "video", duration: 5 });
    const plan = swapClipMedia(h.editor, "c", asset);
    expect(plan.changed).toBe(true);
    expect(h.editor.clipFor("c")?.mediaRef).toBe("new");
    expect(() => swapClipMedia(h.editor, "c", h.addAsset({ id: "img", type: "image" }))).toThrow();
  });

  it("nestBlockReason refuses empty timelines", () => {
    const h = new ToolHarness();
    expect(nestBlockReason(h.editor, h.editor.doc.activeTimelineId)).toContain("is empty");
  });
});

describe("timeline tools", () => {
  it("createTimelineAndSetActiveRoundTrip", async () => {
    const h = new ToolHarness();
    const created = await h.runOK("create_timeline", { name: "Alt" });
    expect(created.name).toBe("Alt");
    expect(h.editor.timelines.length).toBe(2);
    const first = h.editor.timelines[0].id;
    const active = await h.runOK("set_active_timeline", { timelineId: first });
    expect(active.note).toContain("Re-read get_timeline");
    expect((await h.runOK("set_active_timeline", { timelineId: first })).note).toBe("Already the active timeline.");
    expect((await h.runRaw("set_active_timeline", { timelineId: "nope" })).isError).toBe(true);
  });

  it("manageMarkersCreateUpdateDelete", async () => {
    const h = new ToolHarness();
    const made = await h.runOK("manage_markers", { action: "create", name: "Fix", startFrame: 10, durationFrames: 5 });
    const id = (made.created as Record<string, unknown>).markerId as string;
    expect(((await h.runOK("manage_markers", { action: "update", markerId: id, status: "review" })).updated as Record<string, unknown>).status).toBe("review");
    expect((await h.runOK("manage_markers", { action: "delete", markerId: id })).deletedMarkerId).toBe(id);
    expect((await h.runRaw("manage_markers", { action: "delete", markerId: id })).isError).toBe(true);
  });

  it("setProjectSettingsReturnsChangedFieldsAsJSON", async () => {
    const h = new ToolHarness();
    const json = await h.runOK("set_project_settings", { fps: 24, aspectRatio: "9:16", quality: "720p" });
    expect(json.changed).toEqual(["fps", "resolution"]);
    expect(json.resolution).toBe("720x1280");
  });

  it("inspectTimelineNeedsRenderer", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 30 })] })] }));
    expect(ToolHarness.textOf(await h.runRaw("inspect_timeline"))).toBe("Failed to render timeline frames.");
  });
});
