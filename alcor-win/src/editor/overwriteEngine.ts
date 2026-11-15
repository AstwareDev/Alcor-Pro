import { clipEndFrame, type Clip } from "../model";
import { newId } from "../util/id";
import { swiftRound } from "../util/math";

export type OverwriteAction =
  | { kind: "remove"; clipId: string }
  | { kind: "trimEnd"; clipId: string; newDuration: number }
  | { kind: "trimStart"; clipId: string; newStartFrame: number; newTrimStart: number; newDuration: number }
  | {
      kind: "split";
      clipId: string;
      leftDuration: number;
      rightId: string;
      rightStartFrame: number;
      rightTrimStart: number;
      rightDuration: number;
    };

/** Actions needed to clear [regionStart, regionEnd) so a new clip can be placed there. */
export function computeOverwrite(clips: readonly Clip[], regionStart: number, regionEnd: number): OverwriteAction[] {
  if (!(regionEnd > regionStart)) return [];
  const actions: OverwriteAction[] = [];

  for (const clip of clips) {
    const cs = clip.startFrame;
    const ce = clipEndFrame(clip);

    if (ce <= regionStart || cs >= regionEnd) continue;

    if (cs >= regionStart && ce <= regionEnd) {
      actions.push({ kind: "remove", clipId: clip.id });
    } else if (cs < regionStart && ce > regionEnd) {
      actions.push({
        kind: "split",
        clipId: clip.id,
        leftDuration: regionStart - cs,
        rightId: newId(),
        rightStartFrame: regionEnd,
        rightTrimStart: clip.trimStartFrame + swiftRound((regionEnd - cs) * clip.speed),
        rightDuration: ce - regionEnd,
      });
    } else if (cs < regionStart) {
      actions.push({ kind: "trimEnd", clipId: clip.id, newDuration: regionStart - cs });
    } else {
      const trimAmount = regionEnd - cs;
      actions.push({
        kind: "trimStart",
        clipId: clip.id,
        newStartFrame: regionEnd,
        newTrimStart: clip.trimStartFrame + swiftRound(trimAmount * clip.speed),
        newDuration: ce - regionEnd,
      });
    }
  }
  return actions;
}
