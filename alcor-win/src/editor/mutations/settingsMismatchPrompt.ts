import { createSignal } from "solid-js";
import type { MediaAsset } from "../../model";
import type { Editor } from "../editor";
import { addClipsWithSettingsCheck, applyTimelineSettings, type SettingsMismatch } from "./projectSettings";

// pendingSettingsMismatch / pendingSettingsContinuation of EditorViewModel: the prompt state behind the
// "Clip Settings Mismatch" sheet. One prompt at a time, like the single Swift sheet.

export interface PendingSettingsMismatch {
  editor: Editor;
  mismatch: SettingsMismatch;
  continuation: () => void;
}

const [pending, setPending] = createSignal<PendingSettingsMismatch | null>(null);

export const pendingSettingsMismatch = pending;

/** `addClipsWithSettingsCheck`: runs `operation` now, or after the user answers the mismatch prompt. */
export function addClipsWithSettingsPrompt(editor: Editor, assets: readonly MediaAsset[], operation: () => void): void {
  addClipsWithSettingsCheck(editor, assets, operation, (mismatch, continuation) => setPending({ editor, mismatch, continuation }));
}

/** Resolves the prompt and then runs the pending operation, like `dismiss()` in the Swift view. */
export function answerSettingsMismatch(changeToMatch: boolean): void {
  const current = pending();
  if (!current) return;
  setPending(null);
  if (changeToMatch) {
    const { clipFPS, clipWidth, clipHeight } = current.mismatch;
    applyTimelineSettings(current.editor, clipFPS, clipWidth, clipHeight);
  }
  current.continuation();
}

/** Esc: drops the prompt without placing the clips. */
export function dismissSettingsMismatch(): void {
  setPending(null);
}
