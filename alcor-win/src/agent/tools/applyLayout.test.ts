import { describe, expect, it } from "vitest";
import {
  clipTransformAt, cropVisibleHeightFraction, cropVisibleWidthFraction, makeAnimPair, makeClip, makeCrop, makeKeyframe,
  makeKeyframeTrack, transformTopLeft, type Clip, type MediaAsset, type Timeline,
} from "../../model";
import { Fixtures, makeAsset } from "../../editor/mutations/testFixtures";
import { insertTrack } from "../../editor/mutations/tracks";
import { ToolHarness } from "./testHarness";

const approx = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) < tol;

/** Swift `#require` / force unwrap. */
function req<T>(value: T | undefined | null): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T; // checked by the expects above
}

function videoAsset(h: ToolHarness, id: string, w = 1920, ht = 1080, hasAudio = false): MediaAsset {
  const asset = makeAsset({ id, type: "video", duration: 5, hasAudio, sourceWidth: w, sourceHeight: ht });
  h.editor.withoutRegistration(() => {
    h.editor.doc.mediaAssets.push(asset);
  });
  return asset;
}

function configure(t: Timeline, w: number, ht: number): Timeline {
  t.width = w;
  t.height = ht;
  t.settingsConfigured = true;
  return t;
}

/** The harness copies only width/height/name, so settingsConfigured is applied afterwards. */
function harnessFor(t: Timeline): ToolHarness {
  const h = new ToolHarness(t);
  h.editor.withoutRegistration(() => {
    h.editor.timeline.settingsConfigured = t.settingsConfigured;
  });
  return h;
}

function configured(w: number, ht: number): ToolHarness {
  return harnessFor(
    configure(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "existing", start: 0, duration: 30 })] })] }), w, ht),
  );
}

function clips(h: ToolHarness, mediaRef: string): Clip | undefined {
  return h.editor.timeline.tracks.flatMap((t) => t.clips).find((c) => c.mediaRef === mediaRef);
}

function clip(h: ToolHarness, id: string): Clip | undefined {
  return h.editor.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
}

describe("apply_layout", () => {
  it("placementAdoptsLayoutSlotOrderForSettings", async () => {
    const h = new ToolHarness();
    videoAsset(h, "landscape", 1920, 1080);
    videoAsset(h, "portrait", 1080, 1920);
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side", endFrame: 60,
      slots: [{ slot: "right", mediaRef: "portrait" }, { slot: "left", mediaRef: "landscape" }],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.width).toBe(1920);
    expect(h.editor.timeline.height).toBe(1080);
  });

  it("sideBySideFillsWithoutStretch", async () => {
    const h = new ToolHarness();
    videoAsset(h, "a");
    videoAsset(h, "b");
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side", endFrame: 120,
      slots: [{ slot: "left", mediaRef: "a" }, { slot: "right", mediaRef: "b" }],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(2);
    const left = req(clips(h, "a"));
    const right = req(clips(h, "b"));
    expect(approx(left.transform.centerX, 0.25)).toBe(true);
    expect(approx(right.transform.centerX, 0.75)).toBe(true);
    const canvasAspect = 1920.0 / 1080.0;
    for (const c of [left, right]) {
      expect(approx(c.crop.left, 0.25)).toBe(true);
      expect(approx(c.crop.right, 0.25)).toBe(true);
      expect(approx((c.transform.width / c.transform.height) * canvasAspect, 16.0 / 9.0, 1e-3)).toBe(true);
      expect(approx(c.transform.width * cropVisibleWidthFraction(c.crop), 0.5)).toBe(true);
      expect(approx(c.transform.height * cropVisibleHeightFraction(c.crop), 1.0)).toBe(true);
    }
  });

  it("pipInsetSitsOnTopOfMain", async () => {
    const h = new ToolHarness();
    videoAsset(h, "screen");
    videoAsset(h, "cam");
    const r = await h.runRaw("apply_layout", {
      layout: "pip_bottom_right", endFrame: 90,
      slots: [{ slot: "main", mediaRef: "screen" }, { slot: "inset", mediaRef: "cam" }],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(2);
    let insetIdx = -1;
    let mainIdx = -1;
    h.editor.timeline.tracks.forEach((t, i) => {
      for (const c of t.clips) {
        if (approx(c.transform.width, 0.28)) insetIdx = i;
        if (approx(c.transform.width, 1.0)) mainIdx = i;
      }
    });
    expect(insetIdx >= 0 && mainIdx >= 0).toBe(true);
    expect(insetIdx < mainIdx).toBe(true);
    const inset = req(clips(h, "cam"));
    const topLeft = transformTopLeft(inset.transform);
    expect(topLeft.x > 0.6 && topLeft.y > 0.6).toBe(true);
  });

  it("fitLetterboxesWithoutCropping", async () => {
    const h = new ToolHarness();
    videoAsset(h, "a");
    videoAsset(h, "b");
    const r = await h.runRaw("apply_layout", {
      layout: "top_bottom", endFrame: 60, fit: "fit",
      slots: [{ slot: "top", mediaRef: "a" }, { slot: "bottom", mediaRef: "b" }],
    });
    expect(r.isError).toBe(false);
    const canvasAspect = 1920.0 / 1080.0;
    for (const c of h.editor.timeline.tracks.flatMap((t) => t.clips)) {
      expect(approx(c.crop.left, 0) && approx(c.crop.top, 0)).toBe(true);
      expect(approx((c.transform.width / c.transform.height) * canvasAspect, 16.0 / 9.0, 1e-3)).toBe(true);
      expect(c.transform.height <= 0.5 + 1e-6).toBe(true);
    }
  });

  for (const edge of [2, 3, 4]) {
    it(`gridsTileTheCanvas (edge: ${edge})`, async () => {
      const h = new ToolHarness();
      const layout = `grid_${edge}x${edge}`;
      const slotIDs: string[] = [];
      for (let row = 1; row <= edge; row++) for (let col = 1; col <= edge; col++) slotIDs.push(`r${row}c${col}`);
      for (const id of slotIDs) videoAsset(h, id);

      const r = await h.runRaw("apply_layout", {
        layout, endFrame: 90,
        slots: slotIDs.map((id) => ({ slot: id, mediaRef: id })),
      });

      expect(r.isError).toBe(false);
      expect(h.editor.timeline.tracks.flatMap((t) => t.clips).length).toBe(edge * edge);
      const cell = 1.0 / edge;
      slotIDs.forEach((id, index) => {
        const c = req(clips(h, id));
        expect(approx(c.transform.width * cropVisibleWidthFraction(c.crop), cell)).toBe(true);
        expect(approx(c.transform.height * cropVisibleHeightFraction(c.crop), cell)).toBe(true);
        expect(approx(c.transform.centerX, ((index % edge) + 0.5) * cell)).toBe(true);
        expect(approx(c.transform.centerY, (Math.trunc(index / edge) + 0.5) * cell)).toBe(true);
      });
    });
  }

  it("placementIsSingleUndoStep", async () => {
    const h = configured(1920, 1080);
    for (const id of ["a", "b", "c", "d"]) videoAsset(h, id, 1920, 1080, true);
    const actionNames: string[] = [];
    h.editor.store.onActionCommitted = (name) => actionNames.push(name);
    const r = await h.runRaw("apply_layout", {
      layout: "grid_2x2", endFrame: 90,
      slots: [
        { slot: "r1c1", mediaRef: "a" }, { slot: "r1c2", mediaRef: "b" },
        { slot: "r2c1", mediaRef: "c" }, { slot: "r2c2", mediaRef: "d" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(actionNames).toEqual(["Apply Layout (Agent)"]);

    const tracksAfter = h.editor.timeline.tracks.length;
    expect(tracksAfter).toBeGreaterThan(1);
    h.editor.undo();
    expect(h.editor.timeline.tracks.length).toBeLessThan(tracksAfter);
    expect(h.editor.timeline.tracks.flatMap((t) => t.clips).every((c) => c.id === "existing")).toBe(true);
    expect(h.editor.store.canUndo).toBe(false);
  });

  it("reLayoutsExistingClipsByClipId", async () => {
    const timeline = Fixtures.timeline({
      tracks: [
        Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 })] }),
        Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cb", mediaRef: "b", start: 0, duration: 60 })] }),
      ],
    });
    const h = new ToolHarness(timeline);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const before = h.editor.timeline.tracks.length;
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(before);
    expect(approx(req(clip(h, "ca")).transform.centerX, 0.25)).toBe(true);
    expect(approx(req(clip(h, "cb")).transform.centerX, 0.75)).toBe(true);
    expect(req(clip(h, "ca")).startFrame).toBe(0);
  });

  it("reLayoutsBatchOfClipsIntoOneSlot", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({
            clips: [
              Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 },),
              Fixtures.clip({ id: "cb", mediaRef: "a", start: 60, duration: 60 }),
            ],
          }),
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cc", mediaRef: "b", start: 0, duration: 120 })] }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const before = h.editor.timeline.tracks.length;
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca", "cb"] }, { slot: "right", clipIds: ["cc"] }],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(before);
    expect(approx(req(clip(h, "ca")).transform.centerX, 0.25)).toBe(true);
    expect(approx(req(clip(h, "cb")).transform.centerX, 0.25)).toBe(true);
    expect(approx(req(clip(h, "cc")).transform.centerX, 0.75)).toBe(true);
  });

  it("batchRejectsOverlapAcrossDifferentSlots", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({
            clips: [
              Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 }),
              Fixtures.clip({ id: "cb", mediaRef: "b", start: 30, duration: 60 }),
            ],
          }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(r.isError).toBe(true);
    expect(approx(req(clip(h, "ca")).transform.centerX, 0.5)).toBe(true);
  });

  it("batchRejectsEmptyAndDuplicateClipIds", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 })] }),
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cb", mediaRef: "b", start: 0, duration: 60 })] }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const empty = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: [] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(empty.isError).toBe(true);
    const dup = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca", "ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(dup.isError).toBe(true);
  });

  it("reLayoutClearsAnimationTracks", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 })] }),
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cb", mediaRef: "b", start: 0, duration: 60 })] }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    h.editor.withoutRegistration(() => {
      const c = h.editor.timeline.tracks[0].clips[0];
      c.positionTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0, 0)), makeKeyframe(60, makeAnimPair(0.5, 0.5))]);
      c.scaleTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(1, 1)), makeKeyframe(60, makeAnimPair(0.5, 0.5))]);
      c.cropTrack = makeKeyframeTrack([makeKeyframe(0, makeCrop()), makeKeyframe(60, makeCrop({ left: 0.5, top: 0, right: 0, bottom: 0 }))]);
    });
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(r.isError).toBe(false);
    const c = req(clip(h, "ca"));
    expect(c.positionTrack === undefined && c.scaleTrack === undefined && c.cropTrack === undefined).toBe(true);
    expect(approx(clipTransformAt(c, 0).centerX, 0.25)).toBe(true);
    expect(approx(clipTransformAt(c, 60).centerX, 0.25)).toBe(true);
  });

  it("reLayoutRejectsSameTrackOverlap", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({
            clips: [
              Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 }),
              Fixtures.clip({ id: "cb", mediaRef: "b", start: 30, duration: 60 }),
            ],
          }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(r.isError).toBe(true);
    expect(approx(req(clip(h, "ca")).transform.centerX, 0.5)).toBe(true);
  });

  it("reLayoutRejectsClipsThatNeverCoincide", async () => {
    const t = configure(
      Fixtures.timeline({
        tracks: [
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "ca", mediaRef: "a", start: 0, duration: 60 })] }),
          Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cb", mediaRef: "b", start: 120, duration: 60 })] }),
        ],
      }),
      1920, 1080,
    );
    const h = harnessFor(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const r = await h.runRaw("apply_layout", {
      layout: "side_by_side",
      slots: [{ slot: "left", clipIds: ["ca"] }, { slot: "right", clipIds: ["cb"] }],
    });
    expect(r.isError).toBe(true);
    expect(approx(req(clip(h, "ca")).transform.centerX, 0.5)).toBe(true);
  });

  it("fullRefitsSingleClipToCanvasAspect", async () => {
    const t = configure(
      Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", mediaRef: "wide", start: 0, duration: 60 })] })] }),
      1080, 1920,
    );
    const h = harnessFor(t);
    videoAsset(h, "wide", 1920, 1080);
    const before = h.editor.timeline.tracks.length;
    const r = await h.runRaw("apply_layout", { layout: "full", slots: [{ slot: "main", clipIds: ["c1"], anchorX: 0.3 }] });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(before);
    const c = req(clip(h, "c1"));
    expect(approx(c.transform.width * cropVisibleWidthFraction(c.crop), 1.0)).toBe(true);
    expect(approx(c.transform.height * cropVisibleHeightFraction(c.crop), 1.0)).toBe(true);
    expect(approx((c.transform.width / c.transform.height) * (1080.0 / 1920.0), 16.0 / 9.0, 1e-3)).toBe(true);
    expect(approx(c.crop.top, 0)).toBe(true);
    expect(approx(c.crop.left, (c.crop.left + c.crop.right) * 0.3)).toBe(true);
  });

  it("threeStackFillsHorizontalRows", async () => {
    const h = new ToolHarness();
    for (const id of ["a", "b", "c"]) videoAsset(h, id);
    const r = await h.runRaw("apply_layout", {
      layout: "three_stack", endFrame: 90,
      slots: [
        { slot: "top", mediaRef: "a" },
        { slot: "middle", mediaRef: "b" },
        { slot: "bottom", mediaRef: "c" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(3);
    const top = req(clips(h, "a"));
    const middle = req(clips(h, "b"));
    const bottom = req(clips(h, "c"));
    const third = 1.0 / 3.0;
    for (const c of [top, middle, bottom]) {
      expect(approx(c.transform.width * cropVisibleWidthFraction(c.crop), 1.0)).toBe(true);
      expect(approx(c.transform.height * cropVisibleHeightFraction(c.crop), third)).toBe(true);
      expect(approx(c.transform.centerX, 0.5)).toBe(true);
    }
    expect(approx(top.transform.centerY, third * 0.5)).toBe(true);
    expect(approx(middle.transform.centerY, third * 1.5)).toBe(true);
    expect(approx(bottom.transform.centerY, third * 2.5)).toBe(true);
  });

  it("threeStackPlacesNestedTimelines", async () => {
    const h = configured(1920, 1080);
    const children: Timeline[] = [];
    for (const name of ["A", "B", "C"]) {
      const child = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 90 })] })] });
      child.name = name;
      child.width = 1920;
      child.height = 1080;
      h.editor.withoutRegistration(() => {
        h.editor.doc.timelines.push(child);
      });
      children.push(child);
    }
    const r = await h.runRaw("apply_layout", {
      layout: "three_stack", endFrame: 90,
      slots: [
        { slot: "top", mediaRef: children[0].id },
        { slot: "middle", mediaRef: children[1].id },
        { slot: "bottom", mediaRef: children[2].id },
      ],
    });
    expect(r.isError, ToolHarness.textOf(r)).toBe(false);
    const carriers = h.editor.timeline.tracks
      .filter((t) => t.type === "video")
      .flatMap((t) => t.clips)
      .filter((c) => c.mediaType === "sequence");
    expect(carriers.length).toBe(3);
    const third = 1.0 / 3.0;
    children.forEach((child, index) => {
      const c = req(carriers.find((x) => x.mediaRef === child.id));
      expect(approx(c.transform.width * cropVisibleWidthFraction(c.crop), 1.0)).toBe(true);
      expect(approx(c.transform.height * cropVisibleHeightFraction(c.crop), third)).toBe(true);
      expect(approx(c.transform.centerY, third * (index + 0.5))).toBe(true);
    });
  });

  it("threeStackRelayoutsExistingSequenceClips", async () => {
    const h = configured(1920, 1080);
    ["A", "B", "C"].forEach((name, i) => {
      const child = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ start: 0, duration: 60 })] })] });
      child.name = name;
      child.width = 1920;
      child.height = 1080;
      const carrier = makeClip({
        id: `seq-${i}`,
        mediaRef: child.id,
        mediaType: "sequence",
        sourceClipType: "sequence",
        startFrame: 0,
        durationFrames: 60,
      });
      h.editor.withoutRegistration(() => {
        h.editor.doc.timelines.push(child);
        const idx = insertTrack(h.editor, 0, "video");
        h.editor.timeline.tracks[idx].clips = [carrier];
      });
    });
    const r = await h.runRaw("apply_layout", {
      layout: "three_stack",
      slots: [
        { slot: "top", clipIds: ["seq-0"] },
        { slot: "middle", clipIds: ["seq-1"] },
        { slot: "bottom", clipIds: ["seq-2"] },
      ],
    });
    expect(r.isError, ToolHarness.textOf(r)).toBe(false);
    const third = 1.0 / 3.0;
    for (let i = 0; i < 3; i++) {
      const placed = req(clip(h, `seq-${i}`));
      expect(placed.mediaType).toBe("sequence");
      expect(approx(placed.transform.width * cropVisibleWidthFraction(placed.crop), 1.0)).toBe(true);
      expect(approx(placed.transform.height * cropVisibleHeightFraction(placed.crop), third)).toBe(true);
      expect(approx(placed.transform.centerY, third * (i + 0.5))).toBe(true);
      expect(placed.startFrame === 0 && placed.durationFrames === 60).toBe(true);
    }
  });

  it("applyLayoutRejectsEmptyAndCyclicTimelineNests", async () => {
    const h = configured(1920, 1080);
    const empty = Fixtures.timeline();
    h.editor.withoutRegistration(() => {
      h.editor.doc.timelines.push(empty);
    });
    const emptyNest = await h.runRaw("apply_layout", {
      layout: "full", endFrame: 30,
      slots: [{ slot: "main", mediaRef: empty.id }],
    });
    expect(emptyNest.isError).toBe(true);

    const selfNest = await h.runRaw("apply_layout", {
      layout: "full", endFrame: 30,
      slots: [{ slot: "main", mediaRef: h.editor.doc.activeTimelineId }],
    });
    expect(selfNest.isError).toBe(true);
  });

  it("anchorBiasesCropContinuously", async () => {
    const h = configured(1920, 1080);
    for (const id of ["c", "p", "t"]) videoAsset(h, id, 1080, 1920);
    const r = await h.runRaw("apply_layout", {
      layout: "three_up", endFrame: 60,
      slots: [
        { slot: "left", mediaRef: "c" },
        { slot: "center", mediaRef: "p", anchorY: 0.2 },
        { slot: "right", mediaRef: "t", anchor: "top" },
      ],
    });
    expect(r.isError).toBe(false);
    const center = req(clips(h, "c"));
    const partial = req(clips(h, "p"));
    const top = req(clips(h, "t"));
    const total = center.crop.top + center.crop.bottom;
    expect(total).toBeGreaterThan(0.01);
    expect(approx(partial.crop.top, total * 0.2)).toBe(true);
    expect(approx(top.crop.top, 0)).toBe(true);
    expect(top.crop.top < partial.crop.top && partial.crop.top < center.crop.top).toBe(true);
    expect(approx(center.crop.top, center.crop.bottom)).toBe(true);
    expect(approx(transformTopLeft(top.transform).y, 0)).toBe(true);
  });

  it("rejectsInvalidInput", async () => {
    const t = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "cx", mediaRef: "a", start: 0, duration: 30 })] })] });
    const h = new ToolHarness(t);
    videoAsset(h, "a");
    videoAsset(h, "b");
    const bad: [string, Record<string, unknown>][] = [
      ["unknown layout", { layout: "hexagon", endFrame: 30, slots: [{ slot: "left", mediaRef: "a" }] }],
      ["unknown slot", { layout: "side_by_side", endFrame: 30, slots: [{ slot: "left", mediaRef: "a" }, { slot: "mid", mediaRef: "b" }] }],
      ["missing slot", { layout: "side_by_side", endFrame: 30, slots: [{ slot: "left", mediaRef: "a" }] }],
      ["mixed sources", { layout: "side_by_side", endFrame: 30, slots: [{ slot: "left", clipIds: ["cx"] }, { slot: "right", mediaRef: "b" }] }],
      ["no duration", { layout: "side_by_side", slots: [{ slot: "left", mediaRef: "a" }, { slot: "right", mediaRef: "b" }] }],
      ["both source + clip", { layout: "full", endFrame: 30, slots: [{ slot: "main", mediaRef: "a", clipIds: ["cx"] }] }],
      ["invalid anchor", { layout: "full", endFrame: 30, slots: [{ slot: "main", mediaRef: "a", anchor: "diagonal" }] }],
      ["anchor out of range", { layout: "full", endFrame: 30, slots: [{ slot: "main", mediaRef: "a", anchorY: 1.5 }] }],
      ["duplicate clipIds", { layout: "side_by_side", slots: [{ slot: "left", clipIds: ["cx"] }, { slot: "right", clipIds: ["cx"] }] }],
      ["deprecated clipId", { layout: "side_by_side", slots: [{ slot: "left", clipId: "cx" }, { slot: "right", clipIds: ["b"] }] }],
    ];
    for (const [label, args] of bad) {
      const r = await h.runRaw("apply_layout", args);
      expect(r.isError, `expected error for: ${label}`).toBe(true);
    }
  });
});
