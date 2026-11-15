import { setOptional } from "./equality";
import { newId } from "../util/id";
import { clamp, swiftRound } from "../util/math";
import {
  asObject, decodeDouble, getArray, getDouble, getEnum, getInt, getString,
  optBool, optDouble, tryArray, tryBool, tryDouble, tryEnum, tryInt, tryString, tryWith,
} from "../util/jsonDecode";
import { Defaults, TrackSize } from "./constants";
import { clipSetBlurKeyframeTrack, clipBlurKeyframeTrack } from "./clipEffectKeyframes";
import { clipTypes, type ClipType } from "./clipType";
import { decodeBlendMode, type BlendMode } from "./blendMode";
import { decodeEffect, type Effect } from "./effect";
import { decodeMask, masksMapTracks, type Mask } from "./mask";
import {
  animPairInterpolator, cropInterpolator, decodeAnimPair, decodeKeyframeTrack, doubleInterpolator,
  interpolations, keyframeTrackIsActive, keyframeTrackSample, keyframeTrackUpsert, makeAnimPair, makeKeyframeTrack,
  smoothstep, type AnimPair, type Interpolation, type KeyframeTrack,
} from "./keyframe";
import { decodeTextAnimation, decodeWordTiming, type TextAnimation, type WordTiming } from "./textAnimation";
import { decodeTextFillMode, type TextFillMode } from "./textFillMode";
import { decodeTextStyle, makeTextStyle, type TextStyle } from "./textStyle";
import { decodeTimelineMarker, type TimelineMarker } from "./timelineMarker";
import { decodeTransition, type Transition } from "./transition";

/** Clip location inside track storage. */
export interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
}

/** Written on tab switch and save, not live — playhead mutates every frame. */
export interface TimelineViewState {
  playheadFrame: number;
  zoomScale: number;
  scrollOffsetX: number;
}

export function makeTimelineViewState(p: Partial<TimelineViewState> = {}): TimelineViewState {
  return {
    playheadFrame: p.playheadFrame ?? 0,
    zoomScale: p.zoomScale ?? Defaults.pixelsPerFrame,
    scrollOffsetX: p.scrollOffsetX ?? 0,
  };
}

/** Synthesized Codable: every key is required. */
export function decodeTimelineViewState(json: unknown): TimelineViewState {
  const c = asObject(json, "TimelineViewState");
  return {
    playheadFrame: getInt(c, "playheadFrame"),
    zoomScale: getDouble(c, "zoomScale"),
    scrollOffsetX: getDouble(c, "scrollOffsetX"),
  };
}

// MARK: - VolumeScale (defined in InspectorView.swift; needed by Clip)

/** Maps a linear amplitude multiplier to dB for the volume slider. Below the floor we snap to true 0 (hard mute). */
export const VolumeScale = {
  floorDb: -60,
  ceilingDb: 15,
  dbFromLinear(linear: number): number {
    if (!(linear > 0)) return VolumeScale.floorDb;
    return Math.min(VolumeScale.ceilingDb, Math.max(VolumeScale.floorDb, 20 * Math.log10(linear)));
  },
  linearFromDb(db: number): number {
    if (!(db > VolumeScale.floorDb)) return 0;
    return Math.pow(10, Math.min(db, VolumeScale.ceilingDb) / 20);
  },
};

// MARK: - Timeline

export interface Timeline {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  settingsConfigured: boolean;
  folderId?: string;
  tracks: Track[];
  markers: TimelineMarker[];
}

export function makeTimeline(p: Partial<Timeline> = {}): Timeline {
  const t: Timeline = {
    id: p.id ?? newId(),
    name: p.name ?? "Timeline 1",
    fps: p.fps ?? 30,
    width: p.width ?? 1920,
    height: p.height ?? 1080,
    settingsConfigured: p.settingsConfigured ?? false,
    tracks: p.tracks ?? [],
    markers: p.markers ?? [],
  };
  if (p.folderId !== undefined) t.folderId = p.folderId;
  return t;
}

export function decodeTimeline(json: unknown): Timeline {
  const c = asObject(json, "Timeline");
  return makeTimeline({
    id: tryString(c, "id"),
    name: tryString(c, "name"),
    fps: getInt(c, "fps"),
    width: getInt(c, "width"),
    height: getInt(c, "height"),
    settingsConfigured: tryBool(c, "settingsConfigured"),
    folderId: tryString(c, "folderId"),
    tracks: getArray(c, "tracks", decodeTrack),
    markers: tryArray(c, "markers", decodeTimelineMarker),
  });
}

export function timelineTotalFrames(t: Timeline): number {
  let maxFrame = 0;
  for (const track of t.tracks) maxFrame = Math.max(maxFrame, trackEndFrame(track));
  return maxFrame;
}

export function timelineDisplayFrames(t: Timeline): number {
  return t.markers.reduce(
    (result, marker) => Math.max(result, marker.startFrame + Math.max(1, marker.durationFrames)),
    timelineTotalFrames(t),
  );
}

export function timelineHasAudioClips(t: Timeline): boolean {
  return t.tracks.some((track) => track.type === "audio" && track.clips.length > 0);
}

/** Reachable nested timelines, breadth-first, deduped, excluding self and filtered by `include`. */
export function timelineReachableTimelines(
  t: Timeline,
  resolve: (id: string) => Timeline | undefined,
  maxDepth: number = Number.POSITIVE_INFINITY,
  include: (t: Timeline) => boolean = () => true,
): Timeline[] {
  const found: Timeline[] = [];
  const seen = new Set<string>([t.id]);
  const queue: { t: Timeline; depth: number }[] = [{ t, depth: 0 }];
  let i = 0;
  while (i < queue.length) {
    const { t: current, depth } = queue[i] as { t: Timeline; depth: number };
    i += 1;
    if (!(depth < maxDepth)) continue;
    for (const track of current.tracks) {
      for (const clip of track.clips) {
        if (clip.sourceClipType !== "sequence") continue;
        if (seen.has(clip.mediaRef)) continue;
        seen.add(clip.mediaRef);
        const child = resolve(clip.mediaRef);
        if (child === undefined || !include(child)) continue;
        found.push(child);
        queue.push({ t: child, depth: depth + 1 });
      }
    }
  }
  return found;
}

// MARK: - TrackName

export const TrackName = { maximumLength: 80 } as const;

export class TrackNameValidationError extends Error {
  constructor() {
    super("invalid track name");
  }
}

function graphemeCount(s: string): number {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(input: string): Iterable<unknown> };
  }).Segmenter;
  if (Segmenter) {
    let n = 0;
    for (const _ of new Segmenter(undefined, { granularity: "grapheme" }).segment(s)) n += 1;
    return n;
  }
  return Array.from(s).length;
}

/** Throws `TrackNameValidationError`; returns undefined for nil/blank names. */
export function trackNameNormalized(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, "");
  if (/[\p{Cc}\n\r\v\f\u0085\u2028\u2029]/u.test(rawValue) || graphemeCount(value) > TrackName.maximumLength) {
    throw new TrackNameValidationError();
  }
  return value === "" ? undefined : value;
}

// MARK: - Track

export interface Track {
  id: string;
  type: ClipType;
  name?: string;
  muted: boolean;
  hidden: boolean;
  syncLocked: boolean;
  clips: Clip[];
  displayHeight: number;
  /** Transitions between adjacent clips on this track. Omitted when empty; older builds ignore the key. */
  transitions?: Transition[];
}

export function makeTrack(p: Partial<Track> & { type: ClipType }): Track {
  const t: Track = {
    id: p.id ?? newId(),
    type: p.type,
    muted: p.muted ?? false,
    hidden: p.hidden ?? false,
    syncLocked: p.syncLocked ?? true,
    clips: p.clips ?? [],
    displayHeight: p.displayHeight ?? TrackSize.defaultHeight,
  };
  if (p.name !== undefined) t.name = p.name;
  if (p.transitions !== undefined && p.transitions.length > 0) t.transitions = p.transitions;
  return t;
}

export function decodeTrack(json: unknown): Track {
  const c = asObject(json, "Track");
  const decodedName = tryString(c, "name");
  let name: string | undefined;
  try {
    name = trackNameNormalized(decodedName);
  } catch (e) {
    if (!(e instanceof TrackNameValidationError)) throw e;
  }
  const displayHeight = tryDouble(c, "displayHeight");
  return makeTrack({
    id: tryString(c, "id"),
    type: getEnum(c, "type", clipTypes),
    name,
    muted: tryBool(c, "muted"),
    hidden: tryBool(c, "hidden"),
    syncLocked: tryBool(c, "syncLocked"),
    clips: tryArray(c, "clips", decodeClip),
    displayHeight: displayHeight === undefined ? undefined : clamp(displayHeight, TrackSize.minHeight, TrackSize.maxHeight),
    transitions: tryArray(c, "transitions", decodeTransition),
  });
}

export function trackEndFrame(track: Track): number {
  let maxFrame = 0;
  for (const clip of track.clips) maxFrame = Math.max(maxFrame, clipEndFrame(clip));
  return maxFrame;
}

/** Returns IDs of clips forming a contiguous chain starting at `fromEnd`, excluding `excludeId`. */
export function trackContiguousClipIds(track: Track, fromEnd: number, excludeId: string): Set<string> {
  const ids = new Set<string>();
  let chainEnd = fromEnd;
  const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
  for (const c of sorted) {
    if (c.id === excludeId || c.startFrame < fromEnd) continue;
    if (c.startFrame !== chainEnd) break;
    chainEnd = clipEndFrame(c);
    ids.add(c.id);
  }
  return ids;
}

// MARK: - Clip

export interface Clip {
  id: string;
  mediaRef: string;
  mediaType: ClipType;
  /** Original media type for derived clips; used for color-coding. */
  sourceClipType: ClipType;
  startFrame: number;
  durationFrames: number;
  trimStartFrame: number;
  trimEndFrame: number;
  speed: number;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  fadeInInterpolation: Interpolation;
  fadeOutInterpolation: Interpolation;
  opacity: number;
  transform: Transform;
  crop: Crop;
  edgeRounding: number;
  edgeSoftness: number;
  linkGroupId?: string;
  captionGroupId?: string;
  multicamGroupId?: string;

  // Text clips only.
  textContent?: string;
  textStyle?: TextStyle;
  textAnimation?: TextAnimation;
  wordTimings?: WordTiming[];
  textFillMode?: TextFillMode;

  // Keyframe tracks for each animatable property. Undefined when no animation exists.
  opacityTrack?: KeyframeTrack<number>;
  positionTrack?: KeyframeTrack<AnimPair>;
  scaleTrack?: KeyframeTrack<AnimPair>;
  rotationTrack?: KeyframeTrack<number>;
  cropTrack?: KeyframeTrack<Crop>;
  volumeTrack?: KeyframeTrack<number>;

  /** Speed ramp: speed multiplier keyframes (clip-relative frames). `speed` then holds the ramp's mean. */
  speedTrack?: KeyframeTrack<number>;
  /** Mix adjacent source frames when playing slower than 1x (export). */
  frameBlending?: boolean;

  effects?: Effect[];

  /** How this clip composites over the tracks below it. undefined = normal (source-over). */
  blendMode?: BlendMode;

  /** After Effects-style masks, applied bottom to top. Omitted when empty. */
  masks?: Mask[];

  /**
   * Adjustment layer (Alcor extension): no media; its effects, opacity and masks apply to the composite of the tracks
   * below it. Stored as an empty text clip so older builds draw nothing for it.
   */
  adjustment?: boolean;
}

export function makeClip(p: Partial<Clip> & { mediaRef: string; startFrame: number; durationFrames: number }): Clip {
  const { mediaRef, startFrame, durationFrames, ...rest } = p;
  const clip: Clip = {
    id: rest.id ?? newId(),
    mediaRef,
    mediaType: rest.mediaType ?? "video",
    sourceClipType: rest.sourceClipType ?? "video",
    startFrame,
    durationFrames,
    trimStartFrame: rest.trimStartFrame ?? 0,
    trimEndFrame: rest.trimEndFrame ?? 0,
    speed: rest.speed ?? 1.0,
    volume: rest.volume ?? 1.0,
    fadeInFrames: rest.fadeInFrames ?? 0,
    fadeOutFrames: rest.fadeOutFrames ?? 0,
    fadeInInterpolation: rest.fadeInInterpolation ?? "linear",
    fadeOutInterpolation: rest.fadeOutInterpolation ?? "linear",
    opacity: rest.opacity ?? 1.0,
    transform: rest.transform ?? makeTransform(),
    crop: rest.crop ?? makeCrop(),
    edgeRounding: rest.edgeRounding ?? 0,
    edgeSoftness: rest.edgeSoftness ?? 0,
  };
  const optionalKeys = [
    "linkGroupId", "captionGroupId", "multicamGroupId", "textContent", "textStyle", "textAnimation", "wordTimings",
    "textFillMode", "opacityTrack", "positionTrack", "scaleTrack", "rotationTrack", "cropTrack", "volumeTrack",
    "speedTrack", "frameBlending", "effects", "blendMode", "masks", "adjustment",
  ] as const;
  const target = clip as unknown as Record<string, unknown>;
  for (const k of optionalKeys) if (rest[k] !== undefined) target[k] = rest[k];
  if (clip.masks?.length === 0) delete clip.masks;
  return clip;
}

/** Frame where this clip ends on the timeline */
export function clipEndFrame(clip: Clip): number {
  return clip.startFrame + clip.durationFrames;
}

export function clipSupportsRetiming(clip: Clip): boolean {
  return clip.sourceClipType !== "sequence";
}

/** Source frames consumed by the visible portion */
export function clipSourceFramesConsumed(clip: Clip): number {
  return swiftRound(clip.durationFrames * clip.speed);
}

/** Total source frames the clip references, including both trims. */
export function clipSourceDurationFrames(clip: Clip): number {
  return clipSourceFramesConsumed(clip) + clip.trimStartFrame + clip.trimEndFrame;
}

/** Convert an absolute timeline frame to the clip-relative offset used by track storage. */
function keyframeOffset(clip: Clip, frame: number): number {
  return frame - clip.startFrame;
}

export function clipOpacityAt(clip: Clip, frame: number): number {
  const base = clipRawOpacityAt(clip, frame);
  if (clip.mediaType === "audio" || !(clip.fadeInFrames > 0 || clip.fadeOutFrames > 0)) return base;
  return base * clipFadeMultiplier(clip, frame);
}

/** Authored opacity without the fade envelope */
export function clipRawOpacityAt(clip: Clip, frame: number): number {
  return clip.opacityTrack
    ? keyframeTrackSample(clip.opacityTrack, keyframeOffset(clip, frame), clip.opacity, doubleInterpolator)
    : clip.opacity;
}

export function clipRotationAt(clip: Clip, frame: number): number {
  return clip.rotationTrack
    ? keyframeTrackSample(clip.rotationTrack, keyframeOffset(clip, frame), clip.transform.rotation, doubleInterpolator)
    : clip.transform.rotation;
}

/** Sampled topLeft (normalized canvas space) at `frame` */
export function clipTopLeftAt(clip: Clip, frame: number): { x: number; y: number } {
  const track = clip.positionTrack;
  if (track && keyframeTrackIsActive(track)) {
    const p = keyframeTrackSample(track, keyframeOffset(clip, frame), makeAnimPair(0, 0), animPairInterpolator);
    return { x: p.a, y: p.b };
  }
  const c = transformCenter(clip.transform);
  const sz = clipSizeAt(clip, frame);
  return { x: c.x - sz.width / 2, y: c.y - sz.height / 2 };
}

/** Sampled (width, height) at `frame` */
export function clipSizeAt(clip: Clip, frame: number): { width: number; height: number } {
  const fallback = makeAnimPair(clip.transform.width, clip.transform.height);
  const s = clip.scaleTrack
    ? keyframeTrackSample(clip.scaleTrack, keyframeOffset(clip, frame), fallback, animPairInterpolator)
    : fallback;
  return { width: s.a, height: s.b };
}

export function clipTextScaleAt(clip: Clip, frame: number): number {
  const baseScale = clip.textStyle?.fontScale ?? makeTextStyle().fontScale;
  if (clip.mediaType !== "text") return baseScale;
  const t = clip.transform;
  if (
    !(Number.isFinite(baseScale) && baseScale > 0) ||
    !(Number.isFinite(t.width) && t.width > 0) ||
    !(Number.isFinite(t.height) && t.height > 0)
  ) {
    return makeTextStyle().fontScale;
  }
  const size = clipSizeAt(clip, frame);
  const widthRatio = size.width / t.width;
  const heightRatio = size.height / t.height;
  if (!(Number.isFinite(widthRatio) && widthRatio > 0) || !(Number.isFinite(heightRatio) && heightRatio > 0)) {
    return baseScale;
  }
  return baseScale * Math.min(widthRatio, heightRatio);
}

export function clipTextStyleAt(clip: Clip, frame: number): TextStyle {
  const base = clip.textStyle ?? makeTextStyle();
  const style: TextStyle = {
    ...base,
    color: { ...base.color },
    shadow: { ...base.shadow, color: { ...base.shadow.color } },
    background: { ...base.background, color: { ...base.background.color }, outlineColor: { ...base.background.outlineColor } },
    border: { ...base.border, color: { ...base.border.color } },
  };
  style.fontScale = clipTextScaleAt(clip, frame);
  return style;
}

/** Resolve the full Transform at `frame` */
export function clipTransformAt(clip: Clip, frame: number): Transform {
  const tl = clipTopLeftAt(clip, frame);
  const sz = clipSizeAt(clip, frame);
  const t = { ...clip.transform };
  t.centerX = tl.x + sz.width / 2;
  t.centerY = tl.y + sz.height / 2;
  t.width = sz.width;
  t.height = sz.height;
  t.rotation = clipRotationAt(clip, frame);
  return t;
}

export function clipHasTransformAnimation(clip: Clip): boolean {
  return (
    (clip.positionTrack ? keyframeTrackIsActive(clip.positionTrack) : false) ||
    (clip.scaleTrack ? keyframeTrackIsActive(clip.scaleTrack) : false) ||
    (clip.rotationTrack ? keyframeTrackIsActive(clip.rotationTrack) : false)
  );
}

export function clipCropAt(clip: Clip, frame: number): Crop {
  return clip.cropTrack
    ? keyframeTrackSample(clip.cropTrack, keyframeOffset(clip, frame), clip.crop, cropInterpolator)
    : clip.crop;
}

export function clipLiveVolumeKfDb(clip: Clip, frame: number): number | undefined {
  const track = clip.volumeTrack;
  if (!(frame >= clip.startFrame && frame < clipEndFrame(clip)) || !track || !keyframeTrackIsActive(track)) return undefined;
  return keyframeTrackSample(track, frame - clip.startFrame, 0, doubleInterpolator);
}

/** Effective linear volume at `frame`: keyframe envelope first, fade ramp on top, static volume as outer gain. */
export function clipVolumeAt(clip: Clip, frame: number): number {
  return clipRawVolumeAt(clip, frame) * clipFadeMultiplier(clip, frame);
}

export const clipDenoiseEffectType = "audio.denoise";
export const clipDefaultDenoiseAmount = 0.6;

export function clipHasDenoiseEnabled(clip: Clip): boolean {
  return clip.effects?.some((e) => e.type === clipDenoiseEffectType && e.enabled) ?? false;
}

export function clipDenoiseAmount(clip: Clip): number {
  return clip.effects?.find((e) => e.type === clipDenoiseEffectType)?.params["amount"]?.value ?? clipDefaultDenoiseAmount;
}

export function clipRawVolumeAt(clip: Clip, frame: number): number {
  let kfGain = 1.0;
  const track = clip.volumeTrack;
  if (track && keyframeTrackIsActive(track)) {
    kfGain = VolumeScale.linearFromDb(keyframeTrackSample(track, keyframeOffset(clip, frame), 0, doubleInterpolator));
  }
  return clip.volume * kfGain;
}

/** 0…1 envelope from the fade head/tail ramps. */
export function clipFadeMultiplier(clip: Clip, frame: number): number {
  const rel = frame - clip.startFrame;
  if (!(rel >= 0 && rel <= clip.durationFrames)) return 0;
  let inMul = 1.0;
  if (clip.fadeInFrames > 0) {
    const t = Math.min(1.0, rel / clip.fadeInFrames);
    inMul = clip.fadeInInterpolation === "smooth" ? smoothstep(t) : t;
  }
  const outRem = clip.durationFrames - rel;
  let outMul = 1.0;
  if (clip.fadeOutFrames > 0) {
    const t = Math.min(1.0, outRem / clip.fadeOutFrames);
    outMul = clip.fadeOutInterpolation === "smooth" ? smoothstep(t) : t;
  }
  return Math.min(inMul, outMul);
}

/** Source-seconds → project-timeline-frame through this clip's placement, trim, and speed. */
export function clipTimelineFrame(clip: Clip, sourceSeconds: number, fps: number): number | undefined {
  const sourceFrame = sourceSeconds * fps;
  const offsetFromTrim = sourceFrame - clip.trimStartFrame;
  if (!(offsetFromTrim >= 0)) return undefined;
  const frame = swiftRound(clip.startFrame + offsetFromTrim / Math.max(clip.speed, 0.0001));
  if (!(frame >= clip.startFrame && frame < clipEndFrame(clip))) return undefined;
  return frame;
}

export type FadeEdge = "left" | "right";

/** Fresh clip id; link/caption group ids remapped consistently via `groups`. */
export function clipFreshenIds(clip: Clip, groups: Map<string, string>): void {
  const remap = (old: string | undefined): string | undefined => {
    if (old === undefined) return undefined;
    const existing = groups.get(old);
    if (existing !== undefined) return existing;
    const fresh = newId();
    groups.set(old, fresh);
    return fresh;
  };
  clip.id = newId();
  for (const mask of clip.masks ?? []) mask.id = newId();
  setOptional(clip, "linkGroupId", remap(clip.linkGroupId));
  setOptional(clip, "captionGroupId", remap(clip.captionGroupId));
}

function sameTrack<V>(a: KeyframeTrack<V>, b: KeyframeTrack<V>): boolean {
  return JSON.stringify(a.keyframes) === JSON.stringify(b.keyframes);
}

function clampedKeyframeTrack<V>(clip: Clip, track: KeyframeTrack<V> | undefined): KeyframeTrack<V> | undefined {
  if (!track) return undefined;
  const normalized = makeKeyframeTrack<V>();
  for (const kf of track.keyframes) {
    if (!(kf.frame >= 0 && kf.frame <= clip.durationFrames)) continue;
    const next = { ...kf };
    next.frame = Math.min(next.frame, Math.max(0, clip.durationFrames - 1));
    keyframeTrackUpsert(normalized, next);
  }
  if (normalized.keyframes.length === 0) return undefined;
  return sameTrack(track, normalized) ? track : { ...track, keyframes: normalized.keyframes };
}

function rescaledKeyframeTrack<V>(clip: Clip, track: KeyframeTrack<V> | undefined, scale: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined;
  if (!(Number.isFinite(scale) && scale > 0)) return track;
  const normalized = makeKeyframeTrack<V>();
  for (const kf of track.keyframes) {
    const next = { ...kf };
    next.frame = Math.min(Math.max(0, clip.durationFrames - 1), swiftRound(kf.frame * scale));
    keyframeTrackUpsert(normalized, next);
  }
  if (normalized.keyframes.length === 0) return undefined;
  return sameTrack(track, normalized) ? track : normalized;
}

/** Normalizes the boundary keyframe and drops keyframes beyond the clip. */
export function clipClampKeyframesToDuration(clip: Clip): void {
  setOptional(clip, "opacityTrack", clampedKeyframeTrack(clip, clip.opacityTrack));
  setOptional(clip, "positionTrack", clampedKeyframeTrack(clip, clip.positionTrack));
  setOptional(clip, "scaleTrack", clampedKeyframeTrack(clip, clip.scaleTrack));
  setOptional(clip, "rotationTrack", clampedKeyframeTrack(clip, clip.rotationTrack));
  setOptional(clip, "cropTrack", clampedKeyframeTrack(clip, clip.cropTrack));
  setOptional(clip, "volumeTrack", clampedKeyframeTrack(clip, clip.volumeTrack));
  setOptional(clip, "speedTrack", clampedKeyframeTrack(clip, clip.speedTrack));
  clipSetBlurKeyframeTrack(clip, clampedKeyframeTrack(clip, clipBlurKeyframeTrack(clip)));
  masksMapTracks(clip.masks, (track) => clampedKeyframeTrack(clip, track));
}

export function clipRescaleKeyframes(clip: Clip, scale: number): void {
  setOptional(clip, "opacityTrack", rescaledKeyframeTrack(clip, clip.opacityTrack, scale));
  setOptional(clip, "positionTrack", rescaledKeyframeTrack(clip, clip.positionTrack, scale));
  setOptional(clip, "scaleTrack", rescaledKeyframeTrack(clip, clip.scaleTrack, scale));
  setOptional(clip, "rotationTrack", rescaledKeyframeTrack(clip, clip.rotationTrack, scale));
  setOptional(clip, "cropTrack", rescaledKeyframeTrack(clip, clip.cropTrack, scale));
  setOptional(clip, "volumeTrack", rescaledKeyframeTrack(clip, clip.volumeTrack, scale));
  setOptional(clip, "speedTrack", rescaledKeyframeTrack(clip, clip.speedTrack, scale));
  clipSetBlurKeyframeTrack(clip, rescaledKeyframeTrack(clip, clipBlurKeyframeTrack(clip), scale));
  masksMapTracks(clip.masks, (track) => rescaledKeyframeTrack(clip, track, scale));
}

/** Clamp fade ramps so head + tail can't exceed the clip's duration. */
export function clipClampFadesToDuration(clip: Clip): void {
  clip.fadeInFrames = Math.max(0, Math.min(clip.fadeInFrames, clip.durationFrames));
  clip.fadeOutFrames = Math.max(0, Math.min(clip.fadeOutFrames, clip.durationFrames - clip.fadeInFrames));
}

export function clipRescaleWordTimings(clip: Clip, oldDuration: number): void {
  const timings = clip.wordTimings;
  if (clip.mediaType !== "text" || !timings || !(oldDuration > 0) || !(clip.durationFrames > 0)) return;
  const scale = clip.durationFrames / oldDuration;
  const d = clip.durationFrames;
  setOptional(clip, "wordTimings", timings.map((timing) => {
    const start = Math.min(Math.max(0, swiftRound(timing.startFrame * scale)), Math.max(0, d - 1));
    const end = Math.min(Math.max(start + 1, swiftRound(timing.endFrame * scale)), d);
    return { text: timing.text, startFrame: start, endFrame: end };
  }));
}

/** Set the fade length for one edge and clamp to fit. */
export function clipSetFade(clip: Clip, edge: FadeEdge, frames: number): void {
  const v = Math.max(0, frames);
  if (edge === "left") clip.fadeInFrames = v;
  else clip.fadeOutFrames = v;
  clipClampFadesToDuration(clip);
}

export function clipSetFadeInterpolation(clip: Clip, edge: FadeEdge, interpolation: Interpolation): void {
  if (edge === "left") clip.fadeInInterpolation = interpolation;
  else clip.fadeOutInterpolation = interpolation;
}

export function clipFadeFrames(clip: Clip, edge: FadeEdge): number {
  return edge === "left" ? clip.fadeInFrames : clip.fadeOutFrames;
}

export function clipFadeInterpolation(clip: Clip, edge: FadeEdge): Interpolation {
  return edge === "left" ? clip.fadeInInterpolation : clip.fadeOutInterpolation;
}

export function clipSetDuration(clip: Clip, newDuration: number): void {
  const oldDuration = clip.durationFrames;
  clip.durationFrames = newDuration;
  clipRescaleWordTimings(clip, oldDuration);
  clipClampKeyframesToDuration(clip);
  clipClampFadesToDuration(clip);
}

export function decodeClip(json: unknown): Clip {
  const c = asObject(json, "Clip");
  const normalizedValue = (key: string): number => {
    const value = tryDouble(c, key) ?? 0;
    return value >= 0 && value <= 1 ? value : 0;
  };
  return makeClip({
    id: tryString(c, "id"),
    mediaRef: getString(c, "mediaRef"),
    mediaType: tryEnum(c, "mediaType", clipTypes),
    sourceClipType: tryEnum(c, "sourceClipType", clipTypes),
    startFrame: getInt(c, "startFrame"),
    durationFrames: getInt(c, "durationFrames"),
    trimStartFrame: tryInt(c, "trimStartFrame"),
    trimEndFrame: tryInt(c, "trimEndFrame"),
    speed: tryDouble(c, "speed"),
    volume: tryDouble(c, "volume"),
    fadeInFrames: tryInt(c, "fadeInFrames"),
    fadeOutFrames: tryInt(c, "fadeOutFrames"),
    fadeInInterpolation: tryEnum(c, "fadeInInterpolation", interpolations),
    fadeOutInterpolation: tryEnum(c, "fadeOutInterpolation", interpolations),
    opacity: tryDouble(c, "opacity"),
    transform: tryWith(c, "transform", decodeTransform),
    crop: tryWith(c, "crop", decodeCrop),
    edgeRounding: normalizedValue("edgeRounding"),
    edgeSoftness: normalizedValue("edgeSoftness"),
    linkGroupId: tryString(c, "linkGroupId"),
    captionGroupId: tryString(c, "captionGroupId"),
    multicamGroupId: tryString(c, "multicamGroupId"),
    textContent: tryString(c, "textContent"),
    textStyle: tryWith(c, "textStyle", decodeTextStyle),
    textAnimation: tryWith(c, "textAnimation", decodeTextAnimation),
    wordTimings: tryArray(c, "wordTimings", decodeWordTiming),
    textFillMode: tryWith(c, "textFillMode", decodeTextFillMode),
    opacityTrack: tryWith(c, "opacityTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    positionTrack: tryWith(c, "positionTrack", (v) => decodeKeyframeTrack(v, decodeAnimPair)),
    scaleTrack: tryWith(c, "scaleTrack", (v) => decodeKeyframeTrack(v, decodeAnimPair)),
    rotationTrack: tryWith(c, "rotationTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    cropTrack: tryWith(c, "cropTrack", (v) => decodeKeyframeTrack(v, decodeCrop)),
    volumeTrack: tryWith(c, "volumeTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    speedTrack: tryWith(c, "speedTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    frameBlending: tryBool(c, "frameBlending"),
    effects: tryArray(c, "effects", decodeEffect),
    blendMode: tryWith(c, "blendMode", decodeBlendMode),
    masks: tryArray(c, "masks", decodeMask),
    adjustment: tryBool(c, "adjustment"),
  });
}

// MARK: - Transform

export interface Transform {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** degrees, positive = clockwise */
  rotation: number;
  rotationX: number;
  rotationY: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export const transformTiltRotationRange = { min: -89.0, max: 89.0 } as const;

export function makeTransform(p: Partial<Transform> = {}): Transform {
  return {
    centerX: p.centerX ?? 0.5,
    centerY: p.centerY ?? 0.5,
    width: p.width ?? 1,
    height: p.height ?? 1,
    rotation: p.rotation ?? 0,
    rotationX: p.rotationX ?? 0,
    rotationY: p.rotationY ?? 0,
    flipHorizontal: p.flipHorizontal ?? false,
    flipVertical: p.flipVertical ?? false,
  };
}

/** `Transform(topLeft:width:height:)` */
export function makeTransformFromTopLeft(tl: { x: number; y: number }, w: number, h: number): Transform {
  return makeTransform({ centerX: tl.x + w / 2, centerY: tl.y + h / 2, width: w, height: h });
}

/** `Transform(center:width:height:)` */
export function makeTransformFromCenter(c: { x: number; y: number }, w: number, h: number): Transform {
  return makeTransform({ centerX: c.x, centerY: c.y, width: w, height: h });
}

export function transformHasTiltRotation(t: Transform): boolean {
  return t.rotationX !== 0 || t.rotationY !== 0;
}

export function transformTopLeft(t: Transform): { x: number; y: number } {
  return { x: t.centerX - t.width / 2, y: t.centerY - t.height / 2 };
}

export function transformCenter(t: Transform): { x: number; y: number } {
  return { x: t.centerX, y: t.centerY };
}

/** Every key optional; legacy `x`/`y` (top-left-ish) keys are accepted when `centerX`/`centerY` are absent. */
export function decodeTransform(json: unknown): Transform {
  const c = asObject(json, "Transform");
  const w = optDouble(c, "width") ?? 1;
  const h = optDouble(c, "height") ?? 1;
  let centerX: number;
  const cx = optDouble(c, "centerX");
  if (cx !== undefined) {
    centerX = cx;
  } else {
    const oldX = optDouble(c, "x");
    centerX = oldX !== undefined ? oldX + w - 0.5 : 0.5;
  }
  let centerY: number;
  const cy = optDouble(c, "centerY");
  if (cy !== undefined) {
    centerY = cy;
  } else {
    const oldY = optDouble(c, "y");
    centerY = oldY !== undefined ? oldY + h - 0.5 : 0.5;
  }
  return {
    centerX,
    centerY,
    width: w,
    height: h,
    rotation: optDouble(c, "rotation") ?? 0,
    rotationX: optDouble(c, "rotationX") ?? 0,
    rotationY: optDouble(c, "rotationY") ?? 0,
    flipHorizontal: optBool(c, "flipHorizontal") ?? false,
    flipVertical: optBool(c, "flipVertical") ?? false,
  };
}

/** Writes the nine canonical keys (never the legacy `x`/`y`). */
export function encodeTransform(t: Transform): unknown {
  return {
    centerX: t.centerX,
    centerY: t.centerY,
    width: t.width,
    height: t.height,
    rotation: t.rotation,
    rotationX: t.rotationX,
    rotationY: t.rotationY,
    flipHorizontal: t.flipHorizontal,
    flipVertical: t.flipVertical,
  };
}

/** Snap a value to canvas boundaries (0 or 1) within threshold. */
export function transformSnapToBoundary(value: number, threshold: number): number {
  if (Math.abs(value) < threshold) return 0;
  if (Math.abs(value - 1) < threshold) return 1;
  return value;
}

/** Snap clip edges to canvas boundaries (0 or 1). */
export function transformSnapToCanvasEdges(t: Transform, threshold: number): void {
  const tl = transformTopLeft(t);
  const snappedLeft = transformSnapToBoundary(tl.x, threshold);
  const snappedRight = transformSnapToBoundary(tl.x + t.width, threshold);
  if (snappedLeft !== tl.x) {
    t.centerX -= tl.x - snappedLeft;
  } else if (snappedRight !== tl.x + t.width) {
    t.centerX -= tl.x + t.width - snappedRight;
  }

  const tl2 = transformTopLeft(t);
  const snappedTop = transformSnapToBoundary(tl2.y, threshold);
  const snappedBottom = transformSnapToBoundary(tl2.y + t.height, threshold);
  if (snappedTop !== tl2.y) {
    t.centerY -= tl2.y - snappedTop;
  } else if (snappedBottom !== tl2.y + t.height) {
    t.centerY -= tl2.y + t.height - snappedBottom;
  }
}

/** Snap per-axis within threshold. Return value lets callers draw guide indicators. */
export function transformSnapCenterToCanvasCenter(
  t: Transform,
  thresholdH: number,
  thresholdV: number,
): { x: boolean; y: boolean } {
  let snappedX = false;
  let snappedY = false;
  if (Math.abs(t.centerX - 0.5) < thresholdH) {
    t.centerX = 0.5;
    snappedX = true;
  }
  if (Math.abs(t.centerY - 0.5) < thresholdV) {
    t.centerY = 0.5;
    snappedY = true;
  }
  return { x: snappedX, y: snappedY };
}

// MARK: - Crop

/** Per-clip crop as edge insets in normalized (0–1) source coordinates. */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const cropMinimumVisibleFraction = 0.05;

export type CropEdge = "left" | "top" | "right" | "bottom";

export function makeCrop(p: Partial<Crop> = {}): Crop {
  return { left: p.left ?? 0, top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0 };
}

/** Synthesized Codable: every key is required. */
export function decodeCrop(json: unknown): Crop {
  const c = asObject(json, "Crop");
  return { left: getDouble(c, "left"), top: getDouble(c, "top"), right: getDouble(c, "right"), bottom: getDouble(c, "bottom") };
}

export function cropIsIdentity(c: Crop): boolean {
  return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0;
}

export function cropVisibleWidthFraction(c: Crop): number {
  return Math.max(0, 1 - c.left - c.right);
}

export function cropVisibleHeightFraction(c: Crop): number {
  return Math.max(0, 1 - c.top - c.bottom);
}

export function cropInset(c: Crop, edge: CropEdge): number {
  return c[edge];
}

export function cropMaximumInset(c: Crop, edge: CropEdge): number {
  let maximum: number;
  switch (edge) {
    case "left": maximum = 1 - cropMinimumVisibleFraction - c.right; break;
    case "top": maximum = 1 - cropMinimumVisibleFraction - c.bottom; break;
    case "right": maximum = 1 - cropMinimumVisibleFraction - c.left; break;
    case "bottom": maximum = 1 - cropMinimumVisibleFraction - c.top; break;
  }
  return Math.min(1, Math.max(0, maximum));
}

export function cropSetInset(c: Crop, value: number, edge: CropEdge): void {
  if (!Number.isFinite(value)) return;
  const inset = Math.min(Math.max(0, value), cropMaximumInset(c, edge));
  c[edge] = inset;
}

// MARK: - CropAspectRatio / CropAspectLock

export interface CropAspectRatio {
  horizontal: number;
  vertical: number;
}

/** `CropAspectRatio(horizontal:vertical:)` — failable. */
export function makeCropAspectRatio(horizontal: number, vertical: number): CropAspectRatio | undefined {
  if (
    !Number.isFinite(horizontal) || !Number.isFinite(vertical) ||
    !(horizontal > 0) || !(vertical > 0) ||
    !Number.isFinite(horizontal / vertical)
  ) {
    return undefined;
  }
  return { horizontal, vertical };
}

/** `CropAspectRatio(pixelWidth:pixelHeight:)` — reduces by the gcd. */
export function cropAspectRatioFromPixels(pixelWidth: number, pixelHeight: number): CropAspectRatio | undefined {
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) return undefined;
  let a = pixelWidth;
  let b = pixelHeight;
  while (b !== 0) [a, b] = [b, a % b];
  return makeCropAspectRatio(Math.trunc(pixelWidth / a), Math.trunc(pixelHeight / a));
}

/** `CropAspectRatio(pixelAspect:)` */
export function cropAspectRatioFromPixelAspect(pixelAspect: number): CropAspectRatio | undefined {
  if (!(Number.isFinite(pixelAspect) && pixelAspect > 0)) return undefined;
  return makeCropAspectRatio(Math.max(pixelAspect, 1), Math.max(1 / pixelAspect, 1));
}

/** `CropAspectRatio.preset` — skips validation for known-good constants. */
export function cropAspectRatioPreset(horizontal: number, vertical: number): CropAspectRatio {
  return { horizontal, vertical };
}

export function cropAspectRatioPixelAspect(r: CropAspectRatio): number {
  return r.horizontal / r.vertical;
}

/** C `%.6g` (en_US_POSIX). */
function formatG6(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  if (!Number.isFinite(value)) return String(value);
  const exp = Number(value.toExponential(5).split("e")[1]);
  const stripZeros = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (exp < -4 || exp >= 6) {
    const [mantissa] = value.toExponential(5).split("e");
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${stripZeros(mantissa as string)}e${exp < 0 ? "-" : "+"}${e}`;
  }
  return stripZeros(value.toFixed(Math.max(0, 5 - exp)));
}

export function cropAspectRatioHorizontalText(r: CropAspectRatio): string {
  return formatG6(r.horizontal);
}

export function cropAspectRatioVerticalText(r: CropAspectRatio): string {
  return formatG6(r.vertical);
}

export function cropAspectRatioLabel(r: CropAspectRatio): string {
  return `${cropAspectRatioHorizontalText(r)}:${cropAspectRatioVerticalText(r)}`;
}

export type CropAspectLock =
  | { kind: "free" }
  | { kind: "original" }
  | { kind: "fixed"; ratio: CropAspectRatio };

export const cropAspectLockFree: CropAspectLock = { kind: "free" };
export const cropAspectLockOriginal: CropAspectLock = { kind: "original" };
export const cropAspectLockR16x9: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(16, 9) };
export const cropAspectLockR9x16: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(9, 16) };
export const cropAspectLockR1x1: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(1, 1) };
export const cropAspectLockR4x3: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(4, 3) };
export const cropAspectLockR3x4: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(3, 4) };
export const cropAspectLockR21x9: CropAspectLock = { kind: "fixed", ratio: cropAspectRatioPreset(21, 9) };
export const cropAspectLockPresets: readonly CropAspectLock[] = [
  cropAspectLockFree, cropAspectLockOriginal, cropAspectLockR16x9, cropAspectLockR9x16,
  cropAspectLockR1x1, cropAspectLockR4x3, cropAspectLockR3x4, cropAspectLockR21x9,
];

export function cropAspectLockLabel(l: CropAspectLock): string {
  switch (l.kind) {
    case "free": return "Freeform";
    case "original": return "Original";
    case "fixed": return cropAspectRatioLabel(l.ratio);
  }
}

export function cropAspectLockAspectRatio(l: CropAspectLock): CropAspectRatio | undefined {
  return l.kind === "fixed" ? l.ratio : undefined;
}

export function cropAspectLockPixelAspect(l: CropAspectLock): number | undefined {
  const r = cropAspectLockAspectRatio(l);
  return r ? cropAspectRatioPixelAspect(r) : undefined;
}

export function cropAspectLockLockedTo(ratio: CropAspectRatio): CropAspectLock {
  const match = cropAspectLockPresets.find((p) => {
    const pa = cropAspectLockPixelAspect(p);
    return pa !== undefined && Math.abs(pa - cropAspectRatioPixelAspect(ratio)) < 1e-9;
  });
  return match ?? { kind: "fixed", ratio };
}
