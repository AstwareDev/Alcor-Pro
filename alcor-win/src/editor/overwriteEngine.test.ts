import { describe, expect, it } from "vitest";
import { computeOverwrite, type OverwriteAction } from "./overwriteEngine";
import { Fixtures } from "./mutations/testFixtures";
import { clipEndFrame, type Clip } from "../model";

const clip = Fixtures.clip;

describe("OverwriteEngine.computeOverwrite", () => {
  it("emptyRegionProducesNoActions", () => {
    const c = clip({ start: 0, duration: 100 });
    expect(computeOverwrite([c], 50, 50)).toEqual([]);
    expect(computeOverwrite([c], 60, 50)).toEqual([]);
  });

  it("noClipsProducesNoActions", () => {
    expect(computeOverwrite([], 0, 100)).toEqual([]);
  });

  it("clipFullyOutsideRegionIsIgnored", () => {
    const before = clip({ id: "before", start: 0, duration: 40 });
    const after = clip({ id: "after", start: 200, duration: 50 });
    expect(computeOverwrite([before, after], 50, 150)).toEqual([]);
  });

  it("clipFullyInsideRegionIsRemoved", () => {
    const c = clip({ id: "c1", start: 60, duration: 40 });
    expect(computeOverwrite([c], 50, 150)).toEqual([{ kind: "remove", clipId: "c1" }]);
  });

  it("clipExactlyMatchingRegionIsRemoved", () => {
    const c = clip({ id: "c1", start: 50, duration: 100 });
    const actions = computeOverwrite([c], 50, 150);
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe("remove");
  });

  it("clipEnvelopingRegionIsSplit", () => {
    const c = clip({ id: "c1", start: 0, duration: 200 });
    const actions = computeOverwrite([c], 50, 150);
    expect(actions.length).toBe(1);
    const a = actions[0];
    if (a.kind !== "split") throw new Error(`expected split, got ${a.kind}`);
    expect(a.clipId).toBe("c1");
    expect(a.leftDuration).toBe(50);
    expect(a.rightStartFrame).toBe(150);
    expect(a.rightTrimStart).toBe(150);
    expect(a.rightDuration).toBe(50);
  });

  it("splitRespectsSpeedAndTrimStart", () => {
    const c = clip({ id: "c1", start: 0, duration: 200, trimStart: 10, speed: 2.0 });
    const a = computeOverwrite([c], 50, 150)[0];
    if (a.kind !== "split") throw new Error("expected split");
    expect(a.leftDuration).toBe(50);
    expect(a.rightStartFrame).toBe(150);
    expect(a.rightTrimStart).toBe(310);
    expect(a.rightDuration).toBe(50);
  });

  it("clipOverlappingLeftEdgeIsTrimEnd", () => {
    const c = clip({ id: "c1", start: 0, duration: 100 });
    expect(computeOverwrite([c], 50, 200)).toEqual([{ kind: "trimEnd", clipId: "c1", newDuration: 50 }]);
  });

  it("clipOverlappingRightEdgeIsTrimStart", () => {
    const c = clip({ id: "c1", start: 50, duration: 100 });
    expect(computeOverwrite([c], 0, 100)).toEqual([
      { kind: "trimStart", clipId: "c1", newStartFrame: 100, newTrimStart: 50, newDuration: 50 },
    ]);
  });

  it("trimStartRespectsSpeedAndTrimStart", () => {
    const c = clip({ id: "c1", start: 50, duration: 100, trimStart: 10, speed: 2.0 });
    const a = computeOverwrite([c], 0, 100)[0];
    if (a.kind !== "trimStart") throw new Error("expected trimStart");
    expect(a.newStartFrame).toBe(100);
    expect(a.newTrimStart).toBe(110);
    expect(a.newDuration).toBe(50);
  });

  it("adjacentEdgesDoNotTrigger", () => {
    const left = clip({ id: "left", start: 0, duration: 50 });
    const right = clip({ id: "right", start: 150, duration: 50 });
    expect(computeOverwrite([left, right], 50, 150)).toEqual([]);
  });

  it("multipleClipsProduceOneActionEach", () => {
    const inside = clip({ id: "inside", start: 60, duration: 30 });
    const leftOverlap = clip({ id: "left", start: 0, duration: 60 });
    const rightOverlap = clip({ id: "right", start: 100, duration: 200 });
    expect(computeOverwrite([inside, leftOverlap, rightOverlap], 50, 150).length).toBe(3);
  });
});

describe("OverwriteEngine - adversarial", () => {
  // Mimics what the editor does with an action sequence.
  function apply(actions: OverwriteAction[], clips: Clip[]): Clip[] {
    let result = clips.map((c) => ({ ...c }));
    for (const action of actions) {
      switch (action.kind) {
        case "remove":
          result = result.filter((c) => c.id !== action.clipId);
          break;
        case "trimEnd": {
          const c = result.find((x) => x.id === action.clipId);
          if (c) c.durationFrames = action.newDuration;
          break;
        }
        case "trimStart": {
          const c = result.find((x) => x.id === action.clipId);
          if (c) {
            c.startFrame = action.newStartFrame;
            c.trimStartFrame = action.newTrimStart;
            c.durationFrames = action.newDuration;
          }
          break;
        }
        case "split": {
          const c = result.find((x) => x.id === action.clipId);
          if (c) {
            const right: Clip = {
              ...c,
              id: action.rightId,
              startFrame: action.rightStartFrame,
              trimStartFrame: action.rightTrimStart,
              durationFrames: action.rightDuration,
            };
            c.durationFrames = action.leftDuration;
            result.push(right);
          }
          break;
        }
      }
    }
    return result.sort((a, b) => a.startFrame - b.startFrame);
  }

  const overlaps = (a: Clip, b: Clip): boolean => a.startFrame < clipEndFrame(b) && b.startFrame < clipEndFrame(a);

  it("actionsClearTheRegionAcrossAllBranches", () => {
    const region = { start: 50, end: 150 };
    const scenarios: [string, Clip[]][] = [
      ["inside", [clip({ id: "x", start: 60, duration: 40 })]],
      ["exactly matching", [clip({ id: "x", start: 50, duration: 100 })]],
      ["overlaps left", [clip({ id: "x", start: 0, duration: 100 })]],
      ["overlaps right", [clip({ id: "x", start: 100, duration: 100 })]],
      ["envelops", [clip({ id: "x", start: 0, duration: 200 })]],
      ["envelop + speed", [clip({ id: "x", start: 0, duration: 200, speed: 2.0 })]],
      ["trimStart non-zero", [clip({ id: "x", start: 0, duration: 200, trimStart: 10 })]],
    ];
    for (const [name, clips] of scenarios) {
      const after = apply(computeOverwrite(clips, region.start, region.end), clips);
      const occupant = after.find((c) => c.startFrame < region.end && clipEndFrame(c) > region.start);
      expect(occupant, `${name}: clip ${occupant?.id ?? "?"} still occupies region`).toBeUndefined();
    }
  });

  it("actionsDoNotProduceOverlappingSurvivors", () => {
    const scenarios: Clip[][] = [
      [clip({ id: "x", start: 0, duration: 200 })],
      [clip({ id: "a", start: 0, duration: 60 }), clip({ id: "b", start: 100, duration: 200 })],
    ];
    for (const clips of scenarios) {
      const after = apply(computeOverwrite(clips, 50, 150), clips);
      for (let i = 0; i < after.length; i++) {
        for (let j = i + 1; j < after.length; j++) expect(overlaps(after[i], after[j])).toBe(false);
      }
    }
  });

  it("adjacentClipAtRegionEndIsNotTouched", () => {
    const after = clip({ id: "b", start: 100, duration: 50 });
    expect(computeOverwrite([after], 50, 100)).toEqual([]);
  });

  it("zeroDurationClipDoesNotCrash", () => {
    const zeroClip = clip({ id: "z", start: 100, duration: 0 });
    expect(() => computeOverwrite([zeroClip], 50, 150)).not.toThrow();
  });
});
