import { swiftRound } from "../util/math";
import { setOptional } from "./equality";
import {
  cloneKeyframeTrack, keyframeEase, keyframeTrackIsActive, makeKeyframe, makeKeyframeTrack,
  type Interpolation, type Keyframe, type KeyframeTrack,
} from "./keyframe";
import type { Clip } from "./timeline";

/*
 * Time remapping. A clip with `speedTrack` plays at a keyframed speed (clip-relative frame -> source frames per
 * timeline frame). Source position is the integral of that speed, so the clip keeps its timeline length and `clip.speed`
 * holds the ramp's mean: every constant-speed code path (trims, splits, ripple) keeps working on the mean.
 */

export const speedRampRange = { min: 0.05, max: 20 } as const;

const simpsonIntervals = 8;

export function clipHasSpeedRamp(clip: Clip): boolean {
  return clip.speedTrack !== undefined && keyframeTrackIsActive(clip.speedTrack);
}

function clampSpeed(v: number): number {
  return v < speedRampRange.min ? speedRampRange.min : v > speedRampRange.max ? speedRampRange.max : v;
}

function valueIn(a: Keyframe<number>, b: Keyframe<number>, u: number): number {
  if (a.interpolationOut === "hold") return a.value;
  return a.value + (b.value - a.value) * keyframeEase(a, (u - a.frame) / (b.frame - a.frame));
}

/** Instantaneous speed at a (fractional) clip-relative frame. Allocation-free. */
export function speedTrackAt(track: KeyframeTrack<number>, offset: number, fallback: number): number {
  const kfs = track.keyframes;
  const n = kfs.length;
  if (n === 0) return fallback;
  const first = kfs[0] as Keyframe<number>;
  if (n === 1 || offset <= first.frame) return clampSpeed(first.value);
  const last = kfs[n - 1] as Keyframe<number>;
  if (offset >= last.frame) return clampSpeed(last.value);
  for (let i = 1; i < n; i++) {
    const b = kfs[i] as Keyframe<number>;
    if (b.frame > offset) return clampSpeed(valueIn(kfs[i - 1] as Keyframe<number>, b, offset));
  }
  return clampSpeed(last.value);
}

export function clipSpeedAt(clip: Clip, offset: number): number {
  return clip.speedTrack && keyframeTrackIsActive(clip.speedTrack) ? speedTrackAt(clip.speedTrack, offset, clip.speed) : clip.speed;
}

/** Simpson integral of the segment curve over [from, to] inside [a.frame, b.frame]. */
function segmentIntegral(a: Keyframe<number>, b: Keyframe<number>, from: number, to: number): number {
  if (!(to > from)) return 0;
  if (a.interpolationOut === "hold") return clampSpeed(a.value) * (to - from);
  if (a.interpolationOut === "linear") return ((clampSpeed(valueIn(a, b, from)) + clampSpeed(valueIn(a, b, to))) / 2) * (to - from);
  const h = (to - from) / simpsonIntervals;
  let sum = clampSpeed(valueIn(a, b, from)) + clampSpeed(valueIn(a, b, to));
  for (let i = 1; i < simpsonIntervals; i++) sum += (i % 2 === 1 ? 4 : 2) * clampSpeed(valueIn(a, b, from + h * i));
  return (sum * h) / 3;
}

/** Source frames consumed from clip frame 0 up to the (fractional) clip-relative `offset`. Allocation-free. */
export function speedTrackSourceFrames(track: KeyframeTrack<number>, offset: number, fallback: number): number {
  const kfs = track.keyframes;
  const n = kfs.length;
  if (!(offset > 0)) return offset * (n === 0 ? fallback : speedTrackAt(track, 0, fallback));
  if (n === 0) return offset * fallback;
  const first = kfs[0] as Keyframe<number>;
  const last = kfs[n - 1] as Keyframe<number>;
  let total = 0;
  let cursor = 0;
  if (first.frame > 0) {
    const to = Math.min(offset, first.frame);
    total += clampSpeed(first.value) * to;
    cursor = to;
  }
  for (let i = 1; i < n && cursor < offset; i++) {
    const a = kfs[i - 1] as Keyframe<number>;
    const b = kfs[i] as Keyframe<number>;
    if (b.frame <= cursor) continue;
    const from = Math.max(cursor, a.frame);
    const to = Math.min(offset, b.frame);
    total += segmentIntegral(a, b, from, to);
    cursor = to;
  }
  if (cursor < offset) total += clampSpeed(last.value) * (offset - cursor);
  return total;
}

/** Source frames consumed by clip-relative `offset` frames; `offset * speed` for constant-speed clips. */
export function clipSourceFramesAt(clip: Clip, offset: number): number {
  return clip.speedTrack && keyframeTrackIsActive(clip.speedTrack)
    ? speedTrackSourceFrames(clip.speedTrack, offset, clip.speed)
    : offset * clip.speed;
}

/** Mean speed over the clip duration (exact `speed` for constant clips). */
export function speedTrackMean(track: KeyframeTrack<number>, durationFrames: number, fallback: number): number {
  return durationFrames > 0 ? speedTrackSourceFrames(track, durationFrames, fallback) / durationFrames : fallback;
}

// MARK: - Mutation

/** Sets or clears the ramp. The timeline length and total source range stay put; `speed` becomes the new mean. */
export function clipSetSpeedRamp(clip: Clip, track: KeyframeTrack<number> | undefined): void {
  const totalSource = swiftRound(clip.durationFrames * clip.speed) + clip.trimStartFrame + clip.trimEndFrame;
  if (!track || track.keyframes.length === 0) {
    setOptional(clip, "speedTrack", undefined);
    return;
  }
  setOptional(clip, "speedTrack", track);
  const mean = speedTrackMean(track, clip.durationFrames, clip.speed);
  if (clip.speed !== mean) clip.speed = mean;
  const trimEnd = Math.max(0, totalSource - swiftRound(clip.durationFrames * mean) - clip.trimStartFrame);
  if (clip.trimEndFrame !== trimEnd) clip.trimEndFrame = trimEnd;
}

// MARK: - Presets

export interface SpeedRampPreset {
  id: string;
  name: string;
  /** [position 0..1, relative speed, easing out of the point]; scaled so the clip keeps its current mean speed. */
  points: readonly (readonly [number, number, Interpolation])[];
}

export const speedRampPresets: readonly SpeedRampPreset[] = [
  { id: "montage", name: "Montage", points: [[0, 2.2, "easeInOut"], [0.3, 0.35, "linear"], [0.7, 0.35, "easeInOut"], [1, 2.2, "linear"]] },
  { id: "hero", name: "Hero", points: [[0, 1.6, "linear"], [0.2, 1.6, "easeInOut"], [0.4, 0.2, "linear"], [0.7, 0.2, "easeInOut"], [0.85, 1.6, "linear"], [1, 1.6, "linear"]] },
  { id: "bullet", name: "Bullet", points: [[0, 4, "easeOut"], [0.15, 0.06, "linear"], [0.85, 0.06, "easeIn"], [1, 4, "linear"]] },
  { id: "flashIn", name: "Flash in", points: [[0, 8, "easeOut"], [0.35, 1, "linear"], [1, 1, "linear"]] },
  { id: "flashOut", name: "Flash out", points: [[0, 1, "linear"], [0.65, 1, "easeIn"], [1, 8, "linear"]] },
  { id: "smoothSlowMo", name: "Smooth slow-mo", points: [[0, 1, "easeInOut"], [0.35, 0.3, "linear"], [0.65, 0.3, "easeInOut"], [1, 1, "linear"]] },
];

/** Builds a preset ramp for a clip; its mean equals the clip's current speed, so length and source range are kept. */
export function speedRampFromPreset(clip: Clip, preset: SpeedRampPreset): KeyframeTrack<number> {
  const duration = Math.max(1, clip.durationFrames);
  const last = duration - 1;
  const raw = makeKeyframeTrack<number>();
  let prev = -1;
  for (const [pos, speed, interp] of preset.points) {
    const frame = Math.min(last, Math.round(pos * duration));
    if (frame <= prev) continue;
    prev = frame;
    raw.keyframes.push(makeKeyframe(frame, speed, interp));
  }
  if (raw.keyframes.length === 1) raw.keyframes.push(makeKeyframe(Math.max(1, duration), (raw.keyframes[0] as Keyframe<number>).value, "linear"));
  const k = clip.speed / speedTrackMean(raw, duration, 1);
  // Clamping to the speed range moves the mean, so correct the scale once.
  const k2 = (k * clip.speed) / speedTrackMean(scaled(raw, k), duration, 1);
  return scaled(raw, k2);
}

function scaled(track: KeyframeTrack<number>, k: number): KeyframeTrack<number> {
  const out = cloneKeyframeTrack(track);
  for (const kf of out.keyframes) kf.value = clampSpeed(kf.value * k);
  return out;
}

/** Constant-speed retime of a ramped clip: scale the ramp from its pre-edit state so length and shape follow the new speed. */
export function clipRetimeSpeedRamp(target: Clip, basis: Clip, newSpeed: number, newDuration: number): void {
  if (!basis.speedTrack || basis.speedTrack.keyframes.length === 0) return;
  const ratio = newSpeed / basis.speed;
  const frameScale = newDuration / Math.max(1, basis.durationFrames);
  const track = makeKeyframeTrack<number>();
  let prev = -1;
  for (const kf of basis.speedTrack.keyframes) {
    const frame = Math.min(Math.max(0, newDuration - 1), swiftRound(kf.frame * frameScale));
    if (frame <= prev) continue;
    prev = frame;
    track.keyframes.push(makeKeyframe(frame, clampSpeed(kf.value * ratio), kf.interpolationOut, kf.bezier));
  }
  setOptional(target, "speedTrack", track);
}
