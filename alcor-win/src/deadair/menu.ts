// Menu / panel actions for dead air: the Swift "Remove Dead Air" context menu (right-click on a red span of an audio
// clip) and the speech-tab "Remove" button. Both go through the same removal as the agent tool.
import type { Editor } from "../editor/editor";
import type { Clip } from "../model";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { allDeadAir, deadAirSpanRange, removeAllDeadAir, removeDeadAirAtFrame } from "./deadAir";
import { deadAirServices, markDeadAir, silenceRemovalSettings } from "./deadAirService";

/** The Swift menu shown instead of the clip menu when the click lands on a dead-air span; undefined otherwise. */
export function deadAirClickMenu(editor: Editor, clip: Clip, clickFrame: number): ContextMenuItem[] | undefined {
  if (clip.mediaType !== "audio" || !markDeadAir()) return undefined;
  if (!deadAirSpanRange(editor, clip, clickFrame, silenceRemovalSettings(), deadAirServices)) return undefined;
  return [
    {
      kind: "item",
      label: "Remove Dead Air",
      onSelect: () => {
        const refusal = removeDeadAirAtFrame(editor, clip.id, clickFrame, silenceRemovalSettings(), deadAirServices);
        if (refusal !== undefined) editor.showToast(refusal, "error");
      },
    },
  ];
}

/** Number of removable dead-air sections on the timeline (speech tab counter). */
export function deadAirSectionCount(editor: Editor): number {
  return allDeadAir(editor, silenceRemovalSettings(), deadAirServices).reduce((n, t) => n + t.ranges.length, 0);
}

/** Speech tab "Remove": ripples all dead air on the timeline as one undo step and reports the outcome. */
export function removeAllDeadAirWithToast(editor: Editor): void {
  const result = removeAllDeadAir(editor, silenceRemovalSettings(), deadAirServices);
  if (!result) {
    editor.showToast("No dead air found. Speech analysis may still be running.");
    return;
  }
  if (result.refusal !== undefined) editor.showToast(result.refusal, "error");
}
