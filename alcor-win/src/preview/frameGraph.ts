import type { BlendMode } from "../model/blendMode";
import { clipBlurRadius, gaussianBlurRadiusKey, gaussianBlurType } from "../model/clipEffectKeyframes";
import { makeStaticEffect, type Effect } from "../model/effect";
import type { Size } from "../model/geometry";
import { keyframeTrackIsActive, type Keyframe } from "../model/keyframe";
import type { Mask } from "../model/mask";
import type { MediaAsset } from "../model/mediaAsset";
import { clipHasSpeedRamp, clipSourceFramesAt, clipSpeedAt } from "../model/speedRamp";
import { presetRenderMode, textAnimationIsActive, type TextAnimation } from "../model/textAnimation";
import type { TextFillMode } from "../model/textFillMode";
import { textLayoutReferenceCanvasHeight } from "../model/textLayout";
import {
  makeRGBA, makeTextStyle, textStyleDisplayText, textStyleScaledVisualStyle, type RGBA, type TextStyle,
} from "../model/textStyle";
import {
  clipCropAt, clipEndFrame, clipOpacityAt, clipTextStyleAt, clipTransformAt, clipVolumeAt, makeCrop,
  type Clip, type Crop, type Timeline, type Transform,
} from "../model/timeline";
import { splitDenoiseSource } from "../denoise/denoiseMix";
import type { TransitionKind } from "../model/transition";
import { swiftRound } from "../util/math";
import { activeTransitionAt, transitionAudioProgress, transitionProgress, type ActiveTransition } from "../transitions/transitionMath";
import { effectDescriptor, effectDescriptorResolve, type ResolvedEffectParams } from "./effects/effectRegistry";
import { nestFlatten, nestMaxDepth, type Flattened } from "./nestFlattener";
import { textAnimatorClipEntry, textAnimatorWordState, textClipStateIdentity, type TextClipState, type TextWordState } from "./textAnimator";
import { textTokenTimings, textTypewriterVisibleText, textWords, type TextToken } from "./textRenderer";

// MARK: - Graph types

export interface FrameEffect {
  effect: Effect;
  params: ResolvedEffectParams;
}

interface LayerBase {
  /** Unique per layer instance (nested clips carry `carrierId/childId`). */
  key: string;
  /** The clip as composited: nested clips are remapped into parent frames. */
  clip: Clip;
  /** `opacityAt` (keyframes × fades) clamped to 0…1; layers at 0 are omitted. */
  opacity: number;
  blendMode: BlendMode;
  transform: Transform;
  crop: Crop;
  edgeRounding: number;
  edgeSoftness: number;
  /** Enabled, registered effects in stack order with params resolved at the frame. */
  effects: FrameEffect[];
  effectOffset: number;
  /** Multiplies blur radii (text: canvas height / 1080). The renderer multiplies in its own render scale. */
  effectSpatialScale: number;
  /** The clip's masks (identity-stable while unedited); absent when it has none. */
  masks?: readonly Mask[];
  /** Frame relative to the clip start, for animated masks. */
  maskOffset: number;
}

export interface MediaLayer extends LayerBase {
  kind: "media";
  mediaRef: string;
  mediaType: "video" | "image" | "lottie";
  /** Display size of the source; undefined = use the decoded texture's size. */
  natSize?: Size;
  /** Source seconds shown at this frame. */
  sourceTime: number;
  /** Source seconds at the clip's first frame. */
  sourceStart: number;
  /** Source seconds advanced per timeline second (clip speed after duration clamping; instantaneous on speed ramps). */
  sourceRate: number;
  /** Mix the two source frames around `sourceTime` (frame blending, slower than 1x). */
  frameBlend?: boolean;
}

export interface GroupLayer extends LayerBase {
  kind: "group";
  natSize: Size;
  /** Children bottom → top, composited on an opaque black `natSize` canvas. */
  children: FrameLayer[];
}

export type TextRenderMode = "static" | "entrance" | "perWord" | "typewriter";

export interface TextLayerState {
  /** Display text (font case applied). */
  content: string;
  /** Frame-resolved style, `fontScale` folded in, blur stripped; fill-mode overrides applied. */
  style: TextStyle;
  fillMode: TextFillMode;
  mode: TextRenderMode;
  animation?: TextAnimation;
  /** Frame relative to clip start. */
  rel: number;
  entrance: TextClipState;
  /** Word motion pads the raster by one font size. */
  wordMotion: boolean;
  tokens: TextToken[];
  wordStates: TextWordState[];
  /** Typewriter: the revealed prefix (with caret). */
  typewriterVisible: string;
  /** Footage fill: color of the matte outside the glyphs. */
  matteColor: RGBA;
}

export interface TextLayer extends LayerBase {
  kind: "text";
  /** Canvas the text is laid out on (timeline or nested child canvas). */
  canvasSize: Size;
  text: TextLayerState;
}

/** Adjustment layer: runs its effects over everything composited below it, limited by its masks. */
export interface AdjustmentLayer extends LayerBase {
  kind: "adjustment";
}

/** Two clips of one track blended while a transition plays; either side is absent when it draws nothing. */
export interface TransitionLayer extends LayerBase {
  kind: "transition";
  transitionKind: TransitionKind;
  /** 0...1 position inside the transition at this frame. */
  progress: number;
  from?: FrameLayer;
  to?: FrameLayer;
}

export type FrameLayer = MediaLayer | GroupLayer | TextLayer | AdjustmentLayer | TransitionLayer;

export interface FrameGraph {
  timelineId: string;
  frame: number;
  fps: number;
  width: number;
  height: number;
  /** Bottom → top over an opaque black canvas. */
  layers: FrameLayer[];
}

export interface FrameGraphDocument {
  timelines: readonly Timeline[];
  mediaAssets?: readonly MediaAsset[];
}

export interface FrameGraphOptions {
  resolveTimeline?: (id: string) => Timeline | undefined;
  /** Display size of a media ref. Defaults to the asset's sourceWidth/Height. */
  resolveSourceSize?: (mediaRef: string) => Size | undefined;
  /** Source duration in seconds (clamps the inserted range like AVFoundation). Defaults to the asset's duration. */
  resolveMediaDuration?: (mediaRef: string) => number | undefined;
  /** Offline media never occupies a lane slot (CompositionBuilder skips it). */
  missingMediaRefs?: ReadonlySet<string>;
  /** Media refs with a baked denoised file: their denoise-enabled clips play as a dry/wet pair (`denoiseMix.ts`). */
  wetMediaRefs?: ReadonlySet<string>;
}

// MARK: - Context

interface Ctx {
  fps: number;
  resolveTimeline: (id: string) => Timeline | undefined;
  resolveSourceSize: (mediaRef: string) => Size | undefined;
  resolveMediaDuration: (mediaRef: string) => number | undefined;
  missing: ReadonlySet<string> | undefined;
}

const emptySet: ReadonlySet<string> = new Set();

function makeCtx(doc: FrameGraphDocument, fps: number, options: FrameGraphOptions): Ctx {
  const asset = (id: string): MediaAsset | undefined => doc.mediaAssets?.find((a) => a.id === id);
  return {
    fps,
    resolveTimeline: options.resolveTimeline ?? ((id) => doc.timelines.find((t) => t.id === id)),
    resolveSourceSize: options.resolveSourceSize ?? ((id) => {
      const a = asset(id);
      return a?.sourceWidth && a.sourceHeight && a.sourceWidth > 0 && a.sourceHeight > 0
        ? { width: a.sourceWidth, height: a.sourceHeight }
        : undefined;
    }),
    resolveMediaDuration: options.resolveMediaDuration ?? ((id) => {
      const a = asset(id);
      return a && a.type !== "image" && a.duration > 0 ? a.duration : undefined;
    }),
    missing: options.missingMediaRefs,
  };
}

function sortedByStart(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

const flattenCache = new WeakMap<Clip, WeakMap<Timeline, { visual?: Flattened; audio?: Flattened }>>();

/** Flatten is pure per (carrier, child); the document is immutable so identity is a complete key. */
function flattened(carrier: Clip, child: Timeline, visual: boolean): Flattened {
  let byChild = flattenCache.get(carrier);
  if (!byChild) {
    byChild = new WeakMap();
    flattenCache.set(carrier, byChild);
  }
  let entry = byChild.get(child);
  if (!entry) {
    entry = {};
    byChild.set(child, entry);
  }
  if (visual) return (entry.visual ??= nestFlatten(carrier, child, true));
  return (entry.audio ??= nestFlatten(carrier, child, false));
}

function containsFrame(clip: Clip, frame: number): boolean {
  return frame >= clip.startFrame && frame < clipEndFrame(clip);
}

// MARK: - Media timing (CompositionBuilder.insertClip)

export interface MediaTiming {
  sourceStart: number;
  sourceDuration: number;
  /** Source seconds per timeline second. */
  rate: number;
}

/** Inserted source range for a clip; undefined when the clamped range is empty (clip not inserted). */
export function mediaTiming(clip: Clip, fps: number, mediaDuration?: number): MediaTiming | undefined {
  const trimStartFrame = clip.mediaType === "image" ? Math.max(0, clip.trimStartFrame) : clip.trimStartFrame;
  const sourceStart = trimStartFrame / fps;
  const sourceFrames = clip.speed === 1.0 ? clip.durationFrames : Math.max(1, Math.trunc(clip.durationFrames * clip.speed));
  let sourceDuration = sourceFrames / fps;
  // Baked sources can be a hair shorter than the original; clamp instead of throwing.
  if (mediaDuration !== undefined && Number.isFinite(mediaDuration)) {
    sourceDuration = Math.min(sourceDuration, mediaDuration - sourceStart);
  }
  if (!(sourceDuration > 0)) return undefined;
  return { sourceStart, sourceDuration, rate: sourceDuration / (clip.durationFrames / fps) };
}

/** Source seconds at a timeline frame (scaleTimeRange maps the inserted range linearly onto the clip). */
export function mediaSourceTime(clip: Clip, timing: MediaTiming, frame: number, fps: number): number {
  if (clipHasSpeedRamp(clip)) {
    // The ramp integrates speed; `timing.rate / clip.speed` carries any duration clamp.
    return timing.sourceStart + (clipSourceFramesAt(clip, frame - clip.startFrame) / fps) * (timing.rate / clip.speed);
  }
  return timing.sourceStart + ((frame - clip.startFrame) / fps) * timing.rate;
}

/** Source seconds per timeline second at a frame. */
export function mediaSourceRate(clip: Clip, timing: MediaTiming, frame: number): number {
  return clipHasSpeedRamp(clip) ? clipSpeedAt(clip, frame - clip.startFrame) * (timing.rate / clip.speed) : timing.rate;
}

// MARK: - Transform (CompositionBuilder.affineTransform)

/** CGAffineTransform: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const affineIdentity: Readonly<Affine> = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** `t1.concatenating(t2)`: apply t1, then t2. */
export function affineConcat(t1: Affine, t2: Affine): Affine {
  return {
    a: t1.a * t2.a + t1.b * t2.c,
    b: t1.a * t2.b + t1.b * t2.d,
    c: t1.c * t2.a + t1.d * t2.c,
    d: t1.c * t2.b + t1.d * t2.d,
    tx: t1.tx * t2.a + t1.ty * t2.c + t2.tx,
    ty: t1.tx * t2.b + t1.ty * t2.d + t2.ty,
  };
}

/** Maps a clip's Transform (normalized 0–1 canvas coordinates) onto top-left-origin render pixels. */
export function affineTransform(t: Transform, natSize: Size, renderSize: Size): Affine {
  const tlx = t.centerX - t.width / 2;
  const tly = t.centerY - t.height / 2;
  const sx = (renderSize.width / natSize.width) * t.width * (t.flipHorizontal ? -1 : 1);
  const sy = (renderSize.height / natSize.height) * t.height * (t.flipVertical ? -1 : 1);
  const tx = (t.flipHorizontal ? tlx + t.width : tlx) * renderSize.width;
  const ty = (t.flipVertical ? tly + t.height : tly) * renderSize.height;
  const placed: Affine = { a: sx, b: 0, c: 0, d: sy, tx, ty };
  return affineConcat(placed, canvasRotationTransform(t, renderSize));
}

export function canvasRotationTransform(t: Transform, renderSize: Size): Affine {
  if (t.rotation === 0) return { ...affineIdentity };
  const cx = t.centerX * renderSize.width;
  const cy = t.centerY * renderSize.height;
  const angle = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const rot: Affine = { a: cos, b: sin, c: -sin, d: cos, tx: 0, ty: 0 };
  return affineConcat(
    affineConcat({ a: 1, b: 0, c: 0, d: 1, tx: -cx, ty: -cy }, rot),
    { a: 1, b: 0, c: 0, d: 1, tx: cx, ty: cy },
  );
}

// MARK: - Layer construction

function resolvedEffects(effects: readonly Effect[] | undefined, offset: number, spatialScale: number): FrameEffect[] {
  const out: FrameEffect[] = [];
  if (!effects) return out;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const d = effectDescriptor(effect.type);
    if (!d) continue;
    out.push({ effect, params: effectDescriptorResolve(d, effect, offset, spatialScale) });
  }
  return out;
}

function visualBase(clip: Clip, frame: number, opacity: number): LayerBase {
  const offset = frame - clip.startFrame;
  const base: LayerBase = {
    key: clip.id,
    clip,
    opacity,
    blendMode: clip.blendMode ?? "normal",
    transform: clipTransformAt(clip, frame),
    crop: clipCropAt(clip, frame),
    edgeRounding: clip.edgeRounding,
    edgeSoftness: clip.edgeSoftness,
    effects: resolvedEffects(clip.effects, offset, 1),
    effectOffset: offset,
    effectSpatialScale: 1,
    maskOffset: offset,
  };
  if (clip.masks) base.masks = clip.masks;
  return base;
}

function clampedOpacity(clip: Clip, frame: number): number {
  return Math.min(1.0, Math.max(0.0, clipOpacityAt(clip, frame)));
}

/** Whether the clip occupies a lane slot (CompositionBuilder inserted it). */
function mediaSlot(clip: Clip, ctx: Ctx): MediaTiming | undefined {
  if (clip.mediaType !== "video" && clip.mediaType !== "image" && clip.mediaType !== "lottie") return undefined;
  if ((ctx.missing ?? emptySet).has(clip.mediaRef)) return undefined;
  return mediaTiming(clip, ctx.fps, ctx.resolveMediaDuration(clip.mediaRef));
}

function mediaLayer(clip: Clip, timing: MediaTiming, frame: number, ctx: Ctx, sourceTime?: number): MediaLayer | undefined {
  const opacity = clampedOpacity(clip, frame);
  if (!(opacity > 0)) return undefined;
  const layer: MediaLayer = {
    ...visualBase(clip, frame, opacity),
    kind: "media",
    mediaRef: clip.mediaRef,
    mediaType: clip.mediaType as MediaLayer["mediaType"],
    sourceTime: sourceTime ?? mediaSourceTime(clip, timing, frame, ctx.fps),
    sourceStart: timing.sourceStart,
    sourceRate: mediaSourceRate(clip, timing, frame),
  };
  if (clip.frameBlending && layer.sourceRate < 1) layer.frameBlend = true;
  const natSize = ctx.resolveSourceSize(clip.mediaRef);
  if (natSize) layer.natSize = natSize;
  return layer;
}

/** Text renders in place; FrameRenderer.composedTextLayer / textStencilMask inputs resolved at `frame`. */
function textLayer(clip: Clip, frame: number, canvasSize: Size): TextLayer | undefined {
  const opacity = clampedOpacity(clip, frame);
  if (!(opacity > 0)) return undefined;
  const fillMode: TextFillMode = clip.textFillMode ?? "color";
  const style = { ...textStyleScaledVisualStyle(clipTextStyleAt(clip, frame)) };
  style.blur = 0;
  const matteColor = { ...(clip.textStyle ?? makeTextStyle()).color };
  if (fillMode === "footage") {
    style.color = makeRGBA({ r: 1, g: 1, b: 1, a: 1 });
  } else if (fillMode === "inverted") {
    style.color = makeRGBA({ r: 1, g: 1, b: 1, a: 1 });
    style.border = { ...style.border, enabled: false };
    style.shadow = { ...style.shadow, enabled: false };
    style.background = {
      ...style.background,
      color: { ...style.background.color, a: 0 },
      outlineColor: { ...style.background.outlineColor, a: 0 },
    };
  }
  const content = textStyleDisplayText(style, clip.textContent ?? "");
  if (content === "" || !(canvasSize.width >= 1 && canvasSize.height >= 1)) return undefined;

  const rel = frame - clip.startFrame;
  const anim = clip.textAnimation && textAnimationIsActive(clip.textAnimation) ? clip.textAnimation : undefined;
  const renderMode = anim ? presetRenderMode(anim.preset) : undefined;
  const mode: TextRenderMode = renderMode === undefined ? "static" : renderMode;
  let tokens: TextToken[] = [];
  let wordStates: TextWordState[] = [];
  let typewriterVisible = "";
  if (anim && mode === "perWord") {
    tokens = textWords(content);
    const timings = textTokenTimings(tokens, clip.wordTimings, clip.durationFrames);
    wordStates = timings.map((timing, index) =>
      textAnimatorWordState(anim, timing, timings[index + 1], rel, style.color));
  } else if (mode === "typewriter") {
    typewriterVisible = textTypewriterVisibleText(content, clip.wordTimings, clip.durationFrames, rel);
  }

  const offset = rel;
  const spatialScale = canvasSize.height / textLayoutReferenceCanvasHeight;
  const effects: FrameEffect[] = [];
  const blurRadius = clipBlurRadius(clip, frame);
  if (Number.isFinite(blurRadius) && blurRadius > 0) {
    const blur = makeStaticEffect(gaussianBlurType, { [gaussianBlurRadiusKey]: blurRadius });
    effects.push(...resolvedEffects([blur], offset, spatialScale));
  }
  effects.push(...resolvedEffects(clip.effects?.filter((e) => e.type !== gaussianBlurType), offset, spatialScale));

  const text: TextLayerState = {
    content,
    style,
    fillMode,
    mode,
    rel,
    entrance: anim && mode === "entrance" ? textAnimatorClipEntry(anim, rel) : { ...textClipStateIdentity },
    wordMotion: anim !== undefined && mode !== "entrance",
    tokens,
    wordStates,
    typewriterVisible,
    matteColor,
  };
  if (anim) text.animation = anim;
  return {
    key: clip.id,
    clip,
    opacity,
    blendMode: fillMode === "inverted" ? "difference" : clip.blendMode ?? "normal",
    transform: clipTransformAt(clip, frame),
    crop: makeCrop(),
    edgeRounding: 0,
    edgeSoftness: 0,
    effects,
    effectOffset: offset,
    effectSpatialScale: spatialScale,
    maskOffset: offset,
    ...(clip.masks ? { masks: clip.masks } : {}),
    kind: "text",
    canvasSize,
    text,
  };
}

/** `nestGroupPlan` gated to the clips visible at `frame`; empty children still render (nest gaps are opaque black). */
function groupLayer(carrier: Clip, depth: number, frame: number, ctx: Ctx): GroupLayer | undefined {
  if (!(depth < nestMaxDepth)) return undefined;
  const child = ctx.resolveTimeline(carrier.mediaRef);
  if (!child) return undefined;
  const flat = flattened(carrier, child, true);
  const opacity = clampedOpacity(carrier, frame);
  if (!(opacity > 0) || !(flat.childCanvas.width > 0 && flat.childCanvas.height > 0)) return undefined;
  const children: FrameLayer[] = [];
  for (let t = flat.videoTracks.length - 1; t >= 0; t--) {
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const clip of flat.videoTracks[t] as Clip[]) {
      if (!(clip.durationFrames > 0)) continue;
      if (clip.adjustment === true) {
        if (!containsFrame(clip, frame)) continue;
        const layer = adjustmentLayer(clip, frame, flat.childCanvas);
        if (layer) children.push(layer);
      } else if (clip.mediaType === "text") {
        if (!containsFrame(clip, frame) || (clip.textContent ?? "") === "") continue;
        const layer = textLayer(clip, frame, flat.childCanvas);
        if (layer) children.push(layer);
      } else if (clip.mediaType === "sequence") {
        if (clip.startFrame < prevEnd) continue;
        prevEnd = clipEndFrame(clip);
        if (!containsFrame(clip, frame)) continue;
        const layer = groupLayer(clip, depth + 1, frame, ctx);
        if (layer) children.push(layer);
      } else {
        if (clip.startFrame < prevEnd) continue;
        const timing = mediaSlot(clip, ctx);
        if (!timing) continue;
        prevEnd = clipEndFrame(clip);
        if (!containsFrame(clip, frame)) continue;
        const layer = mediaLayer(clip, timing, frame, ctx);
        if (layer) children.push(layer);
      }
    }
  }
  return {
    ...visualBase(carrier, frame, opacity),
    kind: "group",
    natSize: { ...flat.childCanvas },
    children,
  };
}

// MARK: - Adjustment layers and transitions

/**
 * An adjustment layer is an empty text clip, so its blur lives in the text style like text blur and effect radii scale
 * with the canvas like text. A layer with nothing to apply is dropped, so it costs nothing.
 */
function adjustmentLayer(clip: Clip, frame: number, canvas: Size): AdjustmentLayer | undefined {
  const opacity = clampedOpacity(clip, frame);
  if (!(opacity > 0)) return undefined;
  const offset = frame - clip.startFrame;
  const spatialScale = canvas.height / textLayoutReferenceCanvasHeight;
  const effects: FrameEffect[] = [];
  const blurRadius = clipBlurRadius(clip, frame);
  if (Number.isFinite(blurRadius) && blurRadius > 0) {
    effects.push(...resolvedEffects([makeStaticEffect(gaussianBlurType, { [gaussianBlurRadiusKey]: blurRadius })], offset, spatialScale));
  }
  effects.push(...resolvedEffects(clip.effects?.filter((e) => e.type !== gaussianBlurType), offset, spatialScale));
  if (effects.length === 0) return undefined;
  const base = visualBase(clip, frame, opacity);
  return { ...base, effects, effectSpatialScale: spatialScale, kind: "adjustment" };
}

/**
 * Source time of a clip at a frame outside its own range during a transition: the source keeps playing into the
 * trimmed handle, then holds the last (outgoing) or first (incoming) frame, like Premiere's frame hold.
 */
function edgeSourceTime(clip: Clip, timing: MediaTiming, frame: number, outgoing: boolean, ctx: Ctx): number {
  const edge = outgoing ? clipEndFrame(clip) - 1 : clip.startFrame;
  if (outgoing ? frame <= edge : frame >= edge) return mediaSourceTime(clip, timing, frame, ctx.fps);
  const base = mediaSourceTime(clip, timing, edge, ctx.fps);
  const t = base + ((frame - edge) / ctx.fps) * mediaSourceRate(clip, timing, edge);
  if (clip.mediaType === "image") return t;
  if (!outgoing) return Math.max(t, 0);
  const duration = ctx.resolveMediaDuration(clip.mediaRef);
  let last = timing.sourceStart + timing.sourceDuration + Math.max(0, clip.trimEndFrame) / ctx.fps - 1 / ctx.fps;
  if (duration !== undefined && Number.isFinite(duration)) last = Math.min(last, duration - 1 / ctx.fps);
  return Math.min(t, Math.max(base, last));
}

/** One side of a transition, drawn with the clip's own settings at its nearest in-range frame. */
function transitionSide(clip: Clip, outgoing: boolean, frame: number, ctx: Ctx, canvas: Size): FrameLayer | undefined {
  const own = outgoing ? Math.min(frame, clipEndFrame(clip) - 1) : Math.max(frame, clip.startFrame);
  let layer: FrameLayer | undefined;
  if (clip.mediaType === "text") {
    layer = (clip.textContent ?? "") === "" ? undefined : textLayer(clip, own, canvas);
    if (layer && layer.kind === "text" && layer.text.fillMode === "inverted") return layer;
  } else if (clip.mediaType === "sequence") {
    layer = groupLayer(clip, 0, own, ctx);
  } else {
    const timing = mediaSlot(clip, ctx);
    if (timing) layer = mediaLayer(clip, timing, own, ctx, edgeSourceTime(clip, timing, frame, outgoing, ctx));
  }
  // Both sides composite onto transparent targets, where non-normal blend modes have nothing to blend with.
  if (layer) layer.blendMode = "normal";
  return layer;
}

const noEffects: FrameEffect[] = [];

function transitionLayer(active: ActiveTransition, frame: number, ctx: Ctx, canvas: Size): TransitionLayer | undefined {
  const from = transitionSide(active.from, true, frame, ctx, canvas);
  const to = transitionSide(active.to, false, frame, ctx, canvas);
  if (!from && !to) return undefined;
  const ref = (from ?? to) as FrameLayer;
  const layer: TransitionLayer = {
    key: active.transition.id,
    clip: active.from,
    opacity: 1,
    blendMode: "normal",
    transform: ref.transform,
    crop: ref.crop,
    edgeRounding: 0,
    edgeSoftness: 0,
    effects: noEffects,
    effectOffset: 0,
    effectSpatialScale: 1,
    maskOffset: 0,
    kind: "transition",
    transitionKind: active.transition.kind,
    progress: transitionProgress(active.span, frame),
  };
  if (from) layer.from = from;
  if (to) layer.to = to;
  return layer;
}

/** Ordered layers (bottom → top) composited at `frame`; mirrors CompositionBuilder.compositorInstructions + FrameRenderer. */
export function buildFrameGraph(
  doc: FrameGraphDocument,
  timelineId: string,
  frame: number,
  options: FrameGraphOptions = {},
): FrameGraph {
  const timeline = doc.timelines.find((t) => t.id === timelineId);
  if (!timeline) return { timelineId, frame, fps: 30, width: 0, height: 0, layers: [] };
  const ctx = makeCtx(doc, timeline.fps, options);
  const canvas = { width: timeline.width, height: timeline.height };
  const layers: FrameLayer[] = [];
  if (timeline.fps > 0 && timeline.width > 0 && timeline.height > 0) {
    // Walk tracks in reverse to produce bottom→top entries. Text layers follow track order.
    for (let t = timeline.tracks.length - 1; t >= 0; t--) {
      const track = timeline.tracks[t];
      if (!track || track.hidden) continue;
      let prevEnd = Number.NEGATIVE_INFINITY;
      const active = track.transitions ? activeTransitionAt(track, frame) : undefined;
      const transition = active ? transitionLayer(active, frame, ctx, canvas) : undefined;
      for (const clip of sortedByStart(track.clips)) {
        if (!(clip.durationFrames > 0)) continue;
        if (transition && active && (clip.id === active.from.id || clip.id === active.to.id)) {
          prevEnd = Math.max(prevEnd, clipEndFrame(clip));
          if (clip.id === active.from.id) layers.push(transition);
          continue;
        }
        if (clip.adjustment === true) {
          if (!containsFrame(clip, frame)) continue;
          const layer = adjustmentLayer(clip, frame, canvas);
          if (layer) layers.push(layer);
        } else if (clip.mediaType === "text") {
          if ((clip.textContent ?? "") === "" || !containsFrame(clip, frame)) continue;
          const layer = textLayer(clip, frame, canvas);
          if (layer) layers.push(layer);
        } else if (clip.mediaType === "sequence") {
          if (clip.startFrame < prevEnd) continue;
          prevEnd = clipEndFrame(clip);
          if (!containsFrame(clip, frame)) continue;
          const layer = groupLayer(clip, 0, frame, ctx);
          if (layer) layers.push(layer);
        } else {
          // Audio tracks never feed video lanes; their clips have no visual slot.
          if (track.type === "audio" || clip.startFrame < prevEnd) continue;
          const timing = mediaSlot(clip, ctx);
          if (!timing) continue;
          prevEnd = clipEndFrame(clip);
          if (!containsFrame(clip, frame)) continue;
          const layer = mediaLayer(clip, timing, frame, ctx);
          if (layer) layers.push(layer);
        }
      }
    }
  }
  return { timelineId, frame, fps: timeline.fps, width: timeline.width, height: timeline.height, layers };
}

/** Media layers anywhere in the graph (including inside groups), appended to `out`. */
export function collectMediaLayers(layers: readonly FrameLayer[], out: MediaLayer[]): MediaLayer[] {
  for (const layer of layers) {
    collectLayer(layer, out);
  }
  return out;
}

function collectLayer(layer: FrameLayer, out: MediaLayer[]): void {
  if (layer.kind === "media") out.push(layer);
  else if (layer.kind === "group") collectMediaLayers(layer.children, out);
  else if (layer.kind === "transition") {
    if (layer.from) collectLayer(layer.from, out);
    if (layer.to) collectLayer(layer.to, out);
  }
}

// MARK: - Audio

export interface AudioSource {
  /** Unique per source instance (nested: `carrierId/childId`). */
  key: string;
  clip: Clip;
  mediaRef: string;
  sourceTime: number;
  sourceStart: number;
  /** Source seconds per timeline second. */
  sourceRate: number;
  /** Linear gain from the AVAudioMix envelope at this frame. */
  gain: number;
  /** Transition crossfade multiplier at the next frame (already folded into `gain` for this one). */
  tailFade?: number;
}

export interface AudioGraph {
  timelineId: string;
  frame: number;
  sources: AudioSource[];
}

/** Smooth-curve subdivision count for non-linear keyframe segments. */
export const smoothSegments = 8;

/** Interior subdivision offsets for a smooth ramp between two frames (excluding endpoints). */
export function smoothSubdivisions(a: number, b: number): number[] {
  if (!(b > a)) return [];
  const span = b - a;
  const raw = new Set<number>();
  for (let i = 1; i < smoothSegments; i++) raw.add(a + swiftRound((span * i) / smoothSegments));
  return [...raw].sort((x, y) => x - y);
}

function normalizedKeyframes<V>(keyframes: readonly Keyframe<V>[], duration: number): Keyframe<V>[] {
  const keyed = new Map<number, Keyframe<V>>();
  for (const kf of keyframes) if (kf.frame >= 0 && kf.frame <= duration) keyed.set(kf.frame, kf);
  return [...keyed.values()].sort((x, y) => x.frame - y.frame);
}

const envelopeCache = new WeakMap<Clip, { carrier: Clip | undefined; offsets: number[] | null }>();

/** Envelope breakpoints (`emitEnvelopeRamps` offsets), or null for a constant volume. */
function envelopeOffsets(clip: Clip, carrier: Clip | undefined): number[] | null {
  const cached = envelopeCache.get(clip);
  if (cached && cached.carrier === carrier) return cached.offsets;
  const dur = clip.durationFrames;
  const kfs = normalizedKeyframes(clip.volumeTrack?.keyframes ?? [], dur);
  const hasFade = clip.fadeInFrames > 0 || clip.fadeOutFrames > 0;
  const carrierVaries = carrier
    ? (carrier.volumeTrack ? keyframeTrackIsActive(carrier.volumeTrack) : false) ||
      carrier.fadeInFrames > 0 || carrier.fadeOutFrames > 0
    : false;
  let offsets: number[] | null = null;
  if (kfs.length > 0 || hasFade || carrierVaries) {
    let extra: number[] = [];
    if (carrier && carrierVaries) {
      const toClipOffset = (carrierOffset: number): number => carrier.startFrame + carrierOffset - clip.startFrame;
      if (carrier.fadeInFrames > 0) {
        extra.push(toClipOffset(carrier.fadeInFrames));
        if (carrier.fadeInInterpolation === "smooth") {
          extra.push(...smoothSubdivisions(0, carrier.fadeInFrames).map(toClipOffset));
        }
      }
      if (carrier.fadeOutFrames > 0) {
        const fadeStart = carrier.durationFrames - carrier.fadeOutFrames;
        extra.push(toClipOffset(fadeStart));
        if (carrier.fadeOutInterpolation === "smooth") {
          extra.push(...smoothSubdivisions(fadeStart, carrier.durationFrames).map(toClipOffset));
        }
      }
      const ckfs = carrier.volumeTrack?.keyframes ?? [];
      for (const kf of ckfs) extra.push(toClipOffset(kf.frame));
      for (let i = 0; i + 1 < ckfs.length; i++) {
        if ((ckfs[i] as Keyframe<number>).interpolationOut === "hold") {
          extra.push(toClipOffset((ckfs[i + 1] as Keyframe<number>).frame) - 1);
        }
      }
      extra = extra.filter((o) => o > 0 && o < dur);
    }
    const set = new Set<number>([0, dur, ...extra]);
    for (const kf of kfs) set.add(kf.frame);
    for (let i = 0; i + 1 < kfs.length; i++) {
      const a = kfs[i] as Keyframe<number>, b = kfs[i + 1] as Keyframe<number>;
      if (a.interpolationOut !== "linear" && a.interpolationOut !== "hold") for (const o of smoothSubdivisions(a.frame, b.frame)) set.add(o);
      else if (a.interpolationOut === "hold" && b.frame - a.frame > 1) set.add(b.frame - 1);
    }
    if (clip.fadeInFrames > 0) {
      const endOffset = Math.min(dur, clip.fadeInFrames);
      set.add(endOffset);
      if (clip.fadeInInterpolation === "smooth") for (const o of smoothSubdivisions(0, endOffset)) set.add(o);
    }
    if (clip.fadeOutFrames > 0) {
      const startOffset = Math.max(0, dur - clip.fadeOutFrames);
      set.add(startOffset);
      if (clip.fadeOutInterpolation === "smooth") for (const o of smoothSubdivisions(startOffset, dur)) set.add(o);
    }
    offsets = [...set].sort((x, y) => x - y);
  }
  envelopeCache.set(clip, { carrier, offsets });
  return offsets;
}

/** Linear volume the audio mix applies at `frame`: piecewise-linear ramps between envelope breakpoints. */
export function audioEnvelopeGain(clip: Clip, frame: number, carrier?: Clip): number {
  const gainAt = (abs: number): number => (carrier ? clipVolumeAt(carrier, abs) : 1);
  const sampleAt = (offset: number): number =>
    Math.fround(clipVolumeAt(clip, clip.startFrame + offset) * gainAt(clip.startFrame + offset));
  const offsets = envelopeOffsets(clip, carrier);
  if (offsets === null) {
    const volume = sampleAt(0);
    return Number.isFinite(volume) ? volume : 0;
  }
  const rel = frame - clip.startFrame;
  for (let i = 0; i + 1 < offsets.length; i++) {
    const a = offsets[i] as number, b = offsets[i + 1] as number;
    if (!(b > a)) continue;
    if (rel >= a && rel < b) {
      const va = sampleAt(a), vb = sampleAt(b);
      return va + ((vb - va) * (rel - a)) / (b - a);
    }
  }
  return sampleAt(Math.min(Math.max(rel, 0), clip.durationFrames));
}

interface AudioFade {
  gain: number;
  tail: number;
}

/** Equal-power crossfade levels for the audio clips linked to the two clips of every transition active at `frame`. */
function audioTransitionFades(timeline: Timeline, frame: number): Map<string, AudioFade> | undefined {
  let fades: Map<string, AudioFade> | undefined;
  for (const track of timeline.tracks) {
    if (track.type === "audio" || !track.transitions) continue;
    const active = activeTransitionAt(track, frame);
    if (!active) continue;
    const p = transitionAudioProgress(active.span, frame) * Math.PI / 2;
    const tail = transitionAudioProgress(active.span, frame + 1) * Math.PI / 2;
    for (const audio of timeline.tracks) {
      if (audio.type !== "audio" || audio.muted) continue;
      for (const clip of audio.clips) {
        if (clip.linkGroupId === undefined) continue;
        const outgoing = clip.linkGroupId === active.from.linkGroupId;
        if (!outgoing && clip.linkGroupId !== active.to.linkGroupId) continue;
        (fades ??= new Map()).set(clip.id, outgoing ? { gain: Math.cos(p), tail: Math.cos(tail) } : { gain: Math.sin(p), tail: Math.sin(tail) });
      }
    }
  }
  return fades;
}

/** Source time of an audio clip a crossfade plays past its own range; undefined once the source has run out. */
function fadeSourceTime(clip: Clip, timing: MediaTiming, frame: number, ctx: Ctx): number | undefined {
  if (containsFrame(clip, frame)) return mediaSourceTime(clip, timing, frame, ctx.fps);
  const outgoing = frame >= clipEndFrame(clip);
  const edge = outgoing ? clipEndFrame(clip) - 1 : clip.startFrame;
  const t = mediaSourceTime(clip, timing, edge, ctx.fps) + ((frame - edge) / ctx.fps) * mediaSourceRate(clip, timing, edge);
  if (!(t >= 0)) return undefined;
  if (!outgoing) return t;
  let limit = timing.sourceStart + timing.sourceDuration + Math.max(0, clip.trimEndFrame) / ctx.fps;
  const duration = ctx.resolveMediaDuration(clip.mediaRef);
  if (duration !== undefined && Number.isFinite(duration)) limit = Math.min(limit, duration);
  return t < limit ? t : undefined;
}

/** Active audio sources at `frame` with their mix gain; mirrors insertAudioLane + buildVisuals' audio mix. */
export function buildAudioGraph(
  doc: FrameGraphDocument,
  timelineId: string,
  frame: number,
  options: FrameGraphOptions = {},
): AudioGraph {
  const timeline = doc.timelines.find((t) => t.id === timelineId);
  const sources: AudioSource[] = [];
  if (!timeline || !(timeline.fps > 0 && timeline.width > 0 && timeline.height > 0)) return { timelineId, frame, sources };
  const ctx = makeCtx(doc, timeline.fps, options);
  const fades = audioTransitionFades(timeline, frame);

  const lane = (clips: Clip[], depth: number, nest: { topCarrier: Clip; volumeScale: number } | undefined): void => {
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const original of clips) {
      if (original.mediaType === "text") continue;
      if (!(original.durationFrames > 0) || original.startFrame < prevEnd) continue;
      prevEnd = clipEndFrame(original);
      if (original.sourceClipType === "sequence") {
        if (!(depth < nestMaxDepth)) continue;
        const child = ctx.resolveTimeline(original.mediaRef);
        if (!child) continue;
        // Static volumes fold down the chain; the top carrier's envelope multiplies at mix time.
        const next = { topCarrier: nest?.topCarrier ?? original, volumeScale: nest ? nest.volumeScale * original.volume : 1.0 };
        for (const trackClips of flattened(original, child, false).audioTracks) lane(trackClips, depth + 1, next);
        continue;
      }
      const fade = nest ? undefined : fades?.get(original.id);
      if (!containsFrame(original, frame) && !fade) continue;
      if ((ctx.missing ?? emptySet).has(original.mediaRef)) continue;
      const clip = nest && nest.volumeScale !== 1 ? scaledVolumeClip(original, nest.volumeScale) : original;
      const timing = mediaTiming(clip, ctx.fps, ctx.resolveMediaDuration(clip.mediaRef));
      if (!timing) continue;
      const sourceTime = fade ? fadeSourceTime(clip, timing, frame, ctx) : mediaSourceTime(clip, timing, frame, ctx.fps);
      if (sourceTime === undefined) continue;
      const source: AudioSource = {
        key: clip.id,
        clip,
        mediaRef: clip.mediaRef,
        sourceTime,
        sourceStart: timing.sourceStart,
        sourceRate: mediaSourceRate(clip, timing, frame),
        gain: audioEnvelopeGain(clip, frame, nest?.topCarrier) * (fade ? fade.gain : 1),
      };
      if (fade) source.tailFade = fade.tail;
      sources.push(...splitDenoiseSource(source, nest ? undefined : options.wetMediaRefs));
    }
  };

  for (const track of timeline.tracks) {
    if (track.type !== "audio" || track.muted) continue;
    lane(sortedByStart(track.clips), 0, undefined);
  }
  return { timelineId, frame, sources };
}

const scaledVolumeCache = new WeakMap<Clip, { scale: number; clip: Clip }>();

function scaledVolumeClip(clip: Clip, scale: number): Clip {
  const cached = scaledVolumeCache.get(clip);
  if (cached && cached.scale === scale) return cached.clip;
  const scaled = { ...clip, volume: clip.volume * scale };
  scaledVolumeCache.set(clip, { scale, clip: scaled });
  return scaled;
}
