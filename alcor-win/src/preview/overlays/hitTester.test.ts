import { describe, expect, it } from "vitest";
import { makeClip, makeCrop, makeTransform, type Clip } from "../../model";
import { selectPreviewClip } from "../../editor/mutations/selection";
import { Fixtures, makeEditor } from "../../editor/mutations/testFixtures";
import { previewClipIdAt } from "./hitTester";

const size = { width: 320, height: 180 };

function textClip(id: string, transform: Partial<ReturnType<typeof makeTransform>>): Clip {
  return makeClip({
    id, mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 20, textContent: "Hi",
    transform: makeTransform(transform),
  });
}

function box(id: string, transform: Partial<ReturnType<typeof makeTransform>>, extra: Partial<Clip> = {}): Clip {
  return makeClip({
    id, mediaRef: "media", mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: 20,
    transform: makeTransform(transform), ...extra,
  });
}

function editorWith(...tracks: Clip[][]) {
  const e = makeEditor(tracks.map((clips) => Fixtures.videoTrack({ clips })));
  e.withoutRegistration(() => {
    e.timeline.width = 320;
    e.timeline.height = 180;
  });
  return e;
}

describe("EditorViewModel - preview selection", () => {
  it("selectingClipClearsGapSelection", () => {
    const e = editorWith([box("clip", {})]);
    e.ui.selectedGap = { trackIndex: 0, range: { start: 50, end: 100 } };
    e.ui.selectedTimelineMarkerIds = new Set(["marker"]);
    selectPreviewClip(e, "clip");
    expect(e.ui.selectedClipIds).toEqual(new Set(["clip"]));
    expect(e.ui.selectedGap).toBeNull();
    expect(e.ui.selectedTimelineMarkerIds.size).toBe(0);
  });

  it("rotatedTextUsesRotatedHitTarget", () => {
    const e = editorWith([textClip("text", { width: 0.6, height: 0.1, rotation: 90 })]);
    expect(previewClipIdAt(e, { x: 160, y: 45 }, size)).toBe("text");
    expect(previewClipIdAt(e, { x: 100, y: 90 }, size)).toBeUndefined();
  });

  it("tiltedTextUsesProjectedHitTarget", () => {
    const e = editorWith([textClip("text", { width: 0.6, height: 0.2, rotationY: 60 })]);
    expect(previewClipIdAt(e, { x: 160, y: 90 }, size)).toBe("text");
    expect(previewClipIdAt(e, { x: 90, y: 90 }, size)).toBeUndefined();
  });
});

describe("PreviewHitTester", () => {
  it("topmostTrackWinsAmongOverlappingMedia", () => {
    const e = editorWith([box("top", {})], [box("bottom", {})]);
    expect(previewClipIdAt(e, { x: 160, y: 90 }, size)).toBe("top");
  });

  it("fallsThroughToTheLowerClipOutsideTheUpperOne", () => {
    const e = editorWith([box("top", { centerX: 0.25, centerY: 0.5, width: 0.4, height: 0.4 })], [box("bottom", {})]);
    expect(previewClipIdAt(e, { x: 80, y: 90 }, size)).toBe("top");
    expect(previewClipIdAt(e, { x: 260, y: 90 }, size)).toBe("bottom");
  });

  it("followsTheDrawnOrderForTextAndMedia", () => {
    // Text on the lower track is drawn under media on the upper track.
    const e = editorWith([box("media", {})], [textClip("text", {})]);
    expect(previewClipIdAt(e, { x: 160, y: 90 }, size)).toBe("media");
    const f = editorWith([textClip("text", {})], [box("media", {})]);
    expect(previewClipIdAt(f, { x: 160, y: 90 }, size)).toBe("text");
  });

  it("rotatedMediaUsesTheRotatedRect", () => {
    const e = editorWith([box("c", { width: 0.6, height: 0.1, rotation: 90 })]);
    expect(previewClipIdAt(e, { x: 160, y: 45 }, size)).toBe("c");
    expect(previewClipIdAt(e, { x: 100, y: 90 }, size)).toBeUndefined();
  });

  it("croppedAwayAreaDoesNotHit", () => {
    const e = editorWith([box("c", { width: 1, height: 1 }, { crop: makeCrop({ left: 0.5 }) })]);
    expect(previewClipIdAt(e, { x: 60, y: 90 }, size)).toBeUndefined();
    expect(previewClipIdAt(e, { x: 260, y: 90 }, size)).toBe("c");
  });

  it("rotatedCroppedMediaCropsInClipSpace", () => {
    // Left half cropped away, then rotated 180: the visible half is on the screen-left.
    const e = editorWith([box("c", {}, { crop: makeCrop({ left: 0.5 }), })]);
    e.withoutRegistration(() => {
      e.timeline.tracks[0].clips[0].transform.rotation = 180;
    });
    expect(previewClipIdAt(e, { x: 60, y: 90 }, size)).toBe("c");
    expect(previewClipIdAt(e, { x: 260, y: 90 }, size)).toBeUndefined();
  });

  it("hiddenTracksAndClipsOutsideThePlayheadAreSkipped", () => {
    const e = editorWith([box("c", {})]);
    e.withoutRegistration(() => {
      e.timeline.tracks[0].hidden = true;
    });
    expect(previewClipIdAt(e, { x: 160, y: 90 }, size)).toBeUndefined();
    const f = editorWith([box("c", {})]);
    f.ui.currentFrame = 25;
    expect(previewClipIdAt(f, { x: 160, y: 90 }, size)).toBeUndefined();
  });

  it("transparentClipsCannotBePicked", () => {
    const e = editorWith([box("c", {}, { opacity: 0.005 })]);
    expect(previewClipIdAt(e, { x: 160, y: 90 }, size)).toBeUndefined();
  });

  it("emptyCanvasReturnsNothing", () => {
    const e = editorWith([box("c", { width: 0.2, height: 0.2 })]);
    expect(previewClipIdAt(e, { x: 5, y: 5 }, size)).toBeUndefined();
    expect(previewClipIdAt(e, { x: 5, y: 5 }, { width: 0, height: 0 })).toBeUndefined();
  });
});
