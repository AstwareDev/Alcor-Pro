import { describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import "./maskGroup";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function harness() {
  const clip = Fixtures.clip({ id: "clip", start: 0, duration: 100 });
  const audio = Fixtures.clip({ id: "aud", mediaType: "audio", start: 0, duration: 100 });
  const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] }), Fixtures.audioTrack({ clips: [audio] })] }));
  return { h, clip };
}

const masksOf = (h: ToolHarness) => h.editor.clipFor("clip")?.masks ?? [];

describe("MCP masks", () => {
  it("advertises the three mask tools", () => {
    const names = mcpServerTools().map((r) => r.definition.name);
    expect(names).toEqual(expect.arrayContaining(["add_mask", "update_mask", "remove_mask"]));
  });

  it("adds rectangle, ellipse and path masks, each undoable", async () => {
    const { h } = harness();
    const rect = await h.runOK("add_mask", { clipId: "clip", shape: "rectangle", rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, feather: 12, inverted: true, mode: "subtract" });
    expect(((rect.masks as Json[])[0]).shape).toBe("rectangle");
    const m = masksOf(h)[0];
    expect(m?.path.vertices[0]).toMatchObject({ x: 0.1, y: 0.2 });
    expect(m?.path.vertices[2]?.x).toBeCloseTo(0.6);
    expect(m?.path.vertices[2]?.y).toBeCloseTo(0.6);
    expect(m).toMatchObject({ feather: 12, inverted: true, mode: "subtract" });
    await h.runOK("add_mask", { clipId: "clip", shape: "ellipse" });
    await h.runOK("add_mask", { clipId: "clip", shape: "path", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1, outX: 0.1 }] });
    expect(masksOf(h).map((x) => x.shape)).toEqual(["rectangle", "ellipse", "path"]);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(masksOf(h)).toHaveLength(2);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(masksOf(h)).toHaveLength(0);
  });

  it("validates input and refuses audio clips", async () => {
    const { h } = harness();
    expect((await h.runRaw("add_mask", { clipId: "aud", shape: "ellipse" })).isError).toBe(true);
    expect((await h.runRaw("add_mask", { clipId: "clip", shape: "path" })).isError).toBe(true);
    expect((await h.runRaw("add_mask", { clipId: "clip", shape: "path", points: [{ x: 0, y: 0 }] })).isError).toBe(true);
    expect((await h.runRaw("add_mask", { clipId: "clip", shape: "star" })).isError).toBe(true);
    expect((await h.runRaw("add_mask", { clipId: "clip", shape: "ellipse", feather: -1 })).isError).toBe(true);
    expect((await h.runRaw("add_mask", { clipId: "clip", shape: "ellipse", bogus: 1 })).isError).toBe(true);
    expect((await h.runRaw("update_mask", { clipId: "clip", maskId: "nope", feather: 1 })).isError).toBe(true);
    expect(masksOf(h)).toHaveLength(0);
    expect(h.editor.store.canUndo).toBe(false);
  });

  it("updates fields, reorders and animates in one undo step", async () => {
    const { h } = harness();
    await h.runOK("add_mask", { clipId: "clip", shape: "rectangle" });
    const second = await h.runOK("add_mask", { clipId: "clip", shape: "ellipse" });
    const id = second.maskId as string;
    await h.runOK("update_mask", {
      clipId: "clip", maskId: id, name: "Sky", mode: "intersect", opacity: 0.5, order: 0,
      keyframes: [{ property: "feather", frame: 10, value: 0 }, { property: "feather", frame: 60, value: 40, interpolation: "linear" }],
    });
    const m = masksOf(h)[0];
    expect(m).toMatchObject({ id, name: "Sky", mode: "intersect", opacity: 0.5 });
    expect(m?.featherTrack?.keyframes.map((k) => [k.frame, k.value, k.interpolationOut])).toEqual([[10, 0, "smooth"], [60, 40, "linear"]]);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(masksOf(h)[1]?.id).toBe(id);
    expect(masksOf(h)[1]?.name).not.toBe("Sky");
    expect(masksOf(h)[1]?.featherTrack).toBeUndefined();
  });

  it("refuses static writes to keyframed properties and out-of-clip frames", async () => {
    const { h } = harness();
    const id = (await h.runOK("add_mask", { clipId: "clip", shape: "ellipse" })).maskId as string;
    await h.runOK("update_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "opacity", frame: 0, value: 1 }, { property: "opacity", frame: 50, value: 0 }] });
    expect((await h.runRaw("update_mask", { clipId: "clip", maskId: id, opacity: 0.2 })).isError).toBe(true);
    expect((await h.runRaw("update_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "feather", frame: 500, value: 1 }] })).isError).toBe(true);
    expect((await h.runRaw("update_mask", { clipId: "clip", maskId: id })).isError).toBe(true);
  });

  it("path keyframes and removal of keyframes then the mask", async () => {
    const { h } = harness();
    const id = (await h.runOK("add_mask", { clipId: "clip", shape: "rectangle" })).maskId as string;
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    await h.runOK("update_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "path", frame: 0, points: pts }, { property: "path", frame: 30, points: pts.map((p) => ({ ...p, x: p.x * 0.5 })) }] });
    expect(masksOf(h)[0]?.pathTrack?.keyframes).toHaveLength(2);
    await h.runOK("remove_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "path", frame: 30 }] });
    expect(masksOf(h)[0]?.pathTrack?.keyframes).toHaveLength(1);
    expect((await h.runRaw("remove_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "path", frame: 99 }] })).isError).toBe(true);
    await h.runOK("remove_mask", { clipId: "clip", maskId: id, keyframes: [{ property: "path" }] });
    expect(masksOf(h)[0]?.pathTrack).toBeUndefined();
    await h.runOK("remove_mask", { clipId: "clip", maskId: id });
    expect(masksOf(h)).toHaveLength(0);
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(masksOf(h)).toHaveLength(1);
  });

  it("get_timeline exposes masks", async () => {
    const { h } = harness();
    await h.runOK("add_mask", { clipId: "clip", shape: "ellipse", name: "Vignette" });
    expect(JSON.stringify(await h.runOK("get_timeline"))).toContain("Vignette");
  });
});
