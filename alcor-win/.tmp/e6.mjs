import { sub } from "./e2lib.mjs";
const f = "src/preview/frameGraph.ts";
sub(f, `import type { MediaAsset } from "../model/mediaAsset";`, `import type { MediaAsset } from "../model/mediaAsset";
import { clipHasSpeedRamp, clipSourceFramesAt, clipSpeedAt } from "../model/speedRamp";`);
sub(f, `  /** Source seconds advanced per timeline second (clip speed after duration clamping). */
  sourceRate: number;
}`, `  /** Source seconds advanced per timeline second (clip speed after duration clamping; instantaneous on speed ramps). */
  sourceRate: number;
  /** Mix the two source frames around \`sourceTime\` (frame blending, slower than 1x). */
  frameBlend?: boolean;
}`);
sub(f, `export function mediaSourceTime(clip: Clip, timing: MediaTiming, frame: number, fps: number): number {
  return timing.sourceStart + ((frame - clip.startFrame) / fps) * timing.rate;
}`, `export function mediaSourceTime(clip: Clip, timing: MediaTiming, frame: number, fps: number): number {
  if (clipHasSpeedRamp(clip)) {
    // The ramp integrates speed; \`timing.rate / clip.speed\` carries any duration clamp.
    return timing.sourceStart + (clipSourceFramesAt(clip, frame - clip.startFrame) / fps) * (timing.rate / clip.speed);
  }
  return timing.sourceStart + ((frame - clip.startFrame) / fps) * timing.rate;
}

/** Source seconds per timeline second at a frame. */
export function mediaSourceRate(clip: Clip, timing: MediaTiming, frame: number): number {
  return clipHasSpeedRamp(clip) ? clipSpeedAt(clip, frame - clip.startFrame) * (timing.rate / clip.speed) : timing.rate;
}`);
sub(f, `    sourceStart: timing.sourceStart,
    sourceRate: timing.rate,
  };
  const natSize = ctx.resolveSourceSize(clip.mediaRef);`, `    sourceStart: timing.sourceStart,
    sourceRate: mediaSourceRate(clip, timing, frame),
  };
  if (clip.frameBlending && layer.sourceRate < 1) layer.frameBlend = true;
  const natSize = ctx.resolveSourceSize(clip.mediaRef);`);
sub(f, `        sourceStart: timing.sourceStart,
        sourceRate: timing.rate,
        gain:`, `        sourceStart: timing.sourceStart,
        sourceRate: mediaSourceRate(clip, timing, frame),
        gain:`);
