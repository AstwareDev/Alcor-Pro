import { mergeRanges, type FrameRange } from "../editor/rippleEngine";

// Port of Transcription/WordCutPlanner.swift.

export type CutAggressiveness = "tight" | "balanced" | "loose";

export const cutAggressivenessValues: readonly CutAggressiveness[] = ["tight", "balanced", "loose"];

export function keptGapMs(a: CutAggressiveness): number {
  switch (a) {
    case "tight": return 60;
    case "balanced": return 150;
    case "loose": return 320;
  }
}

export interface PlannerWord {
  startFrame: number;
  endFrame: number;
  selected: boolean;
}

export function cutRanges(p: { words: readonly PlannerWord[]; clipStart: number; clipEnd: number; keepGapFrames: number }): FrameRange[] {
  const words = p.words.filter((w) => w.endFrame > w.startFrame);
  if (!(p.clipEnd > p.clipStart) || words.length === 0) return [];
  const half = Math.max(0, Math.trunc(p.keepGapFrames / 2));
  const ranges: FrameRange[] = [];
  let k = 0;
  while (k < words.length) {
    if (!words[k].selected) {
      k += 1;
      continue;
    }
    let l = k;
    while (l + 1 < words.length && words[l + 1].selected) l += 1;
    const left = k > 0 ? words[k - 1].endFrame : p.clipStart;
    const right = l + 1 < words.length ? words[l + 1].startFrame : p.clipEnd;
    const runStart = words[k].startFrame;
    const runEnd = words[l].endFrame;
    const keepBefore = Math.min(Math.max(0, runStart - left), half);
    const keepAfter = Math.min(Math.max(0, right - runEnd), half);
    const start = Math.max(p.clipStart, Math.min(left + keepBefore, runStart));
    const end = Math.min(p.clipEnd, Math.max(runEnd, right - keepAfter));
    if (end > start) ranges.push({ start, end });
    k = l + 1;
  }
  return mergeRanges(ranges);
}
