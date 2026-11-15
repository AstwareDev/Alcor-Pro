import type { Editor } from "../editor/editor";
import {
  applyEffectPreset, applyTextAnimationPreset, applyTextStylePreset, beginEffectPresetPreview, placeTitlePreset,
  type PresetApplyOptions, type PresetApplyResult,
} from "../editor/mutations/presets";
import type { Preset } from "./presetFormat";

export const titleDragScheme = "alcor-title://";

export function titleDragString(id: string): string {
  return titleDragScheme + id;
}

/** Title ids in a media-drag payload (the media decoder ignores these lines, so both can share one payload). */
export function titleIdsFromPayload(payload: string): string[] {
  return payload.split("\n").filter((l) => l.startsWith(titleDragScheme)).map((l) => l.slice(titleDragScheme.length));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const selection = (editor: Editor): ReadonlySet<string> => editor.ui.selectedClipIds;

/** Applies a preset to the current selection (or places a title). Returns the toast message and any warnings. */
export function applyLibraryPreset(editor: Editor, preset: Preset, options: PresetApplyOptions, frame?: number): { message: string; error: boolean } {
  let result: PresetApplyResult;
  let none: string;
  switch (preset.kind) {
    case "look":
    case "effect":
      result = applyEffectPreset(editor, selection(editor), preset, options);
      none = "Select a video or image clip first.";
      break;
    case "textStyle":
      result = applyTextStylePreset(editor, selection(editor), preset, options);
      none = "Select a text clip first.";
      break;
    case "textAnimation":
      result = applyTextAnimationPreset(editor, selection(editor), preset);
      none = "Select a text clip first.";
      break;
    case "title":
      result = placeTitlePreset(editor, preset, frame === undefined ? {} : { frame });
      none = "Could not add the title.";
      break;
  }
  const warning = result.warnings[0];
  if (result.clipIds.length === 0) return { message: warning ? `${none} (${warning})` : none, error: true };
  const target = preset.kind === "title" ? "added" : `applied to ${plural(result.clipIds.length, "clip")}`;
  return { message: `${preset.name} ${target}${warning ? ` (${warning})` : ""}`, error: false };
}

/** Starts a hover preview of a look/effect on the selection; returns its reverter or undefined when not applicable. */
export function startHoverPreview(editor: Editor, preset: Preset, options: PresetApplyOptions): (() => void) | undefined {
  if (preset.kind !== "look" && preset.kind !== "effect") return undefined;
  if (editor.ui.isPlaying || editor.ui.isScrubbing || selection(editor).size === 0) return undefined;
  return beginEffectPresetPreview(editor, selection(editor), preset, options);
}
