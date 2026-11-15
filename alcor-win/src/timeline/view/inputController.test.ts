import { describe, expect, it } from "vitest";
import { clipEndFrame, makeKeyframe, makeKeyframeTrack, type Clip } from "../../model";
import { Fixtures, makeEditor, setup } from "../../editor/mutations/testFixtures";
import type { Editor } from "../../editor/editor";
import { clipRectFor, fadeKneeRect, makeTimelineGeometryForTimeline, type TimelineGeometry } from "../timelineGeometry";
import { makeTimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { TimelineInputController, type TimelineCursor, type TimelinePointer, type TimelineToolMode, type TimelineViewHost } from "./inputController";

// Track 0 spans y 60..104 (ruler 28 + drop zone 32); track 1 104..148. At 4 px/frame frame f sits at x = 4f.

interface TestHost extends TimelineViewHost {
  tool: TimelineToolMode;
  cursor: TimelineCursor;
  sx: number;
  sy: number;
  autoScroll: boolean;
  presented: string[];
}

function makeHost(editor: Editor, ppf = 4): TestHost {
  const lanes = makeTimelineKeyframeLaneState();
  editor.ui.zoomScale = ppf;
  editor.ui.timelineVisibleWidth = 800;
  const host: TestHost = {
    tool: "pointer",
    cursor: "default",
    sx: 0,
    sy: 0,
    autoScroll: false,
    presented: [],
    geometry: (): TimelineGeometry =>
      makeTimelineGeometryForTimeline({
        timeline: editor.timeline,
        zoomScale: editor.ui.zoomScale,
        bounds: { x: 0, y: 0, width: 100_000, height: 1_000 },
        laneState: lanes,
      }),
    scrollX: () => host.sx,
    scrollY: () => host.sy,
    viewportWidth: () => 800,
    setScrollX: (x) => void (host.sx = Math.max(0, x)),
    setScrollY: (y) => void (host.sy = Math.max(0, y)),
    laneState: () => lanes,
    toolMode: () => host.tool,
    invalidate: () => undefined,
    invalidateOverlay: () => undefined,
    setCursor: (c) => void (host.cursor = c),
    presentMarkerEditor: (id) => void host.presented.push(id),
    setAutoScrollActive: (a) => void (host.autoScroll = a),
  };
  return host;
}

function ptr(x: number, y: number, mods: Partial<TimelinePointer> = {}): TimelinePointer {
  return { x, y, shift: false, ctrl: false, alt: false, clickCount: 1, ...mods };
}

const y0 = 80;
const y1 = 125;

function drag(c: TimelineInputController, from: [number, number], to: [number, number], mods: Partial<TimelinePointer> = {}): void {
  c.pointerDown(ptr(from[0], from[1], mods));
  c.pointerDrag(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods));
  c.pointerDrag(ptr(to[0], to[1], mods));
  c.pointerUp(ptr(to[0], to[1], mods));
}

function setupTwoVideoClips(): { editor: Editor; a: Clip; b: Clip } {
  const a = Fixtures.clip({ id: "a", start: 0, duration: 30, trimEnd: 100 });
  const b = Fixtures.clip({ id: "b", start: 100, duration: 30, trimStart: 20, trimEnd: 20 });
  const editor = makeEditor([Fixtures.videoTrack({ clips: [a, b] }), Fixtures.videoTrack({ clips: [] })]);
  return { editor, a, b };
}

function clip(editor: Editor, id: string): Clip {
  const c = editor.clipFor(id);
  if (!c) throw new Error(id);
  return c;
}

function undoCount(editor: Editor): number {
  let n = 0;
  while (editor.store.canUndo) {
    editor.undo();
    n += 1;
  }
  for (let i = 0; i < n; i++) editor.redo();
  return n;
}

describe("TimelineInputController - hit zones", () => {
  it("classifiesBodyTrimEdgesRulerAndEmpty", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    expect(c.hitZone(ptr(60, y0))).toMatchObject({ kind: "clip", clipId: "a", part: "body" });
    expect(c.hitZone(ptr(2, y0))).toMatchObject({ kind: "clip", clipId: "a", part: "trimLeft" });
    expect(c.hitZone(ptr(118, y0))).toMatchObject({ kind: "clip", clipId: "a", part: "trimRight" });
    expect(c.hitZone(ptr(200, y0))).toMatchObject({ kind: "gap", gap: { trackIndex: 0, range: { start: 30, end: 100 } } });
    expect(c.hitZone(ptr(700, y0))).toEqual({ kind: "empty" });
    expect(c.hitZone(ptr(50, 10))).toEqual({ kind: "ruler" });
  });

  it("narrowClipsHaveNoTrimZones", () => {
    const editor = makeEditor([Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "n", start: 0, duration: 10 })] })]);
    const c = new TimelineInputController(editor, makeHost(editor));
    expect(c.hitZone(ptr(1, y0))).toMatchObject({ kind: "clip", part: "body" });
  });

  it("fadeKneeOnlyWhenSelectedOrHovered", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    const a = clip(editor, "a");
    const knee = fadeKneeRect(a, "left", clipRectFor(host.geometry(), a, 0));
    const kp = ptr(knee.x + knee.width / 2 + 1, knee.y + knee.height / 2);
    expect(c.hitZone(kp)).toMatchObject({ part: "body" });
    editor.ui.selectedClipIds = new Set(["a"]);
    expect(c.hitZone(kp)).toMatchObject({ part: "fadeKnee" });
  });

  it("volumeKeyframeZoneOnSelectedAudio", () => {
    const audio = Fixtures.clip({ id: "au", mediaType: "audio", start: 0, duration: 50 });
    audio.volumeTrack = makeKeyframeTrack([makeKeyframe(25, 0)]);
    const editor = makeEditor([Fixtures.audioTrack({ clips: [audio] })]);
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    editor.ui.selectedClipIds = new Set(["au"]);
    const rect = clipRectFor(host.geometry(), audio, 0);
    // 0 dB on a +6...-60 band: 6/66 of the body height below its top.
    const y = rect.y + 16 + (6 / 66) * (rect.height - 17);
    expect(c.hitZone(ptr(100, y))).toMatchObject({ kind: "clip", part: "volumeKeyframe" });
  });

  it("razorToolSnapsHoverLineToClipEdges", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    host.tool = "razor";
    const c = new TimelineInputController(editor, host);
    c.hover(ptr(121, y0));
    expect(c.razorPreviewFrame).toBe(30);
    expect(host.cursor).toBe("crosshair");
  });
});

describe("TimelineInputController - selection", () => {
  it("clickSelectsLinkGroupShiftTogglesAltSelectsSingle", () => {
    const v = Fixtures.clip({ id: "v", start: 0, duration: 30 });
    const au = Fixtures.clip({ id: "au", mediaType: "audio", start: 0, duration: 30 });
    v.linkGroupId = "g";
    au.linkGroupId = "g";
    const other = Fixtures.clip({ id: "o", start: 50, duration: 30 });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [v, other] }), Fixtures.audioTrack({ clips: [au] })]);
    const c = new TimelineInputController(editor, makeHost(editor));
    c.pointerDown(ptr(60, y0));
    c.pointerUp();
    expect([...editor.ui.selectedClipIds].sort()).toEqual(["au", "v"]);
    c.pointerDown(ptr(260, y0, { shift: true }));
    c.pointerUp();
    expect(editor.ui.selectedClipIds.size).toBe(3);
    c.pointerDown(ptr(60, y0, { shift: true }));
    c.pointerUp();
    expect([...editor.ui.selectedClipIds]).toEqual(["o"]);
    c.pointerDown(ptr(60, y0, { alt: true }));
    c.pointerUp();
    expect([...editor.ui.selectedClipIds]).toEqual(["v"]);
  });

  it("marqueeSelectsIntersectingClipsAndClickOnEmptyClears", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    editor.ui.selectedClipIds = new Set(["b"]);
    drag(c, [200, 120], [20, 70]);
    expect([...editor.ui.selectedClipIds]).toEqual(["a"]);
    expect(editor.ui.isMarqueeSelecting).toBe(false);
    c.pointerDown(ptr(700, y1));
    c.pointerUp();
    expect(editor.ui.selectedClipIds.size).toBe(0);
  });

  it("clickInGapSelectsGap", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    c.pointerDown(ptr(200, y0));
    c.pointerUp();
    expect(editor.ui.selectedGap).toEqual({ trackIndex: 0, range: { start: 30, end: 100 } });
  });
});

describe("TimelineInputController - move", () => {
  it("moveSnapsToClipEdgeAndCreatesOneUndoEntry", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    // Grab b at frame 105 and drop near frame 37: its start (32) snaps to a's end (30).
    drag(c, [420, y0], [148, y0]);
    expect(clip(editor, "b").startFrame).toBe(30);
    expect(c.snapIndicatorX).toBeUndefined();
    expect(undoCount(editor)).toBe(1);
    editor.undo();
    expect(clip(editor, "b").startFrame).toBe(100);
  });

  it("moveToAnotherTrack", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [420, y0], [420, y1]);
    expect(editor.findClip("b")?.trackIndex).toBe(1);
  });

  it("dropBelowLastTrackCreatesNewTrackAsOneUndoEntry", () => {
    const { editor } = setupTwoVideoClips();
    setup(editor, (e) => {
      e.timeline.tracks.pop();
    });
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [420, y0], [420, 150]);
    expect(editor.timeline.tracks.length).toBe(2);
    expect(undoCount(editor)).toBe(1);
  });

  it("altDragDuplicates", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [420, y0], [420, y1], { alt: true });
    expect(editor.timeline.tracks[0].clips.map((x) => x.id)).toContain("b");
    expect(editor.timeline.tracks[1].clips.length).toBe(1);
  });

  it("clickWithoutMovingChangesNothing", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    c.pointerDown(ptr(420, y0));
    c.pointerUp();
    expect(editor.store.canUndo).toBe(false);
  });
});

describe("TimelineInputController - trim / slip / razor", () => {
  it("trimRightClampsToSourceHeadroom", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [519, y0], [700, y0]);
    // b ends at 130 with 20 frames of tail.
    expect(clipEndFrame(clip(editor, "b"))).toBe(150);
    expect(clip(editor, "b").trimEndFrame).toBe(0);
    expect(undoCount(editor)).toBe(1);
  });

  it("trimLeftMovesStartAndTrim", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [401, y0], [440, y0]);
    expect(clip(editor, "b").startFrame).toBe(110);
    expect(clip(editor, "b").trimStartFrame).toBe(30);
  });

  it("shiftTrimRipplesFollowingClips", () => {
    const a = Fixtures.clip({ id: "a", start: 0, duration: 30, trimEnd: 100 });
    const b = Fixtures.clip({ id: "b", start: 30, duration: 30 });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [a, b] })]);
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [119, y0], [200, y0], { shift: true });
    expect(clip(editor, "a").durationFrames).toBe(50);
    expect(clip(editor, "b").startFrame).toBe(50);
    expect(undoCount(editor)).toBe(1);
  });

  it("slipToolShiftsSourceWithoutMoving", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    host.tool = "trim";
    const c = new TimelineInputController(editor, host);
    drag(c, [460, y0], [420, y0]);
    const b = clip(editor, "b");
    expect(b.startFrame).toBe(100);
    expect(b.trimStartFrame).toBe(30);
    expect(b.trimEndFrame).toBe(10);
  });

  it("razorSplitsAtClick", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    host.tool = "razor";
    const c = new TimelineInputController(editor, host);
    c.hover(ptr(60, y0));
    c.pointerDown(ptr(60, y0));
    c.pointerUp();
    expect(editor.timeline.tracks[0].clips.map((x) => [x.startFrame, x.durationFrames])).toEqual([
      [0, 15],
      [15, 15],
      [100, 30],
    ]);
  });
});

describe("TimelineInputController - escape and scrub", () => {
  function snapshotDoc(editor: Editor): string {
    return JSON.stringify(editor.doc);
  }

  it("escapeDuringMoveRestoresExactStateWithoutUndoEntry", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    const before = snapshotDoc(editor);
    c.pointerDown(ptr(420, y0));
    c.pointerDrag(ptr(600, y1));
    expect(c.cancelActiveDrag()).toBe(true);
    c.pointerUp(ptr(600, y1));
    expect(snapshotDoc(editor)).toBe(before);
    expect(editor.store.canUndo).toBe(false);
    expect(editor.ui.selectedClipIds.size).toBe(0);
  });

  it("escapeDuringFadeDragRevertsLiveEdit", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    editor.ui.selectedClipIds = new Set(["a"]);
    const a = clip(editor, "a");
    const knee = fadeKneeRect(a, "left", clipRectFor(host.geometry(), a, 0));
    const before = snapshotDoc(editor);
    c.pointerDown(ptr(knee.x + knee.width / 2, knee.y + knee.height / 2));
    expect(c.dragState.kind).toBe("fadeKnee");
    c.pointerDrag(ptr(80, knee.y));
    expect(clip(editor, "a").fadeInFrames).toBeGreaterThan(0);
    c.cancelActiveDrag();
    c.pointerUp();
    expect(snapshotDoc(editor)).toBe(before);
    expect(editor.store.canUndo).toBe(false);
  });

  it("fadeDragCommitsOneUndoEntryAndUndoRestores", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    editor.ui.selectedClipIds = new Set(["a"]);
    const a = clip(editor, "a");
    const knee = fadeKneeRect(a, "left", clipRectFor(host.geometry(), a, 0));
    const before = snapshotDoc(editor);
    drag(c, [knee.x + knee.width / 2, knee.y + knee.height / 2], [knee.x + 40, knee.y]);
    expect(clip(editor, "a").fadeInFrames).toBeGreaterThan(0);
    expect(undoCount(editor)).toBe(1);
    editor.undo();
    expect(snapshotDoc(editor)).toBe(before);
  });

  it("rulerScrubSeeksAndEscapeRestoresPlayhead", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    editor.ui.currentFrame = 5;
    c.pointerDown(ptr(80, 10));
    expect(editor.ui.currentFrame).toBe(20);
    expect(editor.ui.isScrubbing).toBe(true);
    c.pointerDrag(ptr(200, 10));
    expect(editor.ui.currentFrame).toBe(50);
    c.cancelActiveDrag();
    expect(editor.ui.currentFrame).toBe(5);
    expect(editor.ui.isScrubbing).toBe(false);
  });

  it("shiftDragOnRulerSelectsRange", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    drag(c, [200, 10], [300, 10], { shift: true });
    expect(editor.ui.selectedTimelineRange).toEqual({ startFrame: 50, endFrame: 75 });
  });

  it("scrubNearEdgeStartsAutoScroll", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    c.pointerDown(ptr(400, 10));
    c.pointerDrag(ptr(795, 10));
    expect(host.autoScroll).toBe(true);
    c.autoScrollTick();
    expect(host.sx).toBeGreaterThan(0);
    c.pointerUp();
    expect(host.autoScroll).toBe(false);
  });
});

describe("TimelineInputController - zoom", () => {
  it("ctrlWheelZoomsAnchoredAtCursor", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    c.wheel(ptr(400, y0, { ctrl: true }), 0, -100);
    expect(editor.ui.zoomScale).toBeGreaterThan(4);
    // Frame 100 stays under the cursor.
    expect(Math.round((400 + host.sx) / editor.ui.zoomScale)).toBe(100);
  });

  it("plainWheelScrollsVerticallyShiftWheelHorizontally", () => {
    const { editor } = setupTwoVideoClips();
    const host = makeHost(editor);
    const c = new TimelineInputController(editor, host);
    c.wheel(ptr(0, y0), 0, 40);
    expect(host.sy).toBe(40);
    c.wheel(ptr(0, y0, { shift: true }), 0, 30);
    expect(host.sx).toBe(30);
  });
});

describe("TimelineInputController - external drop", () => {
  it("dropSnapsToClipEdge", () => {
    const { editor } = setupTwoVideoClips();
    const c = new TimelineInputController(editor, makeHost(editor));
    const asset = { id: "x", url: "/x", type: "video" as const, name: "x", duration: 1, hasAudio: false, generationStatus: { kind: "none" as const } };
    c.externalDragUpdate(ptr(126, y1), [asset], {});
    expect(c.external?.frame).toBe(30);
    expect(c.external?.target).toEqual({ kind: "existingTrack", index: 1 });
    const drop = c.externalDrop(ptr(126, y1, { ctrl: true }), [asset], {});
    expect(drop).toEqual({ cursor: { kind: "existingTrack", index: 1 }, frame: 30, ripple: true });
    expect(c.external).toBeUndefined();
  });
});

