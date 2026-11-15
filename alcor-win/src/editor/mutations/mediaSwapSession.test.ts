import { describe, expect, it } from "vitest";
import { beginMediaSwap, cancelMediaSwap, completeMediaSwap, isAssetCompatibleWithPendingSwap } from "./mediaSwapSession";
import { Fixtures, makeAsset, makeEditor } from "./testFixtures";

function setup() {
  const clip = Fixtures.clip({ id: "c", mediaRef: "a", mediaType: "video", start: 0, duration: 30 });
  const editor = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
  editor.withoutRegistration(() => {
    editor.doc.mediaAssets.push(
      makeAsset({ id: "a", type: "video", duration: 5, hasAudio: false }),
      makeAsset({ id: "b", type: "video", duration: 5, hasAudio: false }),
      makeAsset({ id: "short", type: "video", duration: 0.5, hasAudio: false }),
      makeAsset({ id: "img", type: "image", duration: 5 }),
    );
  });
  return editor;
}

describe("media swap session", () => {
  it("armsTheClipAndFiltersIncompatibleAssets", () => {
    const editor = setup();
    expect(isAssetCompatibleWithPendingSwap(editor, editor.mediaAsset("b")!)).toBe(false);
    beginMediaSwap(editor, "c");
    expect(editor.ui.pendingSwapClipId).toBe("c");
    expect(isAssetCompatibleWithPendingSwap(editor, editor.mediaAsset("b")!)).toBe(true);
    expect(isAssetCompatibleWithPendingSwap(editor, editor.mediaAsset("short")!)).toBe(false);
    expect(isAssetCompatibleWithPendingSwap(editor, editor.mediaAsset("img")!)).toBe(false);
  });

  it("completingSwapsTheSourceAndDisarms", () => {
    const editor = setup();
    beginMediaSwap(editor, "c");
    completeMediaSwap(editor, editor.mediaAsset("b")!);
    expect(editor.clipFor("c")?.mediaRef).toBe("b");
    expect(editor.ui.pendingSwapClipId).toBeNull();
  });

  it("anIncompatibleSourceToastsAndStaysArmed", () => {
    const editor = setup();
    beginMediaSwap(editor, "c");
    completeMediaSwap(editor, editor.mediaAsset("short")!);
    expect(editor.ui.toast?.message).toBe("This source can’t replace the clip.");
    expect(editor.ui.pendingSwapClipId).toBe("c");
    cancelMediaSwap(editor);
    expect(editor.ui.pendingSwapClipId).toBeNull();
  });
});
