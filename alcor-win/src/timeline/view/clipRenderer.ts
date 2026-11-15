import type { BeatAnalysis } from "../../beats/beatInference";
import { markBeats } from "../../beats/beatState";
import { beatTickHeight, beatTickWidth, beatTicksFit, downbeatTickHeight, planBeatTicks } from "../../beats/beatTicks";
import {
  Trim,
  VolumeScale,
  clipBlurKeyframeTrack,
  clipContainsTimelineFrame,
  clipHasSpeedRamp,
  clipSourceDurationFrames,
  clipSourceFramesAt,
  clipSourceFramesConsumed,
  keyframeEase,
  smoothstep,
  clipVolumeAt,
  keyframeTrackIsActive,
  type Clip,
  type ClipType,
  type FadeEdge,
  type Interpolation,
  type Keyframe,
  type MediaAsset,
  type Rect,
} from "../../model";
import { thumbnailIndexForTime } from "../../media/thumbnailMath";
import { resamplePeaksToBars, waveformBarHeight, waveformDbRange, waveformSampleWindow } from "../../media/peaks";
import { ClipRendererMetrics, clipBodyRect, fadeHandleRenderX, fadeKneeY, yForDb } from "../timelineGeometry";
import { traceKeyframeGlyph } from "./keyframeGlyph";
import { css, type CanvasPalette, type RGBA } from "./canvasPalette";
import {
  ClipSizes,
  firstNonEmptyLine,
  formatClipDuration,
  showsFadeControls,
  showsLabel,
  showsVolumeKeyframes,
  usesCompactRendering,
} from "./clipRendererRules";
import { clipTypeThemeColorKind, readableForeground, type RGB, type TimelineClipColorPalette } from "./timelineClipColors";
import type { TimelineVisualSource } from "./visualSource";

/** Dead-air spans of an audio clip in source frames (`deadAirRanges:`); installed by src/deadair, empty when off. */
export type DeadAirRangesProvider = (clip: Clip) => readonly { lowerBound: number; upperBound: number }[];
let deadAirRanges: DeadAirRangesProvider | undefined;
export function setDeadAirRangesProvider(provider: DeadAirRangesProvider | undefined): void {
  deadAirRanges = provider;
}
const deadAirWashAlpha = 0.35; // AppTheme.Opacity.medium

// Canvas port of ClipRenderer.draw. Coordinates are document space; `visible` is the viewport in document space.

export interface ClipDrawStyle {
  fill: string;
  foreground: RGBA;
}

const black: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const white: RGBA = { r: 255, g: 255, b: 255, a: 1 };

/** Per-redraw cache of the six clip-type colours (the palette is user-editable). */
export function clipDrawStyles(colors: TimelineClipColorPalette): Map<ClipType, ClipDrawStyle> {
  const out = new Map<ClipType, ClipDrawStyle>();
  const types: ClipType[] = ["video", "audio", "image", "text", "lottie", "sequence", "subtitle"];
  for (const t of types) {
    const c: RGB = colors.color(clipTypeThemeColorKind(t));
    const fg = readableForeground(c) === "black" ? black : white;
    out.set(t, { fill: `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`, foreground: fg });
  }
  return out;
}

export interface ClipDrawArgs {
  clip: Clip;
  type: ClipType;
  rect: Rect;
  isSelected: boolean;
  isHovered: boolean;
  opacity: number;
  displayName: string | undefined;
  linkOffset: number | undefined;
  multicamAngleLabel: string | undefined;
  fps: number;
  showsKeyframeAutomation: boolean;
  isMissing: boolean;
  isGenerating: boolean;
  asset: MediaAsset | undefined;
}

export interface ClipDrawContext {
  ctx: CanvasRenderingContext2D;
  palette: CanvasPalette;
  styles: Map<ClipType, ClipDrawStyle>;
  visuals: TimelineVisualSource;
  /** Visible document rect; work outside it is skipped. */
  visible: Rect;
  font: string;
  badgeFont: string;
  smallBadgeFont: string;
}

function roundedPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, Math.min(radius, r.width / 2, r.height / 2));
}

export function drawClip(dc: ClipDrawContext, a: ClipDrawArgs): void {
  const { ctx, palette } = dc;
  const { clip, rect, type } = a;
  const style = dc.styles.get(a.clip.sourceClipType) as ClipDrawStyle;
  const translucent = a.opacity < 1;
  if (translucent) {
    ctx.save();
    ctx.globalAlpha = a.opacity;
  }

  if (usesCompactRendering(rect)) {
    ctx.fillStyle = a.isMissing && !a.isGenerating ? css(palette.error) : a.isSelected ? css(palette.overlayPrimary) : style.fill;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    if (translucent) ctx.restore();
    return;
  }

  const radius = Trim.clipCornerRadius;
  roundedPath(ctx, rect, radius);
  ctx.fillStyle = style.fill;
  ctx.fill();

  const labelBar = ClipRendererMetrics.labelBarHeight;
  const contentY = rect.y + labelBar;
  const mainHeight = rect.y + rect.height - contentY;
  const content: Rect = { x: rect.x, y: contentY, width: rect.width, height: mainHeight };

  if (type === "video" && a.asset && mainHeight > 4) {
    const thumbs = dc.visuals.thumbnails(a.asset);
    if (thumbs && thumbs.images.length > 0) drawThumbnailStrip(dc, thumbs, clip, content, rect, a.fps);
  } else if (type === "image" && a.asset && mainHeight > 4) {
    const tile = dc.visuals.imageTile(a.asset);
    if (tile) drawTiled(dc, content, rect, tile.aspect, () => tile.image);
  } else if (type === "audio" && a.asset) {
    const samples = dc.visuals.waveform(a.asset);
    if (samples && samples.length > 0) drawWaveform(dc, samples, clip, style, content);
  } else if (type === "text" && showsLabel(a.isSelected, rect)) {
    drawTextParagraph(dc, clip, a.displayName, rect, style);
  }

  const fadeControls = showsFadeControls(a.isSelected, a.isHovered, rect);
  if (type === "audio") {
    const kfVisible = a.showsKeyframeAutomation && showsVolumeKeyframes(a.isSelected, a.isHovered, rect);
    drawVolumeRubberBand(dc, clip, rect, style, fadeControls, kfVisible);
  } else {
    drawOpacityFades(dc, clip, rect, style, fadeControls);
  }

  if (rect.width >= ClipSizes.borderMinWidth) {
    roundedPath(ctx, rect, radius);
    ctx.strokeStyle = palette.clipBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (a.isSelected) {
    roundedPath(ctx, rect, radius);
    ctx.strokeStyle = palette.clipBorderSelected;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (a.isGenerating) {
    roundedPath(ctx, rect, radius);
    ctx.fillStyle = css(palette.overlayPrimary, 0.08);
    ctx.fill();
  }
  if (a.isMissing && !a.isGenerating) {
    roundedPath(ctx, rect, radius);
    ctx.fillStyle = css(palette.error, 0.25);
    ctx.fill();
    ctx.strokeStyle = css(palette.error, 0.8);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const detail = rect.width >= ClipSizes.detailMinWidth;
  if (showsLabel(a.isSelected, rect) && type !== "text") {
    drawLabelBar(dc, a, { x: rect.x, y: rect.y, width: rect.width, height: labelBar }, style);
  } else if (a.multicamAngleLabel !== undefined && rect.width >= ClipSizes.borderMinWidth) {
    ctx.fillStyle = css(palette.multicam);
    ctx.beginPath();
    const d = ClipSizes.dotSize;
    ctx.ellipse(rect.x + 2 + d / 2, rect.y + 2 + d / 2, d / 2, d / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (detail && a.linkOffset !== undefined && a.linkOffset !== 0) drawOffsetBadge(dc, a.linkOffset, rect);
  if (detail && a.showsKeyframeAutomation) drawKeyframeMarkers(dc, clip, rect);

  if (type === "audio" && clip.sourceClipType !== "sequence" && a.asset && markBeats()) {
    const beats = dc.visuals.beats?.(a.asset);
    if (beats) drawBeatTicks(dc, beats, clip, rect, content, a.fps);
  }

  if (translucent) ctx.restore();
}

// MARK: - Beat ticks

function drawBeatTicks(dc: ClipDrawContext, analysis: BeatAnalysis, clip: Clip, rect: Rect, body: Rect, fps: number): void {
  if (!beatTicksFit(body.height)) return;
  const ticks = planBeatTicks(analysis, clip, rect.width, fps);
  if (ticks.length === 0) return;
  const { ctx, palette } = dc;
  const box = (t: { x: number; isDown: boolean }): Rect => ({
    x: rect.x + t.x - beatTickWidth / 2,
    y: body.y,
    width: beatTickWidth,
    height: t.isDown ? downbeatTickHeight : beatTickHeight,
  });
  ctx.fillStyle = css(palette.overlayBg, 0.55);
  for (const t of ticks) {
    const b = box(t);
    ctx.fillRect(b.x - 1, b.y, b.width + 2, b.height + 1);
  }
  ctx.fillStyle = css(palette.orange, 0.7);
  for (const t of ticks) if (!t.isDown) ctx.fillRect(box(t).x, body.y, beatTickWidth, beatTickHeight);
  ctx.fillStyle = css(palette.orange);
  for (const t of ticks) if (t.isDown) ctx.fillRect(box(t).x, body.y, beatTickWidth, downbeatTickHeight);
}

// MARK: - Keyframe markers (non-volume tracks, bottom edge)

function drawKeyframeMarkers(dc: ClipDrawContext, clip: Clip, rect: Rect): void {
  const frames = new Set<number>();
  const add = (kfs: readonly { frame: number }[] | undefined) => {
    if (kfs) for (const k of kfs) frames.add(k.frame + clip.startFrame);
  };
  add(clip.opacityTrack?.keyframes);
  add(clip.positionTrack?.keyframes);
  add(clip.scaleTrack?.keyframes);
  add(clip.rotationTrack?.keyframes);
  add(clip.cropTrack?.keyframes);
  add(clipBlurKeyframeTrack(clip)?.keyframes);
  if (frames.size === 0 || clip.durationFrames <= 0) return;
  const ppf = rect.width / clip.durationFrames;
  if (!(ppf > 0)) return;
  const { ctx, palette } = dc;
  const y = rect.y + rect.height - 5;
  const half = 3;
  ctx.fillStyle = css(palette.yellow, 0.95);
  ctx.strokeStyle = css(palette.overlayBg, 0.5);
  ctx.lineWidth = 0.5;
  for (const f of [...frames].sort((p, q) => p - q)) {
    if (!clipContainsTimelineFrame(clip, f)) continue;
    const x = rect.x + (f - clip.startFrame) * ppf;
    ctx.beginPath();
    ctx.moveTo(x, y - half);
    ctx.lineTo(x + half, y);
    ctx.lineTo(x, y + half);
    ctx.lineTo(x - half, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// MARK: - Waveform

function drawWaveform(dc: ClipDrawContext, samples: Float32Array, clip: Clip, style: ClipDrawStyle, draw: Rect): void {
  if (!(draw.width > 2 && draw.height > 2)) return;
  const window = waveformSampleWindow(samples.length, clipSourceDurationFrames(clip), clip.trimStartFrame, clipSourceFramesConsumed(clip));
  if (!window) return;
  const barCount = Math.trunc(draw.width);
  if (barCount <= 0) return;
  const visMin = Math.max(draw.x, dc.visible.x);
  const visMax = Math.min(draw.x + draw.width, dc.visible.x + dc.visible.width);
  const firstBar = Math.max(0, Math.trunc(visMin - draw.x));
  const lastBar = Math.min(barCount, Math.ceil(visMax - draw.x));
  if (firstBar >= lastBar) return;
  const bars = resamplePeaksToBars(samples, window, barCount, firstBar, lastBar);
  const needsPerBarVolume = (clip.volumeTrack !== undefined && keyframeTrackIsActive(clip.volumeTrack)) || clip.fadeInFrames > 0 || clip.fadeOutFrames > 0;
  const staticShift = VolumeScale.dbFromLinear(clip.volume) / waveformDbRange;
  const frameStep = Math.max(1, clip.durationFrames) / barCount;
  const { ctx } = dc;
  ctx.fillStyle = css(style.foreground, 0.7);
  ctx.beginPath();
  const bottom = draw.y + draw.height;
  for (let i = firstBar; i < lastBar; i++) {
    const shift = needsPerBarVolume
      ? VolumeScale.dbFromLinear(clipVolumeAt(clip, clip.startFrame + Math.trunc(i * frameStep))) / waveformDbRange
      : staticShift;
    const h = waveformBarHeight(bars[i - firstBar] as number, shift, draw.height);
    ctx.rect(draw.x + i, bottom - h - 1, 1, h);
  }
  ctx.fill();

  const dead = deadAirRanges?.(clip) ?? [];
  if (dead.length === 0) return;
  const visibleSourceStart = clip.trimStartFrame;
  const visibleSpan = clipSourceFramesConsumed(clip);
  let rangeIndex = 0;
  ctx.fillStyle = css(dc.palette.error, deadAirWashAlpha);
  ctx.beginPath();
  for (let i = firstBar; i < lastBar; i++) {
    const m0 = visibleSourceStart + (i * visibleSpan) / barCount;
    const m1 = visibleSourceStart + ((i + 1) * visibleSpan) / barCount;
    while (rangeIndex < dead.length && dead[rangeIndex].upperBound <= m0) rangeIndex += 1;
    if (rangeIndex < dead.length && dead[rangeIndex].lowerBound < m1) ctx.rect(draw.x + i, draw.y, 1, draw.height);
  }
  ctx.fill();
}

// MARK: - Volume rubber band / fades

function interpolatedPath(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ka: Keyframe<number>,
  dbB: number,
  body: Rect,
): void {
  switch (ka.interpolationOut) {
    case "linear":
      ctx.lineTo(bx, by);
      break;
    case "hold":
      ctx.lineTo(bx, ay);
      ctx.lineTo(bx, by);
      break;
    default:
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        ctx.lineTo(ax + (bx - ax) * t, yForDb(ka.value + (dbB - ka.value) * keyframeEase(ka, t), body));
      }
      break;
  }
}

function drawVolumeRubberBand(dc: ClipDrawContext, clip: Clip, rect: Rect, style: ClipDrawStyle, fadeControls: boolean, kfVisible: boolean): void {
  if (clip.durationFrames <= 0) return;
  const ppf = rect.width / clip.durationFrames;
  if (!(ppf > 0)) return;
  const { ctx, palette } = dc;
  const body = clipBodyRect(rect);
  const alpha = fadeControls ? 0.95 : 0.75;
  const lineColor = css(style.foreground, alpha);
  const fadeColor = css(style.foreground, alpha * 0.7);

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const track = clip.volumeTrack;
  if (track && keyframeTrackIsActive(track)) {
    const kfs = track.keyframes.filter((k) => k.frame >= 0 && k.frame <= clip.durationFrames);
    const first = kfs[0];
    if (first) {
      const firstY = yForDb(first.value, body);
      ctx.moveTo(rect.x, firstY);
      ctx.lineTo(rect.x + first.frame * ppf, firstY);
      for (let i = 0; i < kfs.length - 1; i++) {
        const ka = kfs[i] as (typeof kfs)[number];
        const kb = kfs[i + 1] as (typeof kfs)[number];
        interpolatedPath(ctx, rect.x + ka.frame * ppf, yForDb(ka.value, body), rect.x + kb.frame * ppf, yForDb(kb.value, body), ka, kb.value, body);
      }
      ctx.lineTo(rect.x + rect.width, yForDb((kfs[kfs.length - 1] as (typeof kfs)[number]).value, body));
    }
  } else {
    const y = yForDb(VolumeScale.dbFromLinear(clip.volume), body);
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.width, y);
  }
  ctx.stroke();

  const kneeY = fadeKneeY(body);
  const silenceY = body.y + body.height;
  const leftX = fadeHandleRenderX(rect, Math.min(clip.fadeInFrames, clip.durationFrames), ppf);
  const rightX = fadeHandleRenderX(rect, Math.max(0, clip.durationFrames - clip.fadeOutFrames), ppf);
  if (clip.fadeInFrames > 0) drawFadeWedge(dc, rect.x, silenceY, leftX, kneeY, clip.fadeInInterpolation, fadeColor, undefined, 0.35);
  if (clip.fadeOutFrames > 0) drawFadeWedge(dc, rect.x + rect.width, silenceY, rightX, kneeY, clip.fadeOutInterpolation, fadeColor, undefined, 0.35);
  if (!fadeControls) return;

  const half = ClipSizes.volumeKeyframeSize / 2;
  if (kfVisible && track) {
    ctx.fillStyle = css(palette.timecode);
    ctx.strokeStyle = css(palette.overlayBg, 0.5);
    ctx.lineWidth = 0.5;
    for (const kf of track.keyframes) {
      if (!(kf.frame >= 0 && kf.frame <= clip.durationFrames)) continue;
      const cx = rect.x + kf.frame * ppf;
      const cy = yForDb(kf.value, body);
      ctx.beginPath();
      traceKeyframeGlyph(ctx, kf.interpolationOut, cx, cy, half);
      ctx.fill();
      ctx.stroke();
    }
  }
  drawFadeHandle(dc, leftX - half, kneeY - half, "left", lineColor);
  drawFadeHandle(dc, rightX - half, kneeY - half, "right", lineColor);
}

function drawOpacityFades(dc: ClipDrawContext, clip: Clip, rect: Rect, style: ClipDrawStyle, fadeControls: boolean): void {
  if (clip.durationFrames <= 0) return;
  if (!(clip.fadeInFrames > 0 || clip.fadeOutFrames > 0 || fadeControls)) return;
  const ppf = rect.width / clip.durationFrames;
  if (!(ppf > 0)) return;
  const body = clipBodyRect(rect);
  const alpha = fadeControls ? 0.95 : 0.75;
  const lineColor = css(style.foreground, alpha);
  const fadeColor = css(style.foreground, alpha * 0.7);
  const kneeY = fadeKneeY(body);
  const silenceY = body.y + body.height;
  const leftX = fadeHandleRenderX(rect, Math.min(clip.fadeInFrames, clip.durationFrames), ppf);
  const rightX = fadeHandleRenderX(rect, Math.max(0, clip.durationFrames - clip.fadeOutFrames), ppf);
  if (clip.fadeInFrames > 0) drawFadeWedge(dc, rect.x, silenceY, leftX, kneeY, clip.fadeInInterpolation, fadeColor, body.y, 0.6);
  if (clip.fadeOutFrames > 0) drawFadeWedge(dc, rect.x + rect.width, silenceY, rightX, kneeY, clip.fadeOutInterpolation, fadeColor, body.y, 0.6);
  if (!fadeControls) return;
  const half = ClipSizes.volumeKeyframeSize / 2;
  drawFadeHandle(dc, leftX - half, kneeY - half, "left", lineColor);
  drawFadeHandle(dc, rightX - half, kneeY - half, "right", lineColor);
}

function curveTo(ctx: CanvasRenderingContext2D, sx: number, sy: number, ex: number, ey: number, interp: Interpolation): void {
  if (interp !== "smooth") {
    ctx.lineTo(ex, ey);
    return;
  }
  for (let s = 1; s <= 12; s++) {
    const t = s / 12;
    ctx.lineTo(sx + (ex - sx) * t, sy + (ey - sy) * smoothstep(t));
  }
}

function drawFadeWedge(
  dc: ClipDrawContext,
  sx: number,
  sy: number,
  kx: number,
  ky: number,
  interp: Interpolation,
  color: string,
  fillTopY: number | undefined,
  fillAlpha: number,
): void {
  const { ctx, palette } = dc;
  const topY = fillTopY ?? ky;
  // Fill the wedge above the curve: corner, up to the top, across to the knee, back down the curve.
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx, topY);
  ctx.lineTo(kx, topY);
  if (topY !== ky) ctx.lineTo(kx, ky);
  if (interp === "smooth") {
    for (let s = 11; s >= 1; s--) {
      const t = s / 12;
      ctx.lineTo(sx + (kx - sx) * t, sy + (ky - sy) * smoothstep(t));
    }
  }
  ctx.closePath();
  ctx.fillStyle = css(palette.overlayBg, fillAlpha);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  curveTo(ctx, sx, sy, kx, ky, interp);
  ctx.stroke();
}

function drawFadeHandle(dc: ClipDrawContext, x: number, y: number, edge: FadeEdge, fill: string): void {
  const { ctx, palette } = dc;
  const size = ClipSizes.volumeKeyframeSize;
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = css(palette.overlayBg, 0.55);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x, y, size, size);
  const g = { x: x + 1.5, y: y + 1.5, w: size - 3, h: size - 3 };
  if (g.w <= 0) return;
  const start = edge === "left" ? { x: g.x, y: g.y + g.h } : { x: g.x, y: g.y };
  const end = edge === "left" ? { x: g.x + g.w, y: g.y } : { x: g.x + g.w, y: g.y + g.h };
  const corner = edge === "left" ? { x: g.x + g.w, y: g.y + g.h } : { x: g.x, y: g.y + g.h };
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(corner.x, corner.y);
  ctx.lineTo(end.x, end.y);
  ctx.closePath();
  ctx.fillStyle = css(palette.overlayBg, 0.55);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = css(palette.overlayBg, 0.8);
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

// MARK: - Thumbnails

function drawTiled(dc: ClipDrawContext, draw: Rect, clipRect: Rect, aspect: number, image: (tileX: number) => CanvasImageSource | null | undefined): void {
  if (!(draw.width > 4 && draw.height > 4) || !(aspect > 0)) return;
  const { ctx, visible } = dc;
  const tileW = Math.max(1, draw.height * aspect);
  ctx.save();
  roundedPath(ctx, clipRect, Trim.clipCornerRadius);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(draw.x, draw.y, draw.width, draw.height);
  ctx.clip();
  let x = draw.x;
  if (visible.x > x) x += Math.floor((visible.x - x) / tileW) * tileW;
  const end = Math.min(draw.x + draw.width, visible.x + visible.width);
  for (let n = 0; x < end && n < 200; n++, x += tileW) {
    const img = image(x);
    if (img === undefined) break;
    if (img !== null) ctx.drawImage(img, x, draw.y, tileW, draw.height);
  }
  ctx.restore();
}

function drawThumbnailStrip(
  dc: ClipDrawContext,
  thumbs: { images: readonly (CanvasImageSource | null)[]; startTime: number; spacing: number; aspect: number },
  clip: Clip,
  draw: Rect,
  clipRect: Rect,
  fps: number,
): void {
  const fpsD = Math.max(1, fps);
  const startSec = clip.trimStartFrame / fpsD;
  const durationSec = clipSourceFramesConsumed(clip) / fpsD;
  if (!(durationSec > 0)) return;
  const ramped = clipHasSpeedRamp(clip);
  const count = thumbs.images.length;
  const lastTime = thumbs.startTime + (count - 1) * thumbs.spacing;
  drawTiled(dc, draw, clipRect, thumbs.aspect, (tileX) => {
    const frac = (tileX - draw.x) / draw.width;
    const timeSec = startSec + (ramped ? clipSourceFramesAt(clip, frac * clip.durationFrames) / fpsD : frac * durationSec);
    const index = thumbnailIndexForTime(timeSec, thumbs.startTime, thumbs.spacing, count, lastTime);
    return index === undefined ? undefined : (thumbs.images[index] ?? null);
  });
}

// MARK: - Labels

function drawPill(
  dc: ClipDrawContext,
  text: string,
  textColor: string,
  fill: string,
  font: string,
  fontSize: number,
  x: number,
  y: number,
  maxWidth: number,
): Rect | undefined {
  const { ctx } = dc;
  if (text === "" || !(maxWidth > ClipSizes.badgeMinWidth)) return undefined;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  const h = Math.ceil(fontSize * 1.2) + ClipSizes.badgePadV * 2;
  const rect = { x, y, width: Math.min(w + ClipSizes.badgePadH * 2, maxWidth), height: h };
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 3);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.fillStyle = textColor;
  ctx.textBaseline = "middle";
  ctx.fillText(text, rect.x + ClipSizes.badgePadH, rect.y + rect.height / 2);
  ctx.restore();
  return rect;
}

function drawLabelBar(dc: ClipDrawContext, a: ClipDrawArgs, bar: Rect, style: ClipDrawStyle): void {
  const { ctx, palette } = dc;
  let x = bar.x;
  let width = bar.width;
  if (a.multicamAngleLabel !== undefined) {
    const chip = drawPill(dc, a.multicamAngleLabel, "rgba(255,255,255,0.8)", css(palette.multicam), dc.smallBadgeFont, 9, bar.x + 4, bar.y + 2, bar.width - 8);
    if (chip) {
      x = chip.x + chip.width + 2;
      width -= chip.width + 6;
    }
  }
  const name = firstNonEmptyLine(a.displayName ?? a.clip.mediaRef);
  const text = `${name}  ${formatClipDuration(a.clip.durationFrames, a.fps)}`;
  const inset = 6;
  if (width - inset * 2 <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + inset, bar.y, width - inset * 2, bar.height);
  ctx.clip();
  ctx.font = dc.font;
  ctx.fillStyle = css(style.foreground);
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + inset, bar.y + bar.height / 2);
  ctx.restore();
}

function drawTextParagraph(dc: ClipDrawContext, clip: Clip, displayName: string | undefined, rect: Rect, style: ClipDrawStyle): void {
  const content = (clip.textContent ?? "").trim();
  const text = content === "" ? (displayName ?? "") : content;
  if (text === "") return;
  const r = { x: rect.x + 6, y: rect.y + 2, width: rect.width - 12, height: rect.height - 4 };
  if (r.width <= 0 || r.height <= 0) return;
  const { ctx } = dc;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.font = dc.font;
  ctx.fillStyle = css(style.foreground);
  ctx.textBaseline = "top";
  const lineHeight = 12;
  let y = r.y;
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && ctx.measureText(candidate).width > r.width) {
        ctx.fillText(line, r.x, y);
        y += lineHeight;
        if (y > r.y + r.height) break;
        line = word;
      } else line = candidate;
    }
    if (y > r.y + r.height) break;
    ctx.fillText(line, r.x, y);
    y += lineHeight;
  }
  ctx.restore();
}

function drawOffsetBadge(dc: ClipDrawContext, frames: number, rect: Rect): void {
  const text = frames > 0 ? `+${frames}` : `${frames}`;
  dc.ctx.font = dc.badgeFont;
  const width = dc.ctx.measureText(text).width + ClipSizes.badgePadH * 2;
  const x = rect.x + rect.width - Trim.handleWidth - width - 2;
  if (!(x > rect.x + 6)) return;
  drawPill(dc, text, "#fff", "rgb(229, 79, 79)", dc.badgeFont, 10, x, rect.y + 2, width);
}
