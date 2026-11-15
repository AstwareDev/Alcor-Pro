import { clipBlurKeyframeTrack, clipSetBlurKeyframeTrack, clipStaticBlurRadius } from "../model/clipEffectKeyframes";
import type { Size } from "../model/geometry";
import {
  animPairInterpolator, cropInterpolator, doubleInterpolator, keyframeTrackRebased, makeAnimPair,
} from "../model/keyframe";
import {
  clipClampFadesToDuration, clipClampKeyframesToDuration, clipEndFrame, type Clip, type Timeline,
} from "../model/timeline";
import { swiftRound } from "../util/math";

export const nestMaxDepth = 8;

/** Expands a nest carrier one level: child clips remapped into parent frames. */
export interface Flattened {
  /** Child visual tracks, child track order preserved (text clips included). */
  videoTracks: Clip[][];
  /** Unmuted child audio tracks; clips within a track never overlap. */
  audioTracks: Clip[][];
  childCanvas: Size;
}

/** `carrier` = the video `.sequence` clip or its linked audio clip. */
export function nestFlatten(carrier: Clip, child: Timeline, visual: boolean): Flattened {
  const out: Flattened = { videoTracks: [], audioTracks: [], childCanvas: { width: child.width, height: child.height } };
  const lower = carrier.trimStartFrame;
  const upper = carrier.trimStartFrame + carrier.durationFrames;
  const shift = carrier.startFrame - carrier.trimStartFrame;

  for (const track of child.tracks) {
    if (visual) {
      if (track.type !== "video" || track.hidden) continue;
    } else if (track.type !== "audio" || track.muted) {
      continue;
    }
    const clips: Clip[] = [];
    for (const clip of [...track.clips].sort((a, b) => a.startFrame - b.startFrame)) {
      const remapped = remap(clip, lower, upper, shift, carrier.id);
      if (remapped) clips.push(remapped);
    }
    if (clips.length > 0) (visual ? out.videoTracks : out.audioTracks).push(clips);
  }
  return out;
}

function remap(clip: Clip, lower: number, upper: number, shift: number, nestId: string): Clip | undefined {
  const start = Math.max(clip.startFrame, lower);
  const end = Math.min(clipEndFrame(clip), upper);
  if (!(end > start)) return undefined;

  // Deep copy: document clips are frozen and the clamps below write into nested effect params.
  const c = structuredClone(clip);
  const headCut = start - clip.startFrame;
  if (headCut > 0) {
    c.trimStartFrame += swiftRound(headCut * c.speed);
    c.fadeInFrames = 0;
    shiftKeyframeTracks(c, headCut);
  }
  if (end < clipEndFrame(clip)) c.fadeOutFrames = 0;
  c.startFrame = start + shift;
  c.durationFrames = end - start;
  clipClampFadesToDuration(c);
  clipClampKeyframesToDuration(c);
  // Unique per nest instance so the same child nested twice can't collide.
  c.id = `${nestId}/${clip.id}`;
  return c;
}

function shiftKeyframeTracks(clip: Clip, headCut: number): void {
  clip.opacityTrack = clip.opacityTrack && keyframeTrackRebased(clip.opacityTrack, headCut, clip.opacity, doubleInterpolator);
  clip.volumeTrack = clip.volumeTrack && keyframeTrackRebased(clip.volumeTrack, headCut, 0, doubleInterpolator);
  clip.positionTrack =
    clip.positionTrack && keyframeTrackRebased(clip.positionTrack, headCut, makeAnimPair(0, 0), animPairInterpolator);
  clip.scaleTrack = clip.scaleTrack && keyframeTrackRebased(clip.scaleTrack, headCut, makeAnimPair(1, 1), animPairInterpolator);
  clip.rotationTrack = clip.rotationTrack && keyframeTrackRebased(clip.rotationTrack, headCut, 0, doubleInterpolator);
  clip.cropTrack = clip.cropTrack && keyframeTrackRebased(clip.cropTrack, headCut, clip.crop, cropInterpolator);
  const blur = clipBlurKeyframeTrack(clip);
  clipSetBlurKeyframeTrack(clip, blur && keyframeTrackRebased(blur, headCut, clipStaticBlurRadius(clip), doubleInterpolator));
}
