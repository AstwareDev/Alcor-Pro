import { describe, expect, it } from "vitest";
import {
  clipCropAt,
  clipRotationAt,
  clipTopLeftAt,
  cropAspectLockFree,
  makeAnimPair,
  makeClip,
  makeKeyframe,
  makeKeyframeTrack,
  makeTextStyle,
  makeTransform,
  type Clip,
} from "../../model";
import { Fixtures, clipById, makeAsset, makeEditor } from "../../editor/mutations/testFixtures";
import { beginCropDrag, beginTransformDrag, type DragSession } from "./gestures";
import { boxGeometry, transformHitAt, type CenterGuides } from "./transformMath";
import type { Editor } from "../../editor/editor";

const size = { width: 1000, height: 500 };
const mods = { shift: false };
const noop = (_g: CenterGuides): void => undefined;

function setup(clip: Clip) {
  const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
  e.ui.currentFrame = 10;
  return e;
}

function plain(): Clip {
  const clip = Fixtures.clip({ id: "c1", mediaType: "image", start: 0, duration: 60 });
  clip.transform = makeTransform({ centerX: 0.4, centerY: 0.4, width: 0.3, height: 0.3 });
  return clip;
}

function drag(session: DragSession | null, from: { x: number; y: number }, to: { x: number; y: number }): void {
  if (!session) throw new Error("no session");
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  session.move(mid, mods);
  session.move(to, mods);
  session.commit(to, mods);
}

function undoCount(e: Editor): number {
  let n = 0;
  while (e.store.canUndo) {
    e.undo();
    n++;
  }
  return n;
}

describe("Transform overlay gestures", () => {
  it("moveDragIsOneUndoEntry", () => {
    const e = setup(plain());
    const start = { x: 400, y: 200 };
    drag(beginTransformDrag(e, "c1", { kind: "move" }, start, size, noop), start, { x: 500, y: 250 });
    const moved = clipById(e, "c1");
    expect(moved.transform.centerX).toBeCloseTo(0.5);
    expect(moved.transform.centerY).toBeCloseTo(0.5);
    expect(e.undo()).toBe("Change Position");
    expect(clipById(e, "c1").transform.centerX).toBeCloseTo(0.4);
    expect(e.store.canUndo).toBe(false);
  });

  it("liveMovesCreateNoUndoEntryUntilCommit", () => {
    const e = setup(plain());
    const s = beginTransformDrag(e, "c1", { kind: "move" }, { x: 400, y: 200 }, size, noop);
    s?.move({ x: 450, y: 200 }, mods);
    s?.move({ x: 480, y: 200 }, mods);
    expect(e.store.canUndo).toBe(false);
    expect(clipById(e, "c1").transform.centerX).toBeCloseTo(0.4 + 80 / 1000);
    s?.commit({ x: 480, y: 200 }, mods);
    expect(undoCount(e)).toBe(1);
  });

  it("cancelRestoresTheStartStateExactlyWithNoUndoEntry", () => {
    const e = setup(plain());
    const before = structuredClone(clipById(e, "c1"));
    const s = beginTransformDrag(e, "c1", { kind: "resize", corner: "bottomRight" }, { x: 550, y: 275 }, size, noop);
    s?.move({ x: 700, y: 400 }, mods);
    expect(clipById(e, "c1").transform.width).not.toBe(before.transform.width);
    s?.cancel();
    expect(clipById(e, "c1")).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("clickWithoutMovingRecordsNothing", () => {
    const e = setup(plain());
    const before = structuredClone(clipById(e, "c1"));
    const s = beginTransformDrag(e, "c1", { kind: "move" }, { x: 400, y: 200 }, size, noop);
    s?.commit({ x: 400, y: 200 }, mods);
    expect(clipById(e, "c1")).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("moveReportsCentreGuidesAndClearsThemOnCommit", () => {
    const e = setup(plain());
    const seen: CenterGuides[] = [];
    const s = beginTransformDrag(e, "c1", { kind: "move" }, { x: 400, y: 200 }, size, (g) => seen.push({ ...g }));
    s?.move({ x: 500, y: 200 }, mods);
    expect(seen.at(-1)).toEqual({ x: true, y: false });
    s?.commit({ x: 500, y: 200 }, mods);
    expect(seen.at(-1)).toEqual({ x: false, y: false });
  });

  it("keyframedPositionWritesAKeyframeAtThePlayheadNotTheStaticTransform", () => {
    const clip = plain();
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0.25, 0.25))]);
    const e = setup(clip);
    const start = { x: 400, y: 200 };
    drag(beginTransformDrag(e, "c1", { kind: "move" }, start, size, noop), start, { x: 500, y: 300 });
    const updated = clipById(e, "c1");
    const kf = updated.positionTrack?.keyframes.find((k) => k.frame === 10);
    expect(kf).toBeDefined();
    expect(updated.positionTrack?.keyframes.length).toBe(2);
    expect(updated.transform.centerX).toBe(0.4);
    const tl = clipTopLeftAt(updated, 10);
    expect(tl.x).toBeCloseTo(0.4 + 0.1 - 0.15);
    expect(undoCount(e)).toBe(1);
  });

  it("keyframedPositionIsNotWrittenOutsideTheClip", () => {
    const clip = plain();
    clip.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0.25, 0.25))]);
    const e = setup(clip);
    e.ui.currentFrame = 200;
    const before = structuredClone(clipById(e, "c1"));
    drag(beginTransformDrag(e, "c1", { kind: "move" }, { x: 400, y: 200 }, size, noop), { x: 400, y: 200 }, { x: 500, y: 300 });
    expect(clipById(e, "c1").positionTrack).toEqual(before.positionTrack);
  });

  it("resizeWithKnownMediaKeepsTheSourceAspectAndIsOneEntry", () => {
    const clip = plain();
    clip.mediaRef = "asset";
    clip.transform = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 });
    const e = setup(clip);
    e.withoutRegistration(() => {
      e.timeline.width = 1000;
      e.timeline.height = 500;
      e.mediaAssets.push(makeAsset({ id: "asset", type: "image", duration: 0, sourceWidth: 1000, sourceHeight: 500 }));
    });
    const s = beginTransformDrag(e, "c1", { kind: "resize", corner: "bottomRight" }, { x: 700, y: 300 }, size, noop);
    drag(s, { x: 700, y: 300 }, { x: 800, y: 300 });
    const t = clipById(e, "c1").transform;
    // mediaCanvasAspect = (1000/500) / (1000/500) = 1 -> normalized w/h stays 1:1 of the original ratio.
    expect(t.width / t.height).toBeCloseTo(1);
    expect(e.undo()).toBe("Change Scale");
    expect(e.store.canUndo).toBe(false);
  });

  it("shiftLocksTheStartAspectWhenSourceSizeIsUnknown", () => {
    const clip = plain();
    clip.transform = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 });
    const e = setup(clip);
    const s = beginTransformDrag(e, "c1", { kind: "resize", corner: "bottomRight" }, { x: 700, y: 350 }, size, noop);
    s?.move({ x: 800, y: 350 }, { shift: true });
    s?.commit({ x: 800, y: 350 }, { shift: true });
    const t = clipById(e, "c1").transform;
    expect(t.width / t.height).toBeCloseTo(2);
    expect(t.width).toBeCloseTo(0.5);
  });

  it("rotateHandleDragRotatesAndSnapsToAxes", () => {
    const e = setup(plain());
    const g = boxGeometry(clipById(e, "c1").transform, size, false);
    expect(transformHitAt(g.rotateHandle, g)).toEqual({ kind: "rotate" });
    const seen: CenterGuides[] = [];
    const s = beginTransformDrag(e, "c1", { kind: "rotate" }, g.rotateHandle, size, (x) => seen.push({ ...x }));
    // Pointer to the right of the centre = 90 degrees clockwise (within snap tolerance of 90).
    const c = g.center;
    s?.move({ x: c.x + 100, y: c.y - 3 }, mods);
    expect(seen.at(-1)).toEqual({ x: true, y: true });
    s?.commit({ x: c.x + 100, y: c.y - 3 }, mods);
    expect(clipById(e, "c1").transform.rotation).toBe(90);
    expect(e.undo()).toBe("Change Rotation");
    expect(clipById(e, "c1").transform.rotation).toBe(0);
  });

  it("rotateKeepsTurningPastHalfTurnInsteadOfWrapping", () => {
    const e = setup(plain());
    const g = boxGeometry(clipById(e, "c1").transform, size, false);
    const c = g.center;
    const s = beginTransformDrag(e, "c1", { kind: "rotate" }, g.rotateHandle, size, noop);
    s?.move({ x: c.x + 100, y: c.y + 0.0001 }, mods);
    s?.move({ x: c.x + 1, y: c.y + 100 }, mods);
    s?.move({ x: c.x - 100, y: c.y + 10 }, mods);
    s?.commit({ x: c.x - 100, y: c.y + 10 }, mods);
    expect(clipById(e, "c1").transform.rotation).toBeGreaterThan(180);
  });

  it("keyframedRotationWritesAKeyframeAtThePlayhead", () => {
    const clip = plain();
    clip.rotationTrack = makeKeyframeTrack([makeKeyframe(0, 0)]);
    const e = setup(clip);
    const g = boxGeometry(clipById(e, "c1").transform, size, false);
    const c = g.center;
    const s = beginTransformDrag(e, "c1", { kind: "rotate" }, g.rotateHandle, size, noop);
    s?.move({ x: c.x + 100, y: c.y - 3 }, mods);
    s?.commit({ x: c.x + 100, y: c.y - 3 }, mods);
    const updated = clipById(e, "c1");
    expect(updated.transform.rotation).toBe(0);
    expect(clipRotationAt(updated, 10)).toBe(90);
    expect(updated.rotationTrack?.keyframes.some((k) => k.frame === 10)).toBe(true);
  });

  it("textCornerDragScalesTheFontAndIsOneEntry", () => {
    const text = makeClip({
      id: "t1", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 60, textContent: "Hi",
      textStyle: makeTextStyle(), transform: makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 }),
    });
    const e = setup(text);
    const before = clipById(e, "t1").textStyle?.fontScale ?? 1;
    drag(beginTransformDrag(e, "t1", { kind: "resize", corner: "bottomRight" }, { x: 700, y: 300 }, size, noop), { x: 700, y: 300 }, { x: 800, y: 350 });
    expect(clipById(e, "t1").textStyle?.fontScale).toBeGreaterThan(before);
    expect(undoCount(e)).toBe(1);
  });

  it("textCornerDragCancelRestoresTheStyle", () => {
    const text = makeClip({
      id: "t1", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 60, textContent: "Hi",
      textStyle: makeTextStyle(), transform: makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.2 }),
    });
    const e = setup(text);
    const before = structuredClone(clipById(e, "t1"));
    const s = beginTransformDrag(e, "t1", { kind: "resize", corner: "topLeft" }, { x: 300, y: 200 }, size, noop);
    s?.move({ x: 200, y: 100 }, mods);
    s?.cancel();
    expect(clipById(e, "t1")).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("unknownClipYieldsNoSession", () => {
    const e = setup(plain());
    expect(beginTransformDrag(e, "missing", { kind: "move" }, { x: 0, y: 0 }, size, noop)).toBeNull();
    expect(beginTransformDrag(e, "c1", { kind: "move" }, { x: 0, y: 0 }, { width: 0, height: 0 }, noop)).toBeNull();
  });
});

describe("Crop overlay gestures", () => {
  it("panDragIsOneUndoEntry", () => {
    const e = setup(plain());
    e.withoutRegistration(() => {
      e.timeline.tracks[0].clips[0].crop = { left: 0.1, top: 0, right: 0.3, bottom: 0 };
    });
    // clip is 300x150 px; 30px right = 0.1 of the clip width.
    drag(beginCropDrag(e, "c1", { kind: "pan" }, { x: 400, y: 200 }, size), { x: 400, y: 200 }, { x: 430, y: 200 });
    const crop = clipCropAt(clipById(e, "c1"), 10);
    expect(crop.left).toBeCloseTo(0.2);
    expect(crop.right).toBeCloseTo(0.2);
    expect(e.undo()).toBe("Change Crop");
    expect(e.store.canUndo).toBe(false);
  });

  it("cornerResizeCancelRestoresTheCrop", () => {
    const e = setup(plain());
    const before = structuredClone(clipById(e, "c1"));
    const s = beginCropDrag(e, "c1", { kind: "resize", corner: "topLeft" }, { x: 250, y: 125 }, size);
    s?.move({ x: 300, y: 150 }, mods);
    expect(clipById(e, "c1").crop.left).toBeGreaterThan(0);
    s?.cancel();
    expect(clipById(e, "c1")).toEqual(before);
    expect(e.store.canUndo).toBe(false);
  });

  it("keyframedCropWritesAKeyframeAtThePlayhead", () => {
    const clip = plain();
    clip.cropTrack = makeKeyframeTrack([makeKeyframe(0, { left: 0, top: 0, right: 0, bottom: 0 })]);
    const e = setup(clip);
    drag(beginCropDrag(e, "c1", { kind: "resize", corner: "topLeft" }, { x: 250, y: 125 }, size), { x: 250, y: 125 }, { x: 310, y: 125 });
    const updated = clipById(e, "c1");
    expect(updated.crop.left).toBe(0);
    expect(updated.cropTrack?.keyframes.find((k) => k.frame === 10)?.value.left).toBeCloseTo(0.2);
  });

  it("rotatedClipMapsTheDragIntoClipAxes", () => {
    const clip = plain();
    clip.transform = makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.3, height: 0.3, rotation: 90 });
    const e = setup(clip);
    // Rotated 90 degrees clockwise: a screen drag downwards is a clip-local move to the right (+x).
    drag(beginCropDrag(e, "c1", { kind: "resize", corner: "topLeft" }, { x: 500, y: 250 }, size), { x: 500, y: 250 }, { x: 500, y: 280 });
    expect(clipById(e, "c1").crop.left).toBeCloseTo(0.1);
    expect(clipById(e, "c1").crop.top).toBeCloseTo(0);
  });

  it("lockedAspectUsesTheSourceAspect", () => {
    const e = setup(plain());
    e.withoutRegistration(() => {
      e.mediaAssets.push(makeAsset({ id: "media-1", type: "image", duration: 0, sourceWidth: 1000, sourceHeight: 500 }));
    });
    e.ui.cropAspectLock = { kind: "fixed", ratio: { horizontal: 1, vertical: 1 } };
    drag(beginCropDrag(e, "c1", { kind: "resize", corner: "bottomRight" }, { x: 550, y: 275 }, size), { x: 550, y: 275 }, { x: 520, y: 275 });
    const c = clipById(e, "c1").crop;
    const visW = (1 - c.left - c.right) * 1000;
    const visH = (1 - c.top - c.bottom) * 500;
    expect(visW / visH).toBeCloseTo(1);
    expect(cropAspectLockFree.kind).toBe("free");
  });
});
