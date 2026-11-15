// Port of Preprocessing/TrimmedSource.swift.

export interface TrimmedSource {
  sourceURL: string;
  trimStartFrame: number;
  trimEndFrame: number;
  sourceFramesConsumed: number;
  fps: number;
}

export function trimmedSourceHasTrim(t: TrimmedSource): boolean {
  return t.trimStartFrame > 0 || t.trimEndFrame > 0;
}

export function trimmedSourceDurationSeconds(t: TrimmedSource): number {
  return t.sourceFramesConsumed / Math.max(1, t.fps);
}

/** Seconds into the source: `[start, start + duration)`. */
export function trimmedSourceTimeRange(t: TrimmedSource): { start: number; duration: number } {
  const timescale = Math.max(1, t.fps);
  return { start: t.trimStartFrame / timescale, duration: t.sourceFramesConsumed / timescale };
}
