import { describe, expect, it } from "vitest";
import type { MulticamSyncMap } from "../../model";
import { createMulticamGroup } from "../../editor/mutations/multicam";
import { Fixtures, makeAsset, makeEditor, setup } from "../../editor/mutations/testFixtures";
import { multicamClips } from "../../editor/mutations/multicamRules";
import type { ContextMenuItem } from "../../ui/ContextMenu";
import { multicamClipMenuProviders, multicamMenuSection, switchAngleInRangeItem, syncMenuSection } from "./multicamMenus";

const map = (offsetSeconds: number): MulticamSyncMap => ({ offsetSeconds, confidence: 1, locked: false });
const labels = (items: ContextMenuItem[]): string[] => items.map((i) => (i.kind === "item" ? i.label : "-"));
const sub = (items: ContextMenuItem[], label: string): ContextMenuItem[] => {
  const found = items.find((i) => i.kind === "item" && i.label === label);
  return found && found.kind === "item" ? (found.submenu ?? []) : [];
};

function groupEditor() {
  const e = makeEditor([]);
  setup(e, () => {
    e.doc.mediaAssets.push(
      makeAsset({ id: "camA", type: "video", duration: 120, hasAudio: true }),
      makeAsset({ id: "camB", type: "video", duration: 110, hasAudio: true }),
      makeAsset({ id: "mic1", type: "audio", duration: 130 }),
    );
  });
  const { groupId } = createMulticamGroup(e, {
    specs: [
      { mediaRef: "camA", kind: "angle", angleLabel: "cam-a" },
      { mediaRef: "camB", kind: "angle", angleLabel: "cam-b" },
      { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1" },
    ],
    syncMaps: new Map([["camA", map(0)], ["camB", map(5)], ["mic1", map(2)]]),
    masterRef: "mic1",
    startFrame: 0,
  });
  return { e, groupId };
}

describe("multicam clip menus", () => {
  it("offersSwitchAngleLayoutAndUngroupForProgramClips", () => {
    const { e, groupId } = groupEditor();
    const program = multicamClips(e, groupId).find((c) => c.clip.mediaType === "video")?.clip;
    const items = multicamMenuSection(e, program?.id ?? "");
    expect(labels(items)).toEqual(["Switch Angle", "Layout", "Ungroup Multicam"]);
    const angles = sub(items, "Switch Angle");
    expect(labels(angles)).toEqual(["cam-a", "cam-b"]);
    expect(angles[0].kind === "item" && angles[0].checked).toBe(true);
    expect(labels(sub(items, "Layout"))[0]).toBe("Full Frame");
    angles[1].kind === "item" && angles[1].onSelect?.();
    const refs = multicamClips(e, groupId).filter((c) => c.clip.mediaType === "video").map((c) => c.clip.mediaRef);
    expect(refs).toEqual(["camA", "camB", "camA"]); // cam-b only covers [150, 3450)
  });

  it("micClipsOfferEveryAudioBearerAndNoLayout", () => {
    const { e, groupId } = groupEditor();
    const mic = multicamClips(e, groupId).find((c) => c.clip.mediaType === "audio")?.clip;
    const items = multicamMenuSection(e, mic?.id ?? "");
    expect(labels(items)).toEqual(["Switch Mic", "Ungroup Multicam"]);
    expect(labels(sub(items, "Switch Mic"))).toEqual(["cam-a", "cam-b", "mic-1"]);
    const plain = Fixtures.clip({ id: "plain", start: 0, duration: 10 });
    const e2 = makeEditor([Fixtures.videoTrack({ clips: [plain] })]);
    expect(multicamMenuSection(e2, "plain")).toEqual([]);
  });

  it("syncMenuNeedsTwoSelectedUnits", () => {
    const a = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 60 });
    const b = Fixtures.clip({ id: "b", mediaType: "audio", start: 100, duration: 60 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [a] }), Fixtures.audioTrack({ clips: [b] })]);
    e.ui.selectedClipIds = new Set(["a"]);
    expect(syncMenuSection(e)).toEqual([]);
    e.ui.selectedClipIds = new Set(["a", "b"]);
    const items = syncMenuSection(e);
    expect(labels(items)).toEqual(["Synchronize"]);
    expect(labels(sub(items, "Synchronize"))).toEqual(["Auto", "Audio", "Timecode"]);
    expect(multicamClipMenuProviders(e).length).toBe(2);
  });

  it("switchAngleInRangeNeedsExactlyOneGroupInTheRange", () => {
    const { e } = groupEditor();
    expect(switchAngleInRangeItem(e)).toBeUndefined();
    e.ui.selectedTimelineRange = { startFrame: 600, endFrame: 1200 };
    const item = switchAngleInRangeItem(e);
    expect(item?.kind === "item" ? labels(item.submenu ?? []) : []).toEqual(["cam-a", "cam-b"]);
  });
});
