import {
  Layout,
  clipEndFrame,
  clipInterpolation,
  clipKeyframeFramesIntersecting,
  clipSourceFramesConsumed,
  clipSupportsKeyframes,
  makeClip,
  timelineMarkerEndFrame,
  timelineMarkerIsRange,
  type Clip,
  type MediaAsset,
  type Rect,
  type Timeline,
} from "../../model";
import type { Editor } from "../../editor/editor";
import { clipDisplayLabel } from "../../editor/mutations/core";
import { effectiveTrimEnd, linkGroupOffsets, linkedPartnerIds, resolveDropPlan, slipPropagationPartnerIds, zones, type DropPlan } from "../../editor/mutations/linking";
import { planRippleInsertPreview, planRippleTrim, type RippleInsertPreviewPlan, type RippleTrimPlan } from "../../editor/mutations/ripple";
import { validSelectedTimelineRange } from "../../editor/mutations/timelineRange";
import { swiftRound } from "../../util/math";
import { secondsToFrame } from "../../util/timeFormatting";
import { moveClipDragAll, moveClipDragTrackDelta } from "../dragState";
import {
  clipRectAtY,
  clipRectFor,
  frameAt,
  ghostY,
  insertionLineY,
  laneRect,
  trackHeightAt,
  trackYAt,
  xForFrame,
  type TimelineGeometry,
  type TrackDropTarget,
} from "../timelineGeometry";
import { computeRulerTicks } from "../timelineRuler";
import type { TimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { css, type CanvasPalette } from "./canvasPalette";
import { traceKeyframeGlyph } from "./keyframeGlyph";
import { drawClip, type ClipDrawContext, type ClipDrawStyle } from "./clipRenderer";
import { showsLabel } from "./clipRendererRules";
import { drawTransitions } from "../../transitions/timelineTransitions";
import type { TimelineInputController } from "./inputController";
import { displayedTimelineMarkers } from "./timelineMarkerCommands";
import { MarkerMetrics, markerFlagRect, markerPathPoints } from "./timelineMarkerGeometry";
import type { TimelineVisualSource } from "./visualSource";

// Canvas port of TimelineView.drawContent (clips layer) and the playhead / snap overlays.

export interface TimelineRenderInput {
  editor: Editor;
  controller: TimelineInputController;
  geometry: TimelineGeometry;
  laneState: TimelineKeyframeLaneState;
  palette: CanvasPalette;
  styles: Map<Clip["sourceClipType"], ClipDrawStyle>;
  visuals: TimelineVisualSource;
  scrollX: number;
  scrollY: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio. */
  dpr: number;
  isClipOffline: (clip: Clip) => boolean;
  isClipGenerating: (clip: Clip) => boolean;
}

interface DerivedCache {
  timeline: Timeline | undefined;
  linkOffsets: Map<string, number>;
  angleLabels: Map<string, Map<string, string>>;
  doc: unknown;
  assets: Map<string, MediaAsset>;
  /** clipDisplayLabel for non-text clips depends only on the media ref. */
  labels: Map<string, string>;
}

const derived = new WeakMap<Editor, DerivedCache>();

function derivedFor(editor: Editor): DerivedCache {
  let cache = derived.get(editor);
  if (!cache) {
    cache = { timeline: undefined, linkOffsets: new Map(), angleLabels: new Map(), doc: undefined, assets: new Map(), labels: new Map() };
    derived.set(editor, cache);
  }
  if (cache.timeline !== editor.timeline) {
    cache.timeline = editor.timeline;
    cache.linkOffsets = linkGroupOffsets(editor);
    cache.angleLabels = new Map(editor.doc.multicamGroups.map((g) => [g.id, new Map(g.members.map((m) => [m.mediaRef, m.angleLabel]))]));
  }
  if (cache.doc !== editor.doc) {
    cache.doc = editor.doc;
    cache.assets = new Map(editor.mediaAssets.map((a) => [a.id, a]));
    cache.labels = new Map();
  }
  return cache;
}

/** Device-pixel-aligned rectangle fill so 1px lines stay crisp at fractional scale factors. */
function crispFill(ctx: CanvasRenderingContext2D, dpr: number, x: number, y: number, w: number, h: number): void {
  const x0 = Math.round(x * dpr) / dpr;
  const y0 = Math.round(y * dpr) / dpr;
  const x1 = Math.round((x + w) * dpr) / dpr;
  const y1 = Math.max(y0 + 1 / dpr, Math.round((y + h) * dpr) / dpr);
  ctx.fillRect(x0, y0, Math.max(1 / dpr, x1 - x0), y1 - y0);
}

/** Document-space visible rect. */
function visibleRect(r: TimelineRenderInput): Rect {
  return { x: r.scrollX, y: r.scrollY, width: r.width, height: r.height };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** First clip index whose end is past `frame` (clips on a track are sorted and never overlap). */
function firstClipEndingAfter(clips: readonly Clip[], frame: number): number {
  let lo = 0;
  let hi = clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clipEndFrame(clips[mid] as Clip) <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// MARK: - Clips layer

export function drawClipsLayer(ctx: CanvasRenderingContext2D, r: TimelineRenderInput): void {
  const { editor, geometry: geo, palette, dpr } = r;
  const visible = visibleRect(r);
  ctx.setTransform(dpr, 0, 0, dpr, -r.scrollX * dpr, -r.scrollY * dpr);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(visible.x, visible.y, visible.width, visible.height);

  const font = `500 10px ${palette.fontUI}`;
  const dc: ClipDrawContext = {
    ctx,
    palette,
    styles: r.styles,
    visuals: r.visuals,
    visible,
    font,
    badgeFont: `600 10px ${palette.fontUI}`,
    smallBadgeFont: `600 9px ${palette.fontUI}`,
  };

  drawTrackBackgrounds(ctx, r, visible);
  drawKeyframeLanes(ctx, r, visible);

  const range = validSelectedTimelineRange(editor);
  if (range) {
    ctx.fillStyle = css(palette.textPrimary, 0.06);
    const minX = xForFrame(geo, range.startFrame);
    ctx.fillRect(minX, Layout.rulerHeight, xForFrame(geo, range.endFrame) - minX, Math.max(visible.y + visible.height, 0));
  }

  const external = r.controller.external;
  let insertPreview: RippleInsertPreviewPlan | null = null;
  let externalPlan: DropPlan | undefined;
  if (external && external.assets.length > 0) {
    externalPlan = resolveDropPlan(editor, external.target, external.assets, external.frame, external.segments);
    if (external.isRippleInsert) insertPreview = planRippleInsertPreview(editor, externalPlan, external.frame);
  }
  if (insertPreview) drawRippleInsertGapBand(ctx, r, insertPreview);

  drawClips(dc, r, insertPreview);
  drawTransitions(ctx, r);
  drawGapSelection(ctx, r);

  if (external && externalPlan) {
    drawExternalGhosts(dc, r, externalPlan);
    if (external.isRippleInsert) {
      drawRippleInsertIndicator(ctx, r, external.frame);
      drawRippleInsertBadge(ctx, r, external.frame);
    }
  }

  const drag = r.controller.dragState;
  let activeDropTarget: TrackDropTarget | undefined;
  if (drag.kind === "moveClip" && drag.drag.dropTarget.kind === "newTrackAt") activeDropTarget = drag.drag.dropTarget;
  else if (external && external.target.kind === "newTrackAt") activeDropTarget = external.target;
  if (activeDropTarget) {
    const lineY = insertionLineY(geo, activeDropTarget);
    if (lineY !== undefined) {
      ctx.fillStyle = css(palette.yellow);
      ctx.fillRect(visible.x, lineY - 1, visible.width, 2);
    }
  }

  drawRuler(ctx, r);
  drawMarkers(ctx, r);
}

function drawTrackBackgrounds(ctx: CanvasRenderingContext2D, r: TimelineRenderInput, visible: Rect): void {
  const { editor, geometry: geo, palette, dpr } = r;
  const tracks = editor.timeline.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const y = trackYAt(geo, i);
    const h = trackHeightAt(geo, i);
    const bottom = geo.blockBottoms[i] ?? y + h;
    if (bottom < visible.y || y > visible.y + visible.height) continue;
    ctx.fillStyle = palette.borderPrimary;
    if (i === 0) crispFill(ctx, dpr, visible.x, y, visible.width, 1);
    crispFill(ctx, dpr, visible.x, y + h - 1, visible.width, 1);
    for (const property of geo.laneProperties[i] ?? []) {
      const lane = laneRect(geo, i, property);
      if (!lane) continue;
      ctx.fillStyle = palette.base;
      ctx.fillRect(visible.x, lane.y, visible.width, lane.height);
      ctx.fillStyle = palette.borderSubtle;
      crispFill(ctx, dpr, visible.x, lane.y + lane.height - 1, visible.width, 1);
    }
  }
  const z = zones(editor);
  if (z.videoTrackCount > 0 && z.audioTrackCount > 0) {
    ctx.fillStyle = css(palette.divider, 0.35);
    crispFill(ctx, dpr, visible.x, trackYAt(geo, z.firstAudioIndex) - 1, visible.width, 2);
  }
}

function drawKeyframeLanes(ctx: CanvasRenderingContext2D, r: TimelineRenderInput, visible: Rect): void {
  const { editor, geometry: geo, palette } = r;
  const half = 4;
  const padding = Math.max(1, Math.ceil(half / Math.max(geo.pixelsPerFrame, 0.0001)));
  const firstFrame = Math.max(0, frameAt(geo, visible.x) - padding);
  const lastFrame = Math.max(firstFrame, frameAt(geo, visible.x + visible.width) + padding);
  editor.timeline.tracks.forEach((track, ti) => {
    const properties = geo.laneProperties[ti] ?? [];
    if (properties.length === 0) return;
    for (const clip of track.clips) {
      const sx = xForFrame(geo, clip.startFrame);
      const sw = clip.durationFrames * geo.pixelsPerFrame;
      if (sx + sw < visible.x || sx > visible.x + visible.width) continue;
      const selected = editor.ui.selectedClipIds.has(clip.id);
      for (const property of properties) {
        const lane = laneRect(geo, ti, property);
        if (!lane || !intersects(lane, visible)) continue;
        const seg = { x: sx, y: lane.y + 2, width: sw, height: lane.height - 4 };
        const eligible = clipSupportsKeyframes(clip, property);
        const style = r.styles.get(clip.sourceClipType) as ClipDrawStyle;
        ctx.globalAlpha = eligible ? (selected ? 0.25 : 0.1) : 0.04;
        ctx.fillStyle = eligible ? style.fill : css(palette.textMuted);
        ctx.fillRect(seg.x, seg.y, seg.width, seg.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = selected ? palette.clipBorderSelected : palette.borderSubtle;
        ctx.lineWidth = selected ? 1.5 : 0.5;
        ctx.beginPath();
        ctx.moveTo(seg.x, seg.y);
        ctx.lineTo(seg.x, seg.y + seg.height);
        ctx.moveTo(seg.x + seg.width, seg.y);
        ctx.lineTo(seg.x + seg.width, seg.y + seg.height);
        ctx.stroke();
        if (!eligible) continue;
        ctx.fillStyle = css(palette.timecode);
        const cy = lane.y + lane.height / 2;
        for (const frame of clipKeyframeFramesIntersecting(clip, property, firstFrame, lastFrame)) {
          const x = xForFrame(geo, frame);
          ctx.beginPath();
          traceKeyframeGlyph(ctx, clipInterpolation(clip, property, frame) ?? "linear", x, cy, half);
          ctx.fill();
        }
      }
    }
  });
}

function drawClips(dc: ClipDrawContext, r: TimelineRenderInput, insertPreview: RippleInsertPreviewPlan | null): void {
  const { editor, geometry: geo, controller } = r;
  const ctx = dc.ctx;
  const visible = dc.visible;
  const fps = editor.timeline.fps;
  const ui = editor.ui;
  const selectedIds = ui.selectedClipIds;
  const cache = derivedFor(editor);
  const state = controller.dragState;

  const moveDrag = state.kind === "moveClip" ? state.drag : undefined;
  const trimDrag = state.kind === "trimLeft" || state.kind === "trimRight" ? state.drag : undefined;
  const trimIsLeft = state.kind === "trimLeft";
  const slipDrag = state.kind === "slip" ? state.drag : undefined;
  const draggedIds = moveDrag ? new Set(moveClipDragAll(moveDrag).map((p) => p.clipId)) : undefined;
  const trackDelta = moveDrag ? moveClipDragTrackDelta(moveDrag) : 0;
  const trimPartners = trimDrag?.propagateToLinked ? new Set(linkedPartnerIds(editor, trimDrag.clipId)) : undefined;
  const slipPartners = slipDrag?.propagateToLinked ? new Set(slipPropagationPartnerIds(editor, slipDrag.clipId)) : undefined;
  let ripplePlan: RippleTrimPlan | null = null;
  if (trimDrag?.isRipple) ripplePlan = planRippleTrim(editor, trimDrag.clipId, trimIsLeft ? "left" : "right", trimDrag.deltaFrames, trimDrag.propagateToLinked);
  const rippleShift = new Map(ripplePlan?.shifts.map((s) => [s.clipId, s.newStartFrame]) ?? []);
  const rippleResize = new Map(ripplePlan?.resizes.map((s) => [s.clipId, s]) ?? []);
  const fullScan = moveDrag !== undefined || ripplePlan !== null || insertPreview !== null;

  const angleLabel = (clip: Clip): string | undefined =>
    clip.multicamGroupId === undefined ? undefined : cache.angleLabels.get(clip.multicamGroupId)?.get(clip.mediaRef);
  const label = (clip: Clip): string => {
    if (clip.mediaType === "text") return clipDisplayLabel(editor, clip);
    let l = cache.labels.get(clip.mediaRef);
    if (l === undefined) {
      l = clipDisplayLabel(editor, clip);
      cache.labels.set(clip.mediaRef, l);
    }
    return l;
  };
  const draw = (clip: Clip, source: Clip, rect: Rect, isSelected: boolean, opacity: number, extra: { linkOffset?: number; hovered?: boolean; automation?: boolean } = {}) => {
    if (!intersects(rect, visible)) return;
    drawClip(dc, {
      clip,
      type: source.mediaType,
      rect,
      isSelected,
      isHovered: extra.hovered ?? false,
      opacity,
      displayName: showsLabel(isSelected, rect) ? label(source) : undefined,
      linkOffset: extra.linkOffset,
      multicamAngleLabel: angleLabel(source),
      fps,
      showsKeyframeAutomation: extra.automation ?? true,
      isMissing: r.isClipOffline(source),
      isGenerating: r.isClipGenerating(source),
      asset: cache.assets.get(source.mediaRef),
    });
  };
  const deferred: (() => void)[] = [];

  const tracks = editor.timeline.tracks;
  const visStart = frameAt(geo, visible.x) - 1;
  const visEnd = frameAt(geo, visible.x + visible.width) + 1;
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    const top = trackYAt(geo, ti);
    if (!fullScan && (top > visible.y + visible.height || top + trackHeightAt(geo, ti) < visible.y)) continue;
    const clips = track.clips;
    const begin = fullScan ? 0 : firstClipEndingAfter(clips, visStart);
    const automation = !r.laneState.expandedTrackIds.has(track.id);
    for (let ci = begin; ci < clips.length; ci++) {
      const clip = clips[ci] as Clip;
      if (!fullScan && clip.startFrame > visEnd) break;
      const isSelected = selectedIds.has(clip.id);

      const shift = insertPreview?.shiftDeltasByClipId.get(clip.id);
      if (shift !== undefined) {
        const preview = { ...clip, startFrame: clip.startFrame + shift };
        draw(preview, clip, clipRectFor(geo, preview, ti), isSelected, 0.8);
        continue;
      }

      if (moveDrag && draggedIds?.has(clip.id)) {
        draw(clip, clip, clipRectFor(geo, clip, ti), moveDrag.isDuplicate && isSelected, moveDrag.isDuplicate ? 1 : 0.3);
        const ghost = { ...clip, startFrame: Math.max(0, clip.startFrame + moveDrag.deltaFrames) };
        const pinned = controller.movePinnedIds.has(clip.id);
        let rect: Rect;
        const gy = moveDrag.dropTarget.kind === "newTrackAt" && !pinned && ti === moveDrag.lead.originalTrack ? ghostY(geo, moveDrag.dropTarget) : undefined;
        if (gy !== undefined) rect = clipRectAtY(geo, ghost, gy, Layout.trackHeight);
        else rect = clipRectFor(geo, ghost, pinned ? ti : ti + trackDelta);
        deferred.push(() => draw(ghost, clip, rect, true, 0.7));
        continue;
      }

      if (trimDrag && (clip.id === trimDrag.clipId || trimPartners?.has(clip.id) || rippleResize.has(clip.id)) && !(trimDrag.isRipple && !rippleResize.has(clip.id))) {
        const preview = { ...clip };
        const resize = rippleResize.get(clip.id);
        if (resize) {
          preview.trimStartFrame = resize.trimStart;
          preview.trimEndFrame = resize.trimEnd;
          preview.durationFrames = resize.duration;
        } else {
          const sourceDelta = swiftRound(trimDrag.deltaFrames * clip.speed);
          if (trimIsLeft) {
            preview.startFrame = clip.startFrame + trimDrag.deltaFrames;
            preview.trimStartFrame = clip.trimStartFrame + sourceDelta;
            preview.durationFrames = clip.durationFrames - trimDrag.deltaFrames;
          } else {
            preview.durationFrames = clip.durationFrames + trimDrag.deltaFrames;
            preview.trimEndFrame = clip.trimEndFrame - sourceDelta;
          }
        }
        const rect = clipRectFor(geo, preview, ti);
        deferred.push(() => draw(preview, clip, rect, isSelected, 1));
        continue;
      }

      if (slipDrag && (clip.id === slipDrag.clipId || slipPartners?.has(clip.id))) {
        const preview = { ...clip };
        const sourceDelta = swiftRound(slipDrag.deltaFrames * clip.speed);
        const applied = Math.max(-clip.trimEndFrame, Math.min(clip.trimStartFrame, sourceDelta));
        preview.trimStartFrame = clip.trimStartFrame - applied;
        preview.trimEndFrame = clip.trimEndFrame + applied;
        const rect = clipRectFor(geo, clip, ti);
        drawSlipSourceRange(dc, r, preview, clip, rect);
        deferred.push(() => {
          draw(preview, clip, rect, isSelected, 1);
          drawSlipChrome(dc, r, rect, isSelected);
        });
        continue;
      }

      const shifted = rippleShift.get(clip.id);
      if (shifted !== undefined) {
        const preview = { ...clip, startFrame: shifted };
        draw(preview, clip, clipRectFor(geo, preview, ti), isSelected, 1, { linkOffset: cache.linkOffsets.get(clip.id) });
        continue;
      }

      draw(clip, clip, clipRectFor(geo, clip, ti), isSelected, 1, {
        linkOffset: cache.linkOffsets.get(clip.id),
        hovered: controller.hoveredClipId === clip.id,
        automation,
      });
    }
  }
  for (const d of deferred) d();

  // Red wall at the sync-locked obstacle a ripple trim butts against.
  if (ripplePlan?.blockedAtFrame !== undefined) {
    ctx.fillStyle = css(r.palette.error);
    ctx.fillRect(xForFrame(geo, ripplePlan.blockedAtFrame) - 1, Layout.rulerHeight, 2, visible.y + visible.height);
  }
}

function slipSourceRect(editor: Editor, clip: Clip, active: Rect, ppf: number): Rect {
  const speed = Math.max(clip.speed, 0.001);
  const sourceFrames = clip.trimStartFrame + clipSourceFramesConsumed(clip) + effectiveTrimEnd(editor, clip);
  return {
    x: active.x - (clip.trimStartFrame / speed) * ppf,
    y: active.y,
    width: Math.max(1, sourceFrames / speed) * ppf,
    height: active.height,
  };
}

function drawSlipSourceRange(dc: ClipDrawContext, r: TimelineRenderInput, preview: Clip, source: Clip, active: Rect): void {
  const { editor, palette } = r;
  const ctx = dc.ctx;
  const rect = slipSourceRect(editor, preview, active, r.geometry.pixelsPerFrame);
  if (!intersects(rect, dc.visible)) return;
  const speed = Math.max(preview.speed, 0.001);
  const sourceFrames = preview.trimStartFrame + clipSourceFramesConsumed(preview) + effectiveTrimEnd(editor, preview);
  const full = { ...preview, durationFrames: Math.max(1, swiftRound(sourceFrames / speed)), trimStartFrame: 0, trimEndFrame: 0 };
  drawClip(dc, {
    clip: full,
    type: source.mediaType,
    rect,
    isSelected: false,
    isHovered: false,
    opacity: 0.35,
    displayName: clipDisplayLabel(editor, source),
    linkOffset: undefined,
    multicamAngleLabel: undefined,
    fps: editor.timeline.fps,
    showsKeyframeAutomation: true,
    isMissing: r.isClipOffline(source),
    isGenerating: r.isClipGenerating(source),
    asset: editor.mediaAsset(source.mediaRef),
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.rect(active.x, active.y, active.width, active.height);
  ctx.fillStyle = palette.base;
  ctx.globalAlpha = 0.35;
  ctx.fill("evenodd");
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.roundRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1, 4);
  ctx.strokeStyle = css(palette.textPrimary, 0.8);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawSlipChrome(dc: ClipDrawContext, r: TimelineRenderInput, active: Rect, isSelected: boolean): void {
  const ctx = dc.ctx;
  ctx.strokeStyle = css(r.palette.textPrimary);
  ctx.lineWidth = 2;
  ctx.strokeRect(active.x + 0.5, active.y + 0.5, active.width - 1, active.height - 1);
  if (!isSelected) return;
  ctx.fillStyle = css(r.palette.textPrimary);
  const h = Math.min(active.height, 22);
  ctx.fillRect(active.x - 1, active.y, 2, h);
  ctx.fillRect(active.x + active.width - 1, active.y, 2, h);
}

function drawGapSelection(ctx: CanvasRenderingContext2D, r: TimelineRenderInput): void {
  const gap = r.editor.ui.selectedGap;
  if (!gap || !r.editor.timeline.tracks[gap.trackIndex]) return;
  const geo = r.geometry;
  const y = trackYAt(geo, gap.trackIndex);
  const h = trackHeightAt(geo, gap.trackIndex);
  const minX = xForFrame(geo, gap.range.start);
  const maxX = xForFrame(geo, gap.range.end);
  ctx.fillStyle = css(r.palette.textPrimary, 0.12);
  ctx.strokeStyle = css(r.palette.textPrimary, 0.9);
  ctx.lineWidth = 1;
  ctx.setLineDash(dash3);
  ctx.beginPath();
  ctx.rect(minX + 0.5, y + 2.5, maxX - minX - 1, h - 5);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash(noDash);
}

function placeholderClip(asset: MediaAsset, mediaType: Clip["mediaType"], startFrame: number, durationFrames: number, segmentStart: number | undefined, fps: number): Clip {
  const clip = makeClip({ id: `ghost-${asset.id}-${mediaType}`, mediaRef: asset.id, mediaType, sourceClipType: asset.type, startFrame, durationFrames });
  if (segmentStart !== undefined) {
    const start = secondsToFrame(segmentStart, fps);
    clip.trimStartFrame = start;
    clip.trimEndFrame = start + clip.durationFrames;
  }
  return clip;
}

function drawExternalGhosts(dc: ClipDrawContext, r: TimelineRenderInput, plan: DropPlan): void {
  const { editor, geometry: geo } = r;
  const external = r.controller.external;
  if (!external) return;
  const fps = editor.timeline.fps;
  const ghostRect = (target: TrackDropTarget, probe: Clip): Rect | undefined => {
    if (target.kind === "existingTrack") return clipRectFor(geo, probe, target.index);
    const y = ghostY(geo, target, Layout.trackHeight);
    return y === undefined ? undefined : clipRectAtY(geo, probe, y, Layout.trackHeight);
  };
  for (const p of plan.placements) {
    const seg = external.segments[p.asset.id]?.lowerBound;
    const kinds: [boolean, Clip["mediaType"], TrackDropTarget | undefined][] = [
      [p.hasVisual, p.asset.type, plan.visualTarget],
      [p.hasAudio, "audio", plan.audioTarget],
    ];
    for (const [has, type, target] of kinds) {
      if (!has || !target) continue;
      const probe = placeholderClip(p.asset, type, p.startFrame, p.durationFrames, seg, fps);
      const rect = ghostRect(target, probe);
      if (!rect || !intersects(rect, dc.visible)) continue;
      drawClip(dc, {
        clip: probe,
        type,
        rect,
        isSelected: true,
        isHovered: false,
        opacity: 0.5,
        displayName: undefined,
        linkOffset: undefined,
        multicamAngleLabel: undefined,
        fps,
        showsKeyframeAutomation: true,
        isMissing: false,
        isGenerating: false,
        asset: p.asset,
      });
    }
  }
}

function parseTargetKey(key: string): TrackDropTarget | undefined {
  const [kind, index] = key.split(":");
  const i = Number(index);
  if (!Number.isInteger(i)) return undefined;
  return kind === "newTrackAt" ? { kind: "newTrackAt", index: i } : kind === "existingTrack" ? { kind: "existingTrack", index: i } : undefined;
}

function drawRippleInsertGapBand(ctx: CanvasRenderingContext2D, r: TimelineRenderInput, preview: RippleInsertPreviewPlan): void {
  const geo = r.geometry;
  ctx.fillStyle = css(r.palette.timecode, 0.08);
  ctx.strokeStyle = css(r.palette.timecode, 0.35);
  ctx.lineWidth = 1;
  const band = (start: number, end: number, y: number, height: number) => {
    const minX = xForFrame(geo, start);
    const maxX = xForFrame(geo, end);
    if (!(maxX > minX)) return;
    ctx.beginPath();
    ctx.rect(minX + 0.5, y + 2 + 0.5, maxX - minX - 1, Math.max(0, height - 4) - 1);
    ctx.fill();
    ctx.stroke();
  };
  for (const [ti, range] of preview.gapRangesByTrackIndex) {
    if (r.editor.timeline.tracks[ti]) band(range.start, range.end, trackYAt(geo, ti), trackHeightAt(geo, ti));
  }
  for (const [key, range] of preview.newTrackGapRangesByTarget) {
    const target = parseTargetKey(key);
    const y = target ? ghostY(geo, target) : undefined;
    if (y !== undefined) band(range.start, range.end, y, Layout.trackHeight);
  }
}

function drawRippleInsertIndicator(ctx: CanvasRenderingContext2D, r: TimelineRenderInput, frame: number): void {
  const x = xForFrame(r.geometry, frame);
  const top = Layout.rulerHeight;
  const color = css(r.palette.timecode);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, r.scrollY + r.height);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + 6, top + 5);
  ctx.lineTo(x, top + 10);
  ctx.closePath();
  ctx.fill();
}

function drawRippleInsertBadge(ctx: CanvasRenderingContext2D, r: TimelineRenderInput, frame: number): void {
  const text = "Ripple Insert";
  ctx.font = `10px ${r.palette.fontUI}`;
  const tw = ctx.measureText(text).width;
  const width = tw + 20;
  const height = 12 + 8;
  const minX = r.scrollX + 4;
  const maxX = Math.max(minX, r.scrollX + r.width - width - 4);
  const x = Math.min(maxX, Math.max(minX, xForFrame(r.geometry, frame) + 10));
  const y = r.scrollY + Layout.rulerHeight + 4;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fillStyle = css(r.palette.prominent, 0.8);
  ctx.fill();
  ctx.strokeStyle = css(r.palette.timecode, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = css(r.palette.textPrimary);
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 10, y + height / 2);
}

// MARK: - Ruler and markers (pinned to the top of the viewport)

function drawRuler(ctx: CanvasRenderingContext2D, r: TimelineRenderInput): void {
  const { editor, palette, dpr } = r;
  const top = r.scrollY;
  const left = r.scrollX;
  const h = Layout.rulerHeight;
  ctx.fillStyle = palette.surface;
  ctx.fillRect(left, top, r.width, h);
  const ticks = computeRulerTicks(r.width, editor.timeline.fps, r.geometry.pixelsPerFrame, r.scrollX);
  ctx.fillStyle = css(palette.textMuted, 0.4);
  for (const t of ticks.minor) crispFill(ctx, dpr, left + t.x, top, 0.5, t.height);
  ctx.fillStyle = css(palette.textMuted);
  for (const t of ticks.major) crispFill(ctx, dpr, left + t.x, top, 1, 8);
  ctx.fillStyle = palette.textTertiary;
  ctx.font = `10px ${palette.fontUI}`;
  ctx.textBaseline = "bottom";
  for (const t of ticks.major) ctx.fillText(t.label, left + t.x + 4, top + h - 2);

  const range = validSelectedTimelineRange(editor);
  if (range) {
    const minX = xForFrame(r.geometry, range.startFrame);
    const maxX = xForFrame(r.geometry, range.endFrame);
    ctx.fillStyle = css(palette.textPrimary, 0.1);
    ctx.fillRect(minX, top, maxX - minX, h);
    ctx.fillStyle = css(palette.timecode, 0.8);
    ctx.fillRect(minX - 0.75, top, 1.5, h);
    ctx.fillRect(maxX - 0.75, top, 1.5, h);
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, r: TimelineRenderInput): void {
  const { editor, geometry: geo, palette } = r;
  const markers = displayedTimelineMarkers(editor, editor.ui.timelineMarkerPreview);
  const drag = r.controller.dragState;
  if (drag.kind === "timelineMarker") {
    const i = markers.findIndex((m) => m.id === drag.drag.original.id);
    if (i >= 0) markers[i] = drag.drag.value;
  }
  const selected = editor.ui.selectedTimelineMarkerIds;
  const top = r.scrollY;
  for (const marker of markers) {
    const startX = xForFrame(geo, marker.startFrame);
    if (startX > r.scrollX + r.width + MarkerMetrics.flagWidth) continue;
    const endX = timelineMarkerIsRange(marker) ? xForFrame(geo, timelineMarkerEndFrame(marker)) : startX;
    if (endX < r.scrollX - MarkerMetrics.flagWidth) continue;
    const color = `rgba(${Math.round(marker.color.r * 255)}, ${Math.round(marker.color.g * 255)}, ${Math.round(marker.color.b * 255)}, `;
    const flag = markerFlagRect(marker, geo, top);
    const shapes = timelineMarkerIsRange(marker)
      ? [markerPathPoints(flag, "start"), markerPathPoints({ ...flag, x: flag.x + endX - startX }, "end")]
      : [markerPathPoints(flag)];
    if (timelineMarkerIsRange(marker)) {
      ctx.fillStyle = `${color}${marker.color.a * 0.55})`;
      ctx.fillRect(startX, top, Math.max(0, endX - startX), MarkerMetrics.rangeBarHeight);
    }
    const isSelected = selected.has(marker.id);
    for (const points of shapes) {
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = `${color}${marker.color.a})`;
      ctx.fill();
      ctx.strokeStyle = isSelected ? palette.clipBorderSelected : palette.clipBorder;
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();
    }
  }
}

// MARK: - Overlay (playhead, snap line, razor line, marquee). No allocations on this path.

const dash4: number[] = [4, 4];
const dash3: number[] = [3, 3];
const noDash: number[] = [];

export interface OverlayColors {
  playhead: string;
  snap: string;
  razor: string;
  marqueeStroke: string;
  marqueeFill: string;
}

export function overlayColors(palette: CanvasPalette): OverlayColors {
  return {
    playhead: palette.playhead,
    snap: css(palette.yellow),
    razor: css(palette.orange, 0.8),
    marqueeStroke: css(palette.textPrimary, 0.6),
    marqueeFill: css(palette.textPrimary, 0.1),
  };
}

export interface OverlayInput {
  controller: TimelineInputController;
  pixelsPerFrame: number;
  currentFrame: number;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  dpr: number;
  colors: OverlayColors;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayInput): void {
  const { dpr, controller: c } = o;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const lineX = (docX: number) => (Math.round((docX - o.scrollX) * dpr) + 0.5) / dpr;

  if (c.razorPreviewFrame !== undefined) {
    const x = lineX(c.razorPreviewFrame * o.pixelsPerFrame);
    ctx.strokeStyle = o.colors.razor;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash(dash4);
    ctx.beginPath();
    ctx.moveTo(x, Layout.rulerHeight);
    ctx.lineTo(x, o.height);
    ctx.stroke();
    ctx.setLineDash(noDash);
  }

  const snapX = c.snapIndicatorX ?? c.externalSnapX;
  if (snapX !== undefined) {
    const x = lineX(snapX);
    ctx.strokeStyle = o.colors.snap;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash4);
    ctx.beginPath();
    ctx.moveTo(x, Layout.rulerHeight - o.scrollY);
    ctx.lineTo(x, o.height);
    ctx.stroke();
    ctx.setLineDash(noDash);
  }

  const state = c.dragState;
  if (state.kind === "marquee" && (state.drag.current.width > 0 || state.drag.current.height > 0)) {
    const m = state.drag.current;
    ctx.strokeStyle = o.colors.marqueeStroke;
    ctx.fillStyle = o.colors.marqueeFill;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash3);
    ctx.beginPath();
    ctx.rect(m.x - o.scrollX, m.y - o.scrollY, m.width, m.height);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash(noDash);
  }

  const px = lineX(o.currentFrame * o.pixelsPerFrame);
  if (px >= -8 && px <= o.width + 8) {
    ctx.strokeStyle = o.colors.playhead;
    ctx.fillStyle = o.colors.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, o.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px, 8);
    ctx.closePath();
    ctx.fill();
  }
}

