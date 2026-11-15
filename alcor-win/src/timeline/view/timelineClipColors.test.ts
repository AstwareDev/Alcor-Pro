import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  makeTimelineClipColorPalette,
  readableForeground,
  storedTimelineClipColor,
  timelineClipColorDefault,
  timelineClipColorDefaultsKey,
  type ColorStorage,
  type RGB,
} from "./timelineClipColors";

function makeStorage(): ColorStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function expectSameColor(a: RGB, b: RGB): void {
  expect(Math.abs(a.r - b.r)).toBeLessThan(0.001);
  expect(Math.abs(a.g - b.g)).toBeLessThan(0.001);
  expect(Math.abs(a.b - b.b)).toBeLessThan(0.001);
}

describe("Timeline clip colors", () => {
  it("missingOrInvalidPreferenceUsesDefaultColor", () => {
    const storage = makeStorage();
    expectSameColor(storedTimelineClipColor("video", storage), timelineClipColorDefault("video"));
    storage.setItem(timelineClipColorDefaultsKey("video"), JSON.stringify([2, -1, 0.5]));
    expectSameColor(storedTimelineClipColor("video", storage), timelineClipColorDefault("video"));
  });

  it("customColorPersistsAndResetRestoresDefaults", () => {
    const storage = makeStorage();
    const palette = makeTimelineClipColorPalette(storage);
    const custom = { r: 0.12, g: 0.34, b: 0.56 };
    palette.set(custom, "audio");
    expectSameColor(palette.color("audio"), custom);
    expectSameColor(storedTimelineClipColor("audio", storage), custom);
    expect(palette.hasOverrides()).toBe(true);
    palette.resetAll();
    expectSameColor(palette.color("audio"), timelineClipColorDefault("audio"));
    expect(storage.getItem(timelineClipColorDefaultsKey("audio"))).toBeNull();
    expect(palette.hasOverrides()).toBe(false);
  });

  it("colorAccessTracksPaletteChanges", () => {
    const palette = makeTimelineClipColorPalette(makeStorage());
    let runs = 0;
    const dispose = createRoot((d) => {
      createEffect(() => {
        palette.revision();
        runs += 1;
      });
      return d;
    });
    palette.set({ r: 0.8, g: 0.7, b: 0.6 }, "text");
    palette.resetAll();
    expect(runs).toBe(3);
    dispose();
  });

  it("foregroundChoosesTheHigherContrastColor", () => {
    expect(readableForeground({ r: 0, g: 0, b: 0 })).toBe("white");
    expect(readableForeground({ r: 1, g: 1, b: 1 })).toBe("black");
  });
});
