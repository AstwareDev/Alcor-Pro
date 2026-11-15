import { formatTimecode } from "../util/timeFormatting";

// AppTheme.Spacing: xs = 4, sm = 6.
const minorTickHeight = 4;
const minorMidpointTickHeight = 6;
const minorMinSpacing = 6;

/** Choose a tick interval (frames) that keeps major ticks ~80px apart. */
export function tickInterval(pixelsPerFrame: number, fps: number): number {
  const targetPixels = 80.0;
  const rawFrames = targetPixels / pixelsPerFrame;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map((s) => s * fps);
  return candidates.find((c) => c >= rawFrames) ?? (candidates[candidates.length - 1] as number);
}

export function minorSubdivisions(framesPerMajor: number, pixelsPerFrame: number): number {
  const majorPixels = framesPerMajor * pixelsPerFrame;
  for (const divisions of [20, 10, 5, 4, 2]) {
    if (majorPixels / divisions >= minorMinSpacing) return divisions;
  }
  return 0;
}

export interface RulerMajorTick {
  frame: number;
  /** x relative to the ruler rect's left edge. */
  x: number;
  label: string;
}

export interface RulerMinorTick {
  frame: number;
  x: number;
  height: number;
}

export interface RulerTicks {
  major: RulerMajorTick[];
  minor: RulerMinorTick[];
}

/** The tick/label layout `TimelineRuler.draw` renders (the drawing itself is not ported). */
export function computeRulerTicks(width: number, fps: number, pixelsPerFrame: number, scrollOffsetX: number): RulerTicks {
  const ticks: RulerTicks = { major: [], minor: [] };
  if (!(pixelsPerFrame > 0) || !Number.isFinite(pixelsPerFrame)) return ticks;
  const framesPerMajor = tickInterval(pixelsPerFrame, fps);
  if (!(framesPerMajor > 0)) return ticks;

  const startFrame = Math.max(0, Math.trunc(scrollOffsetX / pixelsPerFrame) - framesPerMajor);
  const endFrame = Math.trunc((scrollOffsetX + width) / pixelsPerFrame) + framesPerMajor;

  const minorCount = minorSubdivisions(framesPerMajor, pixelsPerFrame);
  const framesPerMinor = minorCount > 0 ? Math.trunc(framesPerMajor / minorCount) : 0;
  if (framesPerMinor > 0) {
    let minorFrame = Math.trunc(startFrame / framesPerMinor) * framesPerMinor;
    while (minorFrame <= endFrame) {
      if (minorFrame % framesPerMajor !== 0) {
        const localX = minorFrame * pixelsPerFrame - scrollOffsetX;
        if (localX >= 0 && localX <= width) {
          const isMidpoint = minorCount % 2 === 0 && minorFrame % Math.trunc(framesPerMajor / 2) === 0;
          ticks.minor.push({ frame: minorFrame, x: localX, height: isMidpoint ? minorMidpointTickHeight : minorTickHeight });
        }
      }
      minorFrame += framesPerMinor;
    }
  }

  let frame = Math.trunc(startFrame / framesPerMajor) * framesPerMajor;
  while (frame <= endFrame) {
    const localX = frame * pixelsPerFrame - scrollOffsetX;
    if (localX >= 0 && localX <= width) ticks.major.push({ frame, x: localX, label: formatTimecode(frame, fps) });
    frame += framesPerMajor;
  }
  return ticks;
}
