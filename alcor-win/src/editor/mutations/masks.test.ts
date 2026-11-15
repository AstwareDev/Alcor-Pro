import { describe, expect, it } from "vitest";
import { decodeClip, makeEllipsePath, makeMaskPath, makeMaskVertex, maskPathAt, splitValues } from "../../model";
import { copySelectedClipsToClipboard, pasteClips } from "./clipboard";
import { splitClip } from "./clipMutations";
import {
  addMask, applyMask, cancelMask, commitMask, duplicateMask, removeMask, removeMaskKeyframe, renameMask, reorderMask,
  resetMaskProperty, setMaskKeyframe, updateMask,
} from "./masks";
import { Fixtures, clipById, makeEditor } from "./testFixtures";

function setupEditor() {
  const clip = Fixtures.clip({ id: "c", start: 0, duration: 100 });
  return makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
}

describe("masks", () => {
  it("adds rectangle, ellipse and pen masks as one undo entry each", () => {
    const e = setupEditor();
    const a = addMask(e, "c", "rectangle");
    const b = addMask(e, "c", "ellipse");
    const pen = makeMaskPath([makeMaskVertex(0.1, 0.1), makeMaskVertex(0.9, 0.1), makeMaskVertex(0.5, 0.9)]);
    const c = addMask(e, "c", "path", { path: pen });
    const masks = clipById(e, "c").masks ?? [];
    expect(masks.map((m) => m.shape)).toEqual(["rectangle", "ellipse", "path"]);
    expect(masks[0]?.path.vertices).toHaveLength(4);
    expect(masks[2]?.path.vertices).toHaveLength(3);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(e.ui.selectedMaskId).toBe(c);
    e.undo();
    expect(clipById(e, "c").masks).toHaveLength(2);
    e.undo();
    e.undo();
    expect(clipById(e, "c").masks).toBeUndefined();
  });

  it("refuses audio clips", () => {
    const clip = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 10 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
    expect(addMask(e, "a", "rectangle")).toBeUndefined();
    expect(e.store.canUndo).toBe(false);
  });

  it("updates fields with clamping in one undo entry", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "ellipse") as string;
    updateMask(e, "c", id, { mode: "subtract", inverted: true, feather: -5, opacity: 3, expansion: 12 });
    expect(clipById(e, "c").masks?.[0]).toMatchObject({ mode: "subtract", inverted: true, feather: 0, opacity: 1, expansion: 12 });
    e.undo();
    expect(clipById(e, "c").masks?.[0]).toMatchObject({ mode: "add", inverted: false, expansion: 0 });
  });

  it("a live gesture records a single undo entry and cancel restores", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "rectangle") as string;
    applyMask(e, "c", id, { feather: 5 });
    applyMask(e, "c", id, { feather: 10 });
    expect(clipById(e, "c").masks?.[0]?.feather).toBe(10);
    cancelMask(e, "c");
    expect(clipById(e, "c").masks?.[0]?.feather).toBe(0);
    applyMask(e, "c", id, { feather: 7 });
    commitMask(e, "c", id, { feather: 8 });
    expect(clipById(e, "c").masks?.[0]?.feather).toBe(8);
    e.undo();
    expect(clipById(e, "c").masks?.[0]?.feather).toBe(0);
  });

  it("keyframes: stamp, animated writes go to the track, remove bakes the value", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "ellipse") as string;
    const m = () => clipById(e, "c").masks?.[0];
    e.ui.currentFrame = 10;
    expect(setMaskKeyframe(e, "c", id, "feather", { value: 4 })).toBe(true);
    e.ui.currentFrame = 50;
    setMaskKeyframe(e, "c", id, "feather", { value: 20 });
    expect(m()?.featherTrack?.keyframes.map((k) => [k.frame, k.value])).toEqual([[10, 4], [50, 20]]);
    updateMask(e, "c", id, { feather: 30 });
    expect(m()?.featherTrack?.keyframes[1]?.value).toBe(30);
    expect(m()?.feather).toBe(0);
    removeMaskKeyframe(e, "c", id, "feather", 10);
    removeMaskKeyframe(e, "c", id, "feather", 50);
    expect(m()?.featherTrack).toBeUndefined();
    expect(m()?.feather).toBe(30);
    e.undo();
    expect(m()?.featherTrack).toBeDefined();
    resetMaskProperty(e, "c", id, "feather");
    expect(m()?.featherTrack).toBeUndefined();
    expect(m()?.feather).toBe(0);
  });

  it("path keyframes interpolate per vertex and hold on topology change", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "rectangle") as string;
    const base = structuredClone(clipById(e, "c").masks?.[0]?.path ?? makeMaskPath());
    e.ui.currentFrame = 0;
    setMaskKeyframe(e, "c", id, "path", { value: base });
    e.ui.currentFrame = 20;
    const moved = structuredClone(base);
    for (const v of moved.vertices) v.x += 0.2;
    setMaskKeyframe(e, "c", id, "path", { value: moved });
    const mask = clipById(e, "c").masks?.[0];
    if (!mask) throw new Error("no mask");
    const x0 = base.vertices[0]?.x ?? 0;
    expect(maskPathAt(mask, 20).vertices[0]?.x).toBeCloseTo(x0 + 0.2);
    const mid = maskPathAt(mask, 10).vertices[0]?.x ?? 0;
    expect(mid).toBeGreaterThan(x0);
    expect(mid).toBeLessThan(x0 + 0.2);
    const fewer = makeEllipsePath(0.5, 0.5, 0.2, 0.2);
    fewer.vertices.pop();
    e.ui.currentFrame = 40;
    setMaskKeyframe(e, "c", id, "path", { value: fewer });
    const m2 = clipById(e, "c").masks?.[0];
    if (!m2) throw new Error("no mask");
    expect(maskPathAt(m2, 30).vertices).toHaveLength(4);
  });

  it("reorder, rename, duplicate, delete", () => {
    const e = setupEditor();
    const a = addMask(e, "c", "rectangle") as string;
    const b = addMask(e, "c", "ellipse") as string;
    reorderMask(e, "c", b, 0);
    expect(clipById(e, "c").masks?.map((m) => m.id)).toEqual([b, a]);
    renameMask(e, "c", a, "  Sky ");
    expect(clipById(e, "c").masks?.[1]?.name).toBe("Sky");
    renameMask(e, "c", a, "   ");
    expect(clipById(e, "c").masks?.[1]?.name).toBe("Sky");
    const d = duplicateMask(e, "c", a) as string;
    expect(clipById(e, "c").masks?.map((m) => m.id)).toEqual([b, a, d]);
    expect(clipById(e, "c").masks?.[2]?.name).not.toBe("Sky");
    removeMask(e, "c", d);
    removeMask(e, "c", a);
    removeMask(e, "c", b);
    expect(clipById(e, "c").masks).toBeUndefined();
    expect(e.ui.selectedMaskId).toBeNull();
  });

  it("splitting a clip carries masks to both halves and splits their tracks", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "ellipse") as string;
    e.ui.currentFrame = 10;
    setMaskKeyframe(e, "c", id, "opacity", { value: 1 });
    e.ui.currentFrame = 90;
    setMaskKeyframe(e, "c", id, "opacity", { value: 0 });
    const parts = splitValues(clipById(e, "c"), 50);
    if (!parts) throw new Error("no split");
    expect(parts.left.masks).toHaveLength(1);
    expect(parts.right.masks).toHaveLength(1);
    expect(parts.right.masks?.[0]?.id).not.toBe(id);
    expect(parts.left.masks?.[0]?.opacityTrack?.keyframes.at(-1)?.frame).toBe(50);
    expect(parts.right.masks?.[0]?.opacityTrack?.keyframes[0]?.frame).toBe(0);
    splitClip(e, "c", 50);
    const all = e.timeline.tracks[0]?.clips ?? [];
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.masks?.length === 1)).toBe(true);
  });

  it("copy/paste carries masks with fresh ids", () => {
    const e = setupEditor();
    addMask(e, "c", "rectangle");
    e.ui.selectedClipIds = new Set(["c"]);
    copySelectedClipsToClipboard(e);
    pasteClips(e, 0, 200);
    const clips = e.timeline.tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(2);
    const pasted = clips.find((c) => c.id !== "c");
    expect(pasted?.masks).toHaveLength(1);
    expect(pasted?.masks?.[0]?.id).not.toBe(clipById(e, "c").masks?.[0]?.id);
  });

  it("round-trips through JSON and omits empty masks", () => {
    const e = setupEditor();
    const id = addMask(e, "c", "ellipse") as string;
    e.ui.currentFrame = 5;
    setMaskKeyframe(e, "c", id, "feather", { value: 3 });
    const clip = clipById(e, "c");
    const json = JSON.parse(JSON.stringify(clip)) as Record<string, unknown>;
    expect(decodeClip(json).masks).toEqual(clip.masks);
    expect(decodeClip({ ...json, masks: [] }).masks).toBeUndefined();
    const plain = JSON.parse(JSON.stringify(Fixtures.clip({ start: 0, duration: 5 })));
    expect("masks" in decodeClip(plain)).toBe(false);
  });
});
