import { deepEqual, setOptional } from "./equality";
import { asObject, decodeEnum, getArray, getDouble, getInt, getWith } from "../util/jsonDecode";
import { cubicBezierEase } from "../util/cubicBezier";
import { clipBlurKeyframeTrack, clipSetBlurKeyframeTrack } from "./clipEffectKeyframes";
import { clipTypeIsVisual } from "./clipType";
import type { Clip, Crop, Track } from "./timeline";
import { clipEndFrame } from "./timeline";

/** `easeIn`/`easeOut`/`easeInOut`/`bezier` are Alcor additions; builds that predate them reject files that use them. */
export const interpolations = ["linear", "hold", "smooth", "easeIn", "easeOut", "easeInOut", "bezier"] as const;
export type Interpolation = (typeof interpolations)[number];

/** Control points `[x1, y1, x2, y2]` of a cubic-bezier easing; x values lie in [0, 1], y may overshoot. */
export type BezierHandles = [number, number, number, number];

/** Named bezier curves (CSS easing keywords). */
export const easePresets = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, BezierHandles>;

export function decodeInterpolation(json: unknown): Interpolation {
  return decodeEnum(json, interpolations, "Interpolation");
}

export interface Keyframe<V> {
  frame: number;
  value: V;
  interpolationOut: Interpolation;
  /** Only meaningful for `interpolationOut === "bezier"`. */
  bezier?: BezierHandles;
}

export function makeKeyframe<V>(frame: number, value: V, interpolationOut: Interpolation = "smooth", bezier?: BezierHandles): Keyframe<V> {
  const kf: Keyframe<V> = { frame, value, interpolationOut };
  if (interpolationOut === "bezier" && bezier) kf.bezier = [bezier[0], bezier[1], bezier[2], bezier[3]];
  return kf;
}

/** Sets the easing on a keyframe in place; `delete`s `bezier` when it no longer applies. */
export function keyframeSetEasing<V>(kf: Keyframe<V>, interpolation: Interpolation, bezier?: BezierHandles): void {
  if (kf.interpolationOut !== interpolation) kf.interpolationOut = interpolation;
  if (interpolation === "bezier" && bezier) {
    const cur = kf.bezier;
    if (!cur || cur[0] !== bezier[0] || cur[1] !== bezier[1] || cur[2] !== bezier[2] || cur[3] !== bezier[3]) {
      kf.bezier = [bezier[0], bezier[1], bezier[2], bezier[3]];
    }
  } else if (kf.bezier) {
    delete kf.bezier;
  }
}

function decodeBezier(json: unknown): BezierHandles | undefined {
  if (!Array.isArray(json) || json.length !== 4) return undefined;
  const [x1, y1, x2, y2] = json as unknown[];
  if (![x1, y1, x2, y2].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return [Math.min(1, Math.max(0, x1 as number)), y1 as number, Math.min(1, Math.max(0, x2 as number)), y2 as number];
}

/** Synthesized Codable: every key is required except `bezier`. Old files (linear/hold/smooth) decode unchanged. */
export function decodeKeyframe<V>(json: unknown, decodeValue: (v: unknown) => V): Keyframe<V> {
  const c = asObject(json, "Keyframe");
  const kf: Keyframe<V> = {
    frame: getInt(c, "frame"),
    value: getWith(c, "value", decodeValue),
    interpolationOut: decodeEnum(c["interpolationOut"], interpolations, "interpolationOut"),
  };
  const bezier = kf.interpolationOut === "bezier" ? decodeBezier(c["bezier"]) : undefined;
  if (bezier) kf.bezier = bezier;
  return kf;
}

export interface KeyframeTrack<V> {
  keyframes: Keyframe<V>[];
}

export function makeKeyframeTrack<V>(keyframes: Keyframe<V>[] = []): KeyframeTrack<V> {
  return { keyframes };
}

export function decodeKeyframeTrack<V>(json: unknown, decodeValue: (v: unknown) => V): KeyframeTrack<V> {
  const c = asObject(json, "KeyframeTrack");
  return { keyframes: getArray(c, "keyframes", (e) => decodeKeyframe(e, decodeValue)) };
}

/** Value-semantics copy (Immer drafts cannot go through structuredClone). Keyframe values are flat. */
export function cloneKeyframeTrack<V>(track: KeyframeTrack<V>): KeyframeTrack<V> {
  return {
    keyframes: track.keyframes.map((k) => {
      const copy: Keyframe<V> = { ...k, value: typeof k.value === "object" && k.value !== null ? { ...k.value } : k.value };
      if (k.bezier) copy.bezier = [k.bezier[0], k.bezier[1], k.bezier[2], k.bezier[3]];
      return copy;
    }),
  };
}

export function keyframeTrackIsActive<V>(track: KeyframeTrack<V>): boolean {
  return track.keyframes.length > 0;
}

export function keyframeTrackUpsert<V>(track: KeyframeTrack<V>, kf: Keyframe<V>): void {
  const i = track.keyframes.findIndex((k) => k.frame === kf.frame);
  if (i >= 0) {
    if (!deepEqual(track.keyframes[i], kf)) track.keyframes[i] = kf;
  } else {
    const found = track.keyframes.findIndex((k) => k.frame > kf.frame);
    track.keyframes.splice(found >= 0 ? found : track.keyframes.length, 0, kf);
  }
}

export function keyframeTrackRemove<V>(track: KeyframeTrack<V>, frame: number): void {
  if (track.keyframes.some((k) => k.frame === frame)) track.keyframes = track.keyframes.filter((k) => k.frame !== frame);
}

export function keyframeTrackMove<V>(track: KeyframeTrack<V>, oldFrame: number, newFrame: number): void {
  const i = track.keyframes.findIndex((k) => k.frame === oldFrame);
  if (i < 0) return;
  if (newFrame !== oldFrame && track.keyframes.some((k) => k.frame === newFrame)) return;
  const [kf] = track.keyframes.splice(i, 1);
  if (kf === undefined) return;
  kf.frame = newFrame;
  keyframeTrackUpsert(track, kf);
}

/** Frames of keyframes inside the inclusive range, via binary search (keyframes are sorted). */
export function keyframeTrackFramesIn<V>(track: KeyframeTrack<V>, lower: number, upper: number): number[] {
  const kfs = track.keyframes;
  let lo = 0;
  let hi = kfs.length;
  while (lo < hi) {
    const mid = Math.trunc((lo + hi) / 2);
    if ((kfs[mid] as Keyframe<V>).frame < lower) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = kfs.length;
  while (lo < hi) {
    const mid = Math.trunc((lo + hi) / 2);
    if ((kfs[mid] as Keyframe<V>).frame <= upper) lo = mid + 1;
    else hi = mid;
  }
  return kfs.slice(start, lo).map((k) => k.frame);
}

export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Eased progress for the segment leaving `kf`, `raw` in [0, 1]. Hold is handled by the caller. Allocation-free. */
export function keyframeEase<V>(kf: Keyframe<V>, raw: number): number {
  switch (kf.interpolationOut) {
    case "linear": return raw;
    case "hold": return 0;
    case "smooth": return smoothstep(raw);
    case "easeIn": return cubicBezierEase(0.42, 0, 1, 1, raw);
    case "easeOut": return cubicBezierEase(0, 0, 0.58, 1, raw);
    case "easeInOut": return cubicBezierEase(0.42, 0, 0.58, 1, raw);
    case "bezier": {
      const h = kf.bezier;
      return h ? cubicBezierEase(h[0], h[1], h[2], h[3], raw) : cubicBezierEase(0.42, 0, 0.58, 1, raw);
    }
  }
}

/** Curve handles an interpolation draws (smooth is approximated by its cubic equivalent); undefined for hold. */
export function interpolationHandles(kf: { interpolationOut: Interpolation; bezier?: BezierHandles }): BezierHandles | undefined {
  switch (kf.interpolationOut) {
    case "linear": return [0, 0, 1, 1];
    case "hold": return undefined;
    case "smooth": return [1 / 3, 0, 2 / 3, 1];
    case "easeIn": case "easeOut": case "easeInOut": return [...easePresets[kf.interpolationOut]];
    case "bezier": return kf.bezier ? [...kf.bezier] : [...easePresets.easeInOut];
  }
}

/** Swift `KeyframeInterpolatable`. */
export interface Interpolator<V> {
  interpolate(a: V, b: V, t: number): V;
}

export const doubleInterpolator: Interpolator<number> = {
  interpolate: (a, b, t) => a + (b - a) * t,
};

/** Two-component keyframe value used for position (x, y) and scale (width, height). */
export interface AnimPair {
  a: number;
  b: number;
}

export function makeAnimPair(a: number, b: number): AnimPair {
  return { a, b };
}

export function decodeAnimPair(json: unknown): AnimPair {
  const c = asObject(json, "AnimPair");
  return { a: getDouble(c, "a"), b: getDouble(c, "b") };
}

export const animPairInterpolator: Interpolator<AnimPair> = {
  interpolate: (from, to, t) => ({
    a: doubleInterpolator.interpolate(from.a, to.a, t),
    b: doubleInterpolator.interpolate(from.b, to.b, t),
  }),
};

export const cropInterpolator: Interpolator<Crop> = {
  interpolate: (a, b, t) => ({
    left: doubleInterpolator.interpolate(a.left, b.left, t),
    top: doubleInterpolator.interpolate(a.top, b.top, t),
    right: doubleInterpolator.interpolate(a.right, b.right, t),
    bottom: doubleInterpolator.interpolate(a.bottom, b.bottom, t),
  }),
};

export function keyframeTrackSample<V>(track: KeyframeTrack<V>, frame: number, fallback: V, interp: Interpolator<V>): V {
  const kfs = track.keyframes;
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (first === undefined || last === undefined) return fallback;
  if (kfs.length === 1) return first.value;
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;

  let bIdx = -1;
  for (let i = 0; i < kfs.length; i++) {
    if ((kfs[i] as Keyframe<V>).frame > frame) { bIdx = i; break; }
  }
  if (bIdx < 0) return last.value;
  const a = kfs[bIdx - 1] as Keyframe<V>;
  const b = kfs[bIdx] as Keyframe<V>;
  if (a.interpolationOut === "hold") return a.value;
  return interp.interpolate(a.value, b.value, keyframeEase(a, (frame - a.frame) / (b.frame - a.frame)));
}

export function keyframeTrackRebased<V>(
  track: KeyframeTrack<V>,
  offset: number,
  fallback: V,
  interp: Interpolator<V>,
): KeyframeTrack<V> | undefined {
  if (!keyframeTrackIsActive(track)) return undefined;
  const boundary = keyframeTrackSample(track, offset, fallback, interp);
  const kfs: Keyframe<V>[] = track.keyframes
    .filter((k) => k.frame >= offset)
    .map((k) => makeKeyframe(k.frame - offset, k.value, k.interpolationOut, k.bezier));
  if (kfs[0]?.frame !== 0) {
    let prev: Keyframe<V> | undefined;
    for (let i = track.keyframes.length - 1; i >= 0; i--) {
      const k = track.keyframes[i] as Keyframe<V>;
      if (k.frame < offset) {
        prev = k;
        break;
      }
    }
    kfs.unshift(makeKeyframe(0, boundary, prev?.interpolationOut ?? "smooth", prev?.bezier));
  }
  return kfs.length === 0 ? undefined : { keyframes: kfs };
}

/** Identifies which clip property an inspector lane / stamp button drives. */
export const animatableProperties = ["opacity", "position", "scale", "rotation", "crop", "blur", "volume"] as const;
export type AnimatableProperty = (typeof animatableProperties)[number];

const propertyDisplayNames: Record<AnimatableProperty, string> = {
  opacity: "Opacity",
  position: "Position",
  scale: "Scale",
  rotation: "Rotation",
  crop: "Crop",
  blur: "Blur",
  volume: "Volume",
};

export function animatablePropertyDisplayName(p: AnimatableProperty): string {
  return propertyDisplayNames[p];
}

export const visualLaneOrder: readonly AnimatableProperty[] = ["position", "scale", "rotation", "opacity", "blur", "crop"];

export function animatablePropertyLanes(track: Track): AnimatableProperty[] {
  if (track.type === "audio") return [];
  return visualLaneOrder.filter((property) => track.clips.some((c) => clipSupportsKeyframes(c, property)));
}

// MARK: - Clip keyframe helpers

export function clipSupportsKeyframes(clip: Clip, property: AnimatableProperty): boolean {
  switch (property) {
    case "volume":
      return clip.mediaType === "audio";
    case "position": case "rotation": case "opacity": case "blur":
      return clipTypeIsVisual(clip.mediaType);
    case "scale":
      switch (clip.mediaType) {
        case "video": case "image": case "lottie": case "sequence": case "text": return true;
        case "audio": case "subtitle": return false;
      }
      return false;
    case "crop":
      switch (clip.mediaType) {
        case "video": case "image": case "lottie": case "sequence": return true;
        case "audio": case "text": case "subtitle": return false;
      }
      return false;
  }
}

type AnyTrack = KeyframeTrack<unknown>;

function trackFor(clip: Clip, property: AnimatableProperty): AnyTrack | undefined {
  switch (property) {
    case "opacity": return clip.opacityTrack;
    case "position": return clip.positionTrack;
    case "scale": return clip.scaleTrack;
    case "rotation": return clip.rotationTrack;
    case "crop": return clip.cropTrack;
    case "blur": return clipBlurKeyframeTrack(clip);
    case "volume": return clip.volumeTrack;
  }
}

export function clipHasActiveKeyframes(clip: Clip, property: AnimatableProperty): boolean {
  return trackFor(clip, property)?.keyframes.length ? true : false;
}

export function clipContainsTimelineFrame(clip: Clip, frame: number): boolean {
  return frame >= clip.startFrame && frame < clipEndFrame(clip);
}

/** Absolute timeline frame → clip-relative offset (used internally in track storage) */
function toOffset(clip: Clip, timelineFrame: number): number {
  return timelineFrame - clip.startFrame;
}

/** Clip-relative offset → absolute timeline frame (used in public API) */
function toAbs(clip: Clip, offset: number): number {
  return clip.startFrame + offset;
}

export function clipKeyframeFrames(clip: Clip, property: AnimatableProperty): number[] {
  const offsets = trackFor(clip, property)?.keyframes.map((k) => k.frame) ?? [];
  return offsets.map((o) => toAbs(clip, o));
}

export function clipKeyframeFramesIntersecting(
  clip: Clip,
  property: AnimatableProperty,
  lowerBound: number,
  upperBound: number,
): number[] {
  const track = trackFor(clip, property);
  const frames = track ? keyframeTrackFramesIn(track, lowerBound - clip.startFrame, upperBound - clip.startFrame) : [];
  return frames.map((o) => toAbs(clip, o));
}

export function clipInterpolation(clip: Clip, property: AnimatableProperty, frame: number): Interpolation | undefined {
  const o = toOffset(clip, frame);
  return trackFor(clip, property)?.keyframes.find((k) => k.frame === o)?.interpolationOut;
}

export type KeyframeTrackKey = "opacityTrack" | "positionTrack" | "scaleTrack" | "rotationTrack" | "cropTrack" | "volumeTrack";

export interface KeyframeTrackValues {
  opacityTrack: number;
  positionTrack: AnimPair;
  scaleTrack: AnimPair;
  rotationTrack: number;
  cropTrack: Crop;
  volumeTrack: number;
}

export function clipUpsertKeyframe<K extends KeyframeTrackKey>(
  clip: Clip,
  key: K,
  frame: number,
  value: KeyframeTrackValues[K],
): void {
  const slots = clip as unknown as Record<KeyframeTrackKey, KeyframeTrack<KeyframeTrackValues[K]> | undefined>;
  const t = slots[key] ?? makeKeyframeTrack<KeyframeTrackValues[K]>();
  // `frame` is an absolute timeline frame; storage is converted to clip-relative.
  const offset = toOffset(clip, frame);
  const prev = t.keyframes.find((k) => k.frame === offset);
  // Editing a value at an existing keyframe keeps its easing.
  keyframeTrackUpsert(t, makeKeyframe(offset, value, prev?.interpolationOut, prev?.bezier));
  setOptional(slots, key, t);
}

const storedTrackKeys: Record<Exclude<AnimatableProperty, "blur">, KeyframeTrackKey> = {
  opacity: "opacityTrack",
  position: "positionTrack",
  scale: "scaleTrack",
  rotation: "rotationTrack",
  crop: "cropTrack",
  volume: "volumeTrack",
};

export function clipRemoveKeyframe(clip: Clip, property: AnimatableProperty, frame: number): void {
  const o = toOffset(clip, frame);
  if (property === "blur") {
    const existing = clipBlurKeyframeTrack(clip);
    const track = existing ? cloneKeyframeTrack(existing) : undefined;
    if (track) keyframeTrackRemove(track, o);
    clipSetBlurKeyframeTrack(clip, track);
    return;
  }
  const key = storedTrackKeys[property];
  const slots = clip as unknown as Record<KeyframeTrackKey, AnyTrack | undefined>;
  const track = slots[key];
  if (track) {
    keyframeTrackRemove(track, o);
    if (track.keyframes.length === 0) setOptional(slots, key, undefined);
  }
}

export function clipSetInterpolation(
  clip: Clip,
  property: AnimatableProperty,
  frame: number,
  interpolation: Interpolation,
  bezier?: BezierHandles,
): void {
  const o = toOffset(clip, frame);
  if (property === "blur") {
    const existing = clipBlurKeyframeTrack(clip);
    const track = existing ? cloneKeyframeTrack(existing) : undefined;
    const kf = track?.keyframes.find((k) => k.frame === o);
    if (track && kf) {
      keyframeSetEasing(kf, interpolation, bezier);
      clipSetBlurKeyframeTrack(clip, track);
    }
    return;
  }
  const kf = trackFor(clip, property)?.keyframes.find((k) => k.frame === o);
  if (kf) keyframeSetEasing(kf, interpolation, bezier);
}

/** The keyframe record at an absolute timeline frame (curve handles included). */
export function clipKeyframeAt(clip: Clip, property: AnimatableProperty, frame: number): Keyframe<unknown> | undefined {
  const o = toOffset(clip, frame);
  return trackFor(clip, property)?.keyframes.find((k) => k.frame === o);
}

export function clipMoveKeyframe(clip: Clip, property: AnimatableProperty, from: number, to: number): void {
  const fromO = toOffset(clip, from);
  const toO = toOffset(clip, to);
  if (property === "blur") {
    const existing = clipBlurKeyframeTrack(clip);
    const track = existing ? cloneKeyframeTrack(existing) : undefined;
    if (track) keyframeTrackMove(track, fromO, toO);
    clipSetBlurKeyframeTrack(clip, track);
    return;
  }
  const track = trackFor(clip, property);
  if (track) keyframeTrackMove(track, fromO, toO);
}
