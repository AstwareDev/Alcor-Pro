import { afterEach, describe, expect, it } from "vitest";
import {
  clipDenoiseEffectType,
  makeKeyframe,
  makeKeyframeTrack,
  makeStaticEffect,
  makeTextAnimation,
  makeTextStyle,
} from "../../model";
import { copySelectedClipsToClipboard } from "./clipboard";
import { applyClipSettings, clipSettingsSnapshot, copiedClipSettings } from "./clipSettings";
import { editorHooks } from "./hooks";
import { Fixtures, clipById, makeEditor } from "./testFixtures";

afterEach(() => {
  delete editorHooks.fitTextClipToContentIfNeeded;
});

describe("Clip settings transfer", () => {
  it("textSettingsPreserveContentTimingAndAnimationTracks", () => {
    // Stand-in for text layout: the real hook resizes the target's box to its own content.
    editorHooks.fitTextClipToContentIfNeeded = (_e, clip) => {
      clip.transform.width = 0.4;
      clip.transform.height = 0.1;
      return true;
    };
    const source = Fixtures.clip({ id: "source", mediaRef: "", mediaType: "text", start: 0, duration: 60 });
    source.textContent = "Title";
    source.textStyle = makeTextStyle({ fontName: "Avenir", fontSize: 48, isBold: true });
    source.textAnimation = makeTextAnimation({ preset: "wordSlide" });
    source.textFillMode = "footage";
    source.opacity = 0.65;
    source.transform.centerX = 0.2;
    source.transform.centerY = 0.8;
    source.transform.rotation = -8;
    source.effects = [makeStaticEffect("stylize.invert")];

    const target = Fixtures.clip({ id: "target", mediaRef: "", mediaType: "text", start: 90, duration: 120 });
    target.textContent = "A much longer target title";
    target.wordTimings = [{ text: "A", startFrame: 0, endFrame: 10 }];
    target.captionGroupId = "captions";
    target.opacityTrack = makeKeyframeTrack([makeKeyframe(20, 0.5)]);
    const original = structuredClone(target);

    const editor = makeEditor([Fixtures.videoTrack({ clips: [source, target] })]);
    editor.ui.selectedClipIds = new Set([source.id]);
    copySelectedClipsToClipboard(editor);
    const snapshot = copiedClipSettings(editor, "text");
    if (!snapshot) throw new Error("expected a copied snapshot");
    applyClipSettings(editor, snapshot, [target.id]);
    const updated = clipById(editor, target.id);

    expect(updated.textContent).toEqual(original.textContent);
    expect(updated.wordTimings).toEqual(original.wordTimings);
    expect(updated.captionGroupId).toEqual(original.captionGroupId);
    expect(updated.durationFrames).toEqual(original.durationFrames);
    expect(updated.opacityTrack).toEqual(original.opacityTrack);
    expect(updated.textStyle).toEqual(source.textStyle);
    expect(updated.textAnimation).toEqual(source.textAnimation);
    expect(updated.textFillMode).toEqual(source.textFillMode);
    expect(updated.opacity).toEqual(source.opacity);
    expect(updated.effects).toEqual(source.effects);
    expect(updated.transform.centerX).toEqual(source.transform.centerX);
    expect(updated.transform.centerY).toEqual(source.transform.centerY);
    expect(updated.transform.rotation).toEqual(source.transform.rotation);
    expect(updated.transform.width).toBeLessThan(source.transform.width);
    expect(editor.store.undoActionName).toBe("Paste Clip Settings");
    editor.undo();
    expect(clipById(editor, target.id)).toEqual(original);
    expect(editor.store.canUndo).toBe(false);
  });

  it("audioSettingsCopyVolumeAndEffectsOnly", () => {
    const source = Fixtures.clip({ id: "source", mediaType: "audio", start: 0, duration: 60, volume: 0.35 });
    source.effects = [makeStaticEffect(clipDenoiseEffectType, { amount: 0.75 })];
    const target = Fixtures.clip({ id: "target", mediaType: "audio", start: 70, duration: 30, volume: 1 });
    target.fadeOutFrames = 8;
    target.volumeTrack = makeKeyframeTrack([makeKeyframe(5, -6)]);
    const original = structuredClone(target);

    const editor = makeEditor([Fixtures.audioTrack({ clips: [source, target] })]);
    const snapshot = clipSettingsSnapshot(editor, source.id);
    applyClipSettings(editor, snapshot, [target.id]);
    const updated = clipById(editor, target.id);

    expect(updated.volume).toEqual(source.volume);
    expect(updated.effects).toEqual(source.effects);
    expect(updated.fadeOutFrames).toEqual(original.fadeOutFrames);
    expect(updated.volumeTrack).toEqual(original.volumeTrack);
    expect(updated.startFrame).toEqual(original.startFrame);
    expect(updated.durationFrames).toEqual(original.durationFrames);
  });

  it("applyingToTheSourceOrIdenticalClipsIsANoOpWithoutUndoEntry", () => {
    const source = Fixtures.clip({ id: "source", mediaType: "audio", start: 0, duration: 60, volume: 0.35 });
    const same = Fixtures.clip({ id: "same", mediaType: "audio", start: 70, duration: 30, volume: 0.35 });
    const editor = makeEditor([Fixtures.audioTrack({ clips: [source, same] })]);
    const snapshot = clipSettingsSnapshot(editor, source.id);
    const result = applyClipSettings(editor, snapshot, [source.id, same.id, same.id]);
    expect(result.changedClipIds).toEqual([]);
    expect(result.unchangedClipIds).toEqual(["source", "same"]);
    expect(editor.store.canUndo).toBe(false);
  });

  it("rejectsEmptyMissingAndIncompatibleTargets", () => {
    const source = Fixtures.clip({ id: "source", mediaType: "audio", start: 0, duration: 60 });
    const video = Fixtures.clip({ id: "video", start: 0, duration: 60 });
    const editor = makeEditor([Fixtures.videoTrack({ clips: [video] }), Fixtures.audioTrack({ clips: [source] })]);
    const snapshot = clipSettingsSnapshot(editor, source.id);
    expect(() => applyClipSettings(editor, snapshot, [])).toThrow("Provide at least one target clip.");
    expect(() => applyClipSettings(editor, snapshot, ["ghost"])).toThrow("Clip not found: ghost");
    expect(() => applyClipSettings(editor, snapshot, ["video"])).toThrow(
      "Clip video is video; copied settings require audio clips.",
    );
    expect(editor.store.canUndo).toBe(false);
  });
});
