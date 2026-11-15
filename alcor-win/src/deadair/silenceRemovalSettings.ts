// Port of Audio/Analysis/SilenceRemovalSettings.swift: validated settings and the pure silence planner.

/** Swift `Range<Double>`: half-open `[lowerBound, upperBound)`. */
export interface SourceRange {
  lowerBound: number;
  upperBound: number;
}

export const minimumPauseRange = { min: 0.25, max: 3.0 } as const;
export const speechPaddingRange = { min: 0.0, max: 0.5 } as const;

export interface SilenceRemovalSettings {
  readonly minimumPauseSeconds: number;
  readonly speechPaddingSeconds: number;
}

export const defaultSilenceRemovalSettings: SilenceRemovalSettings = Object.freeze({
  minimumPauseSeconds: 0.5,
  speechPaddingSeconds: 0.15,
});

/** Failable `init?(minimumPauseSeconds:speechPaddingSeconds:)`: undefined when non-finite or out of range. */
export function makeSilenceRemovalSettings(minimumPauseSeconds: number, speechPaddingSeconds: number): SilenceRemovalSettings | undefined {
  if (!Number.isFinite(minimumPauseSeconds) || !Number.isFinite(speechPaddingSeconds)) return undefined;
  if (minimumPauseSeconds < minimumPauseRange.min || minimumPauseSeconds > minimumPauseRange.max) return undefined;
  if (speechPaddingSeconds < speechPaddingRange.min || speechPaddingSeconds > speechPaddingRange.max) return undefined;
  return Object.freeze({ minimumPauseSeconds, speechPaddingSeconds });
}

export function silenceRemovalSettingsEqual(a: SilenceRemovalSettings, b: SilenceRemovalSettings): boolean {
  return a.minimumPauseSeconds === b.minimumPauseSeconds && a.speechPaddingSeconds === b.speechPaddingSeconds;
}

/** `VoiceActivity.chunkDuration`: one 32 ms VAD cell (512 samples at 16 kHz). */
export const vadChunkDuration = 512 / 16_000;

function cellCount(seconds: number, cellDuration: number, maximum: number): number {
  const count = Math.ceil(seconds / cellDuration);
  if (!Number.isFinite(count) || count >= maximum) return maximum;
  return Math.max(0, Math.trunc(count));
}

/** `SilenceRemovalPlanner.removableMask`: quiet runs at least `minimumPause` long, trimmed by speech padding on speech-facing sides. */
export function removableMask(
  quietNonSpeechMask: readonly boolean[],
  settings: SilenceRemovalSettings,
  cellDuration: number = vadChunkDuration,
): boolean[] {
  const n = quietNonSpeechMask.length;
  if (n === 0 || !Number.isFinite(cellDuration) || !(cellDuration > 0)) return [];
  const minimumCells = cellCount(settings.minimumPauseSeconds, cellDuration, n + 1);
  const paddingCells = cellCount(settings.speechPaddingSeconds, cellDuration, n);
  const removable = new Array<boolean>(n).fill(false);
  let i = 0;
  while (i < n) {
    if (!quietNonSpeechMask[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && quietNonSpeechMask[j]) j += 1;
    if (j - i >= minimumCells) {
      const start = i + (i > 0 ? paddingCells : 0);
      const end = j - (j < n ? paddingCells : 0);
      if (start < end) for (let cell = start; cell < end; cell++) removable[cell] = true;
    }
    i = j;
  }
  return removable;
}

/** Swift `Range.overlaps` for half-open ranges. */
function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.lowerBound < a.upperBound && b.lowerBound < b.upperBound && a.lowerBound < b.upperBound && b.lowerBound < a.upperBound;
}

function expandingToVisibleEdges(removable: SourceRange, visible: SourceRange, edgePadding: number): SourceRange {
  if (!(edgePadding >= 0)) return removable;
  const start = removable.upperBound > visible.lowerBound && removable.lowerBound <= visible.lowerBound + edgePadding
    ? visible.lowerBound
    : removable.lowerBound;
  const end = removable.lowerBound < visible.upperBound && removable.upperBound >= visible.upperBound - edgePadding
    ? visible.upperBound
    : removable.upperBound;
  return { lowerBound: start, upperBound: end };
}

function visibleRemovableCellRanges(
  mask: readonly boolean[],
  visible: SourceRange,
  settings: SilenceRemovalSettings,
  cellDuration: number,
): SourceRange[] {
  if (mask.length === 0 || visible.lowerBound === visible.upperBound
    || !Number.isFinite(visible.lowerBound) || !Number.isFinite(visible.upperBound)
    || !Number.isFinite(cellDuration) || !(cellDuration > 0)) return [];
  const edgePadding = cellCount(settings.speechPaddingSeconds, cellDuration, mask.length);
  const scanStart = Math.trunc(Math.max(0, Math.min(mask.length, Math.floor(visible.lowerBound - edgePadding))));
  const scanEnd = Math.trunc(Math.max(scanStart, Math.min(mask.length, Math.ceil(visible.upperBound + edgePadding))));
  const ranges: SourceRange[] = [];
  let i = scanStart;
  while (i < scanEnd) {
    if (!mask[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < scanEnd && mask[j]) j += 1;
    const expanded = expandingToVisibleEdges({ lowerBound: i, upperBound: j }, visible, edgePadding);
    if (rangesOverlap(expanded, visible)) {
      const start = Math.max(expanded.lowerBound, visible.lowerBound);
      const end = Math.min(expanded.upperBound, visible.upperBound);
      if (start < end) ranges.push({ lowerBound: start, upperBound: end });
    }
    i = j;
  }
  return ranges;
}

/** Clip-visible removable ranges in source-frame coordinates; the source of truth for both shading and removal. */
export function visibleRemovableRanges(
  removableMaskCells: readonly boolean[],
  visibleSourceRange: SourceRange,
  framesPerSecond: number,
  settings: SilenceRemovalSettings,
  cellDuration: number = vadChunkDuration,
): SourceRange[] {
  const cellFrames = cellDuration * Math.max(1, framesPerSecond);
  if (!Number.isFinite(cellFrames) || !(cellFrames > 0)
    || !Number.isFinite(visibleSourceRange.lowerBound) || !Number.isFinite(visibleSourceRange.upperBound)) return [];
  const visibleCells: SourceRange = {
    lowerBound: visibleSourceRange.lowerBound / cellFrames,
    upperBound: visibleSourceRange.upperBound / cellFrames,
  };
  return visibleRemovableCellRanges(removableMaskCells, visibleCells, settings, cellDuration).map((r) => ({
    lowerBound: r.lowerBound * cellFrames,
    upperBound: r.upperBound * cellFrames,
  }));
}
