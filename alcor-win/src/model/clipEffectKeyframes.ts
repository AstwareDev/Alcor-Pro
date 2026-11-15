import { deepEqual, setOptional } from "./equality";
import {
  effectInsertIndex, makeEffectParam, makeStaticEffect, type Effect,
} from "./effect";
import {
  cloneKeyframeTrack, doubleInterpolator, keyframeTrackIsActive, keyframeTrackSample, keyframeTrackUpsert, makeKeyframe, makeKeyframeTrack,
  type KeyframeTrack,
} from "./keyframe";
import type { Clip } from "./timeline";
import { makeTextStyle } from "./textStyle";

export const gaussianBlurType = "blur.gaussian";
export const gaussianBlurRadiusKey = "radius";

function gaussianBlurEffect(clip: Clip): Effect | undefined {
  return clip.effects?.find((e) => e.type === gaussianBlurType);
}

export function clipBlurKeyframeTrack(clip: Clip): KeyframeTrack<number> | undefined {
  return gaussianBlurEffect(clip)?.params[gaussianBlurRadiusKey]?.track;
}

export function clipStaticBlurRadius(clip: Clip): number {
  if (clip.mediaType === "text") return clip.textStyle?.blur ?? 0;
  return gaussianBlurEffect(clip)?.params[gaussianBlurRadiusKey]?.value ?? 0;
}

export function clipBlurRadius(clip: Clip, frame: number): number {
  const track = clipBlurKeyframeTrack(clip);
  const fallback = clipStaticBlurRadius(clip);
  return track ? keyframeTrackSample(track, frame - clip.startFrame, fallback, doubleInterpolator) : fallback;
}

export function clipSetStaticBlurRadius(clip: Clip, radiusIn: number): void {
  if (!Number.isFinite(radiusIn)) return;
  const radius = Math.min(100, Math.max(0, radiusIn));
  if (clip.mediaType === "text") {
    const style = clip.textStyle ?? makeTextStyle();
    style.blur = radius;
    setOptional(clip, "textStyle", style);
    return;
  }

  let stack = [...(clip.effects ?? [])];
  const enabled = stack.find((e) => e.type === gaussianBlurType)?.enabled ?? true;
  stack = stack.filter((e) => e.type !== gaussianBlurType);
  if (radius > 0) {
    const effect = makeStaticEffect(gaussianBlurType, { [gaussianBlurRadiusKey]: radius });
    effect.enabled = enabled;
    const old = (clip.effects ?? []).find((e) => e.type === gaussianBlurType);
    if (old && deepEqual({ ...old, id: "" }, { ...effect, id: "" })) effect.id = old.id;
    stack.splice(effectInsertIndex(stack, gaussianBlurType), 0, effect);
  }
  setOptional(clip, "effects", stack.length === 0 ? undefined : stack);
}

export function clipSetBlurKeyframeTrack(clip: Clip, trackIn: KeyframeTrack<number> | undefined): void {
  const track = trackIn !== undefined && keyframeTrackIsActive(trackIn) ? trackIn : undefined;
  const stack = [...(clip.effects ?? [])];
  if (track) {
    let index = stack.findIndex((e) => e.type === gaussianBlurType);
    if (index < 0) {
      index = effectInsertIndex(stack, gaussianBlurType);
      stack.splice(index, 0, makeStaticEffect(gaussianBlurType, { [gaussianBlurRadiusKey]: clipStaticBlurRadius(clip) }));
    }
    const effect = stack[index] as Effect;
    const param = effect.params[gaussianBlurRadiusKey] ?? makeEffectParam({ value: clipStaticBlurRadius(clip) });
    if (clip.mediaType === "text") delete param.value;
    setOptional(param, "track", track);
    setOptional(effect.params, gaussianBlurRadiusKey, param);
  } else {
    const index = stack.findIndex((e) => e.type === gaussianBlurType);
    if (index >= 0) {
      const effect = stack[index] as Effect;
      const param = effect.params[gaussianBlurRadiusKey];
      if (param) delete param.track;
      if (clip.mediaType === "text" || (param?.value ?? 0) === 0) stack.splice(index, 1);
    }
  }
  setOptional(clip, "effects", stack.length === 0 ? undefined : stack);
}

export function clipUpsertBlurKeyframe(clip: Clip, frame: number, value: number): void {
  const existing = clipBlurKeyframeTrack(clip);
  const track = existing ? cloneKeyframeTrack(existing) : makeKeyframeTrack<number>();
  const prev = track.keyframes.find((k) => k.frame === frame - clip.startFrame);
  keyframeTrackUpsert(track, makeKeyframe(frame - clip.startFrame, value, prev?.interpolationOut, prev?.bezier));
  clipSetBlurKeyframeTrack(clip, track);
}
