import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMediaAsset } from "../../model";
import {
  addClipsWithSettingsPrompt, answerSettingsMismatch, dismissSettingsMismatch, pendingSettingsMismatch,
} from "./settingsMismatchPrompt";
import { Fixtures, makeEditor } from "./testFixtures";

afterEach(() => dismissSettingsMismatch());

function mismatchedEditor() {
  const editor = makeEditor([Fixtures.videoTrack()], { fps: 30 });
  editor.withoutRegistration(() => {
    editor.timeline.settingsConfigured = true;
  });
  const asset = makeMediaAsset({ url: "/a.mp4", type: "video", name: "a", duration: 2 });
  asset.sourceFPS = 24;
  asset.sourceWidth = 1280;
  asset.sourceHeight = 720;
  return { editor, asset };
}

describe("clip settings mismatch prompt", () => {
  it("runsImmediatelyWhenSettingsAgree", () => {
    const { editor, asset } = mismatchedEditor();
    asset.sourceFPS = 30;
    asset.sourceWidth = editor.timeline.width;
    asset.sourceHeight = editor.timeline.height;
    const operation = vi.fn();
    addClipsWithSettingsPrompt(editor, [asset], operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(pendingSettingsMismatch()).toBeNull();
  });

  it("keepCurrentRunsTheOperationWithoutChangingTheTimeline", () => {
    const { editor, asset } = mismatchedEditor();
    const operation = vi.fn();
    addClipsWithSettingsPrompt(editor, [asset], operation);
    expect(operation).not.toHaveBeenCalled();
    expect(pendingSettingsMismatch()?.mismatch).toEqual({ clipFPS: 24, clipWidth: 1280, clipHeight: 720 });
    answerSettingsMismatch(false);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(editor.timeline.fps).toBe(30);
    expect(pendingSettingsMismatch()).toBeNull();
  });

  it("changeToMatchAppliesTheClipSettingsFirst", () => {
    const { editor, asset } = mismatchedEditor();
    let fpsAtRun = 0;
    addClipsWithSettingsPrompt(editor, [asset], () => {
      fpsAtRun = editor.timeline.fps;
    });
    answerSettingsMismatch(true);
    expect([fpsAtRun, editor.timeline.width, editor.timeline.height]).toEqual([24, 1280, 720]);
  });

  it("escapeDropsThePromptWithoutRunning", () => {
    const { editor, asset } = mismatchedEditor();
    const operation = vi.fn();
    addClipsWithSettingsPrompt(editor, [asset], operation);
    dismissSettingsMismatch();
    expect(operation).not.toHaveBeenCalled();
  });
});
