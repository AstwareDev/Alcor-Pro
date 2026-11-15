import { newId } from "../util/id";
import { swiftRound } from "../util/math";
import { snapshot } from "../util/snapshot";
import { clipBlurKeyframeTrack, clipSetBlurKeyframeTrack, clipStaticBlurRadius } from "./clipEffectKeyframes";
import {
  animPairInterpolator, cropInterpolator, doubleInterpolator, keyframeTrackIsActive, keyframeTrackRebased,
  keyframeTrackSample, makeAnimPair, makeKeyframe, type AnimPair, type Interpolator, type KeyframeTrack,
} from "./keyframe";
import { clipHasSpeedRamp, clipSourceFramesAt, speedTrackMean } from "./speedRamp";
import { maskPathInterpolator, type Mask, type MaskPath } from "./mask";
import { clipClampFadesToDuration, clipEndFrame, type Clip, type Crop } from "./timeline";

/** Port of `EditorViewModel.splitValues` (EditorViewModel+ClipMutations.swift:149). Pure: accepts drafts, returns detached clips. */
export function splitValues(clipIn: Clip, atFrame: number): { left: Clip; right: Clip } | undefined {
  const clip = snapshot(clipIn);
  if (!(atFrame > clip.startFrame && atFrame < clipEndFrame(clip))) return undefined;
  const splitOffset = atFrame - clip.startFrame;
  const leftSource = swiftRound(clipSourceFramesAt(clip, splitOffset));
  const rightSource = swiftRound(clipSourceFramesAt(clip, clip.durationFrames) - clipSourceFramesAt(clip, splitOffset));

  const left = structuredClone(clip);
  left.durationFrames = splitOffset;
  left.trimEndFrame = clip.trimEndFrame + rightSource;
  left.fadeOutFrames = 0;

  const right = structuredClone(clip);
  right.id = newId();
  right.startFrame = atFrame;
  right.durationFrames = clip.durationFrames - splitOffset;
  right.trimStartFrame = clip.trimStartFrame + leftSource;
  right.fadeInFrames = 0;

  assignSplit(left, right, "opacityTrack", splitKeyframeTrack(clip.opacityTrack, splitOffset, clip.opacity, doubleInterpolator));
  assignSplit(left, right, "volumeTrack", splitKeyframeTrack(clip.volumeTrack, splitOffset, clip.volume, doubleInterpolator));
  if (clipHasSpeedRamp(clip)) {
    assignSplit(left, right, "speedTrack", splitKeyframeTrack(clip.speedTrack, splitOffset, clip.speed, doubleInterpolator));
    left.speed = speedTrackMean(left.speedTrack as KeyframeTrack<number>, left.durationFrames, clip.speed);
    right.speed = speedTrackMean(right.speedTrack as KeyframeTrack<number>, right.durationFrames, clip.speed);
  }
  assignSplit(left, right, "positionTrack", splitKeyframeTrack<AnimPair>(clip.positionTrack, splitOffset, makeAnimPair(0, 0), animPairInterpolator));
  assignSplit(left, right, "scaleTrack", splitKeyframeTrack<AnimPair>(clip.scaleTrack, splitOffset, makeAnimPair(1, 1), animPairInterpolator));
  assignSplit(left, right, "rotationTrack", splitKeyframeTrack(clip.rotationTrack, splitOffset, 0, doubleInterpolator));
  assignSplit(left, right, "cropTrack", splitKeyframeTrack<Crop>(clip.cropTrack, splitOffset, clip.crop, cropInterpolator));
  const blur = splitKeyframeTrack(clipBlurKeyframeTrack(clip), splitOffset, clipStaticBlurRadius(clip), doubleInterpolator);
  clipSetBlurKeyframeTrack(left, blur.left);
  clipSetBlurKeyframeTrack(right, blur.right);
  splitMasks(clip, left, right, splitOffset);
  clipClampFadesToDuration(left);
  clipClampFadesToDuration(right);
  return { left, right };
}

/** Both halves keep the masks; keyframed mask properties are split like the clip's own tracks. The right half gets fresh ids. */
function splitMasks(clip: Clip, left: Clip, right: Clip, splitOffset: number): void {
  const masks = clip.masks;
  if (!masks) return;
  masks.forEach((mask, i) => {
    const l = left.masks?.[i] as Mask;
    const r = right.masks?.[i] as Mask;
    r.id = newId();
    const sides = [
      ["pathTrack", splitKeyframeTrack<MaskPath>(mask.pathTrack, splitOffset, mask.path, maskPathInterpolator)],
      ["featherTrack", splitKeyframeTrack(mask.featherTrack, splitOffset, mask.feather, doubleInterpolator)],
      ["opacityTrack", splitKeyframeTrack(mask.opacityTrack, splitOffset, mask.opacity, doubleInterpolator)],
      ["expansionTrack", splitKeyframeTrack(mask.expansionTrack, splitOffset, mask.expansion, doubleInterpolator)],
    ] as const;
    for (const [key, tracks] of sides) {
      for (const [target, track] of [[l, tracks.left], [r, tracks.right]] as const) {
        if (track === undefined) delete target[key];
        else (target as unknown as Record<string, unknown>)[key] = track;
      }
    }
  });
}

type TrackKey = "speedTrack" | "opacityTrack" | "positionTrack" | "scaleTrack" | "rotationTrack" | "cropTrack" | "volumeTrack";

function assignSplit<V>(
  left: Clip,
  right: Clip,
  key: TrackKey,
  tracks: { left: KeyframeTrack<V> | undefined; right: KeyframeTrack<V> | undefined },
): void {
  const l = left as unknown as Record<TrackKey, KeyframeTrack<V> | undefined>;
  const r = right as unknown as Record<TrackKey, KeyframeTrack<V> | undefined>;
  if (tracks.left === undefined) delete l[key];
  else l[key] = tracks.left;
  if (tracks.right === undefined) delete r[key];
  else r[key] = tracks.right;
}

/** Splits a keyframe track at splitOffset, keeping both sides continuous. Both sides own their data. */
export function splitKeyframeTrack<V>(
  track: KeyframeTrack<V> | undefined,
  splitOffset: number,
  fallback: V,
  interp: Interpolator<V>,
): { left: KeyframeTrack<V> | undefined; right: KeyframeTrack<V> | undefined } {
  if (!track || !keyframeTrackIsActive(track)) {
    return { left: track ? structuredClone(track) : undefined, right: track ? structuredClone(track) : undefined };
  }
  const boundary = keyframeTrackSample(track, splitOffset, fallback, interp);
  const leftKfs = track.keyframes.filter((k) => k.frame <= splitOffset);
  if (leftKfs[leftKfs.length - 1]?.frame !== splitOffset) leftKfs.push(makeKeyframe(splitOffset, boundary));
  const right = keyframeTrackRebased(track, splitOffset, fallback, interp);
  return {
    left: leftKfs.length === 0 ? undefined : structuredClone({ keyframes: leftKfs }),
    right: right ? structuredClone(right) : undefined,
  };
}
