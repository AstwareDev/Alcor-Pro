import { newId } from "../util/id";
import { asObject, getString, getInt, tryEnum } from "../util/jsonDecode";

/** Alcor extension (not in the Swift original): a transition between two adjacent clips on one video track. */
export const transitionKinds = [
  "crossDissolve", "dipToBlack", "dipToWhite",
  "wipeLeft", "wipeRight", "wipeUp", "wipeDown",
  "pushLeft", "pushRight", "pushUp", "pushDown",
  "zoomIn", "blurDissolve", "irisCircle",
] as const;

export type TransitionKind = (typeof transitionKinds)[number];

export const transitionAlignments = ["center", "start", "end"] as const;

/** Where the transition sits relative to the cut: straddling it, starting at it, or ending at it. */
export type TransitionAlignment = (typeof transitionAlignments)[number];

export const transitionDefaultKind: TransitionKind = "crossDissolve";
export const transitionDefaultAlignment: TransitionAlignment = "center";
export const transitionDefaultSeconds = 0.5;

export interface Transition {
  id: string;
  fromClipId: string;
  toClipId: string;
  kind: TransitionKind;
  durationFrames: number;
  alignment: TransitionAlignment;
}

export function makeTransition(p: Partial<Transition> & { fromClipId: string; toClipId: string; durationFrames: number }): Transition {
  return {
    id: p.id ?? newId(),
    fromClipId: p.fromClipId,
    toClipId: p.toClipId,
    kind: p.kind ?? transitionDefaultKind,
    durationFrames: p.durationFrames,
    alignment: p.alignment ?? transitionDefaultAlignment,
  };
}

/** A kind or alignment this build does not know (written by a newer build) decodes to the default instead of failing. */
export function decodeTransition(json: unknown): Transition {
  const c = asObject(json, "Transition");
  return makeTransition({
    id: getString(c, "id"),
    fromClipId: getString(c, "fromClipId"),
    toClipId: getString(c, "toClipId"),
    kind: tryEnum(c, "kind", transitionKinds),
    durationFrames: Math.max(1, getInt(c, "durationFrames")),
    alignment: tryEnum(c, "alignment", transitionAlignments),
  });
}

export const transitionKindLabels: Record<TransitionKind, string> = {
  crossDissolve: "Cross Dissolve",
  dipToBlack: "Dip to Black",
  dipToWhite: "Dip to White",
  wipeLeft: "Wipe Left",
  wipeRight: "Wipe Right",
  wipeUp: "Wipe Up",
  wipeDown: "Wipe Down",
  pushLeft: "Push Left",
  pushRight: "Push Right",
  pushUp: "Push Up",
  pushDown: "Push Down",
  zoomIn: "Zoom In",
  blurDissolve: "Blur Dissolve",
  irisCircle: "Iris",
};

export const transitionAlignmentLabels: Record<TransitionAlignment, string> = {
  center: "Center at Cut",
  start: "Start at Cut",
  end: "End at Cut",
};
