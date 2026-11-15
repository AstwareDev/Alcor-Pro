import { clipTimelineFrame, type Clip } from "../model";
import type { BeatAnalysis } from "./beatInference";

// Tick geometry of ClipRenderer.drawBeatTicks.
export const beatTickWidth = 1;
export const beatTickHeight = 7;
export const downbeatTickHeight = 14;
export const beatTickMinSpacing = 4;
/** Seconds within which a beat coincident with a downbeat renders as the downbeat. */
export const beatDownbeatTolerance = 0.03;

export interface BeatTick {
  /** Pixel x relative to the clip rect's left edge. */
  x: number;
  isDown: boolean;
}

/** False when the clip body is too short for ticks (`body.height > downbeatTickHeight * 2`). */
export const beatTicksFit = (bodyHeight: number): boolean => bodyHeight > downbeatTickHeight * 2;

/**
 * Merges beats and downbeats (a beat close to a downbeat is the downbeat); downbeats always show, beats only where
 * there is room. Beats outside the clip's source window are dropped.
 */
export function planBeatTicks(analysis: BeatAnalysis, clip: Clip, rectWidth: number, fps: number): BeatTick[] {
  if (!(clip.durationFrames > 0) || (analysis.beats.length === 0 && analysis.downbeats.length === 0)) return [];
  const pxPerFrame = rectWidth / clip.durationFrames;
  if (!(pxPerFrame > 0)) return [];
  const ticks: BeatTick[] = [];
  let beatIndex = 0;
  let lastX = Number.NEGATIVE_INFINITY;
  const append = (t: number, isDown: boolean): void => {
    const frame = clipTimelineFrame(clip, t, fps);
    if (frame === undefined) return;
    const x = (frame - clip.startFrame) * pxPerFrame;
    if (!isDown && x - lastX < beatTickMinSpacing) return;
    lastX = x;
    ticks.push({ x, isDown });
  };
  for (const down of analysis.downbeats) {
    while (beatIndex < analysis.beats.length && (analysis.beats[beatIndex] as number) < down - beatDownbeatTolerance) {
      append(analysis.beats[beatIndex] as number, false);
      beatIndex += 1;
    }
    if (beatIndex < analysis.beats.length && Math.abs((analysis.beats[beatIndex] as number) - down) <= beatDownbeatTolerance) beatIndex += 1;
    append(down, true);
  }
  while (beatIndex < analysis.beats.length) {
    append(analysis.beats[beatIndex] as number, false);
    beatIndex += 1;
  }
  return ticks;
}
