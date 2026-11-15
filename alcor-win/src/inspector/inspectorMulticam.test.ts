import { describe, expect, it } from "vitest";
import { Fixtures } from "../editor/mutations/testFixtures";
import { availableTabs, resolveInspectorSelection, selectedMulticamGroupId } from "./inspectorLogic";

describe("inspector multicam tab", () => {
  const stamped = Fixtures.clip({ id: "v", mediaType: "video", start: 0, duration: 60 });
  stamped.multicamGroupId = "g1";
  const mic = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 60 });
  mic.multicamGroupId = "g2";
  const timeline = Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [stamped] }), Fixtures.audioTrack({ clips: [mic] })] });
  const selection = (ids: string[]) => resolveInspectorSelection(timeline, new Set(ids));

  it("picksTheFirstVisualThenAudioGroupThatStillExists", () => {
    expect(selectedMulticamGroupId(selection(["v", "a"]), () => true)).toBe("g1");
    expect(selectedMulticamGroupId(selection(["v", "a"]), (id) => id === "g2")).toBe("g2");
    expect(selectedMulticamGroupId(selection(["v", "a"]), () => false)).toBeUndefined();
  });

  it("appendsTheMulticamTabAfterTheClipTabs", () => {
    expect(availableTabs(selection(["v", "a"]), "g1")).toEqual(["video", "effects", "audio", "multicam"]);
    expect(availableTabs(selection(["a"]), "g2")).toEqual(["audio", "multicam"]);
    expect(availableTabs(selection(["v"]))).toEqual(["video", "effects"]);
  });
});
