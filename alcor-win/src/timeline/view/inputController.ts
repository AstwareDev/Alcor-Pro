import { beatStore, markBeats } from "../../beats/beatState";
import { beatSnapFrames } from "../../beats/beatStore";
import {
  Layout,
  Snap,
  TimelineAutoScroll,
  VolumeScale,
  Zoom,
  animatableProperties,
  clipEndFrame,
  clipFadeFrames,
  clipKeyframeFrames,
  clipTypeIsCompatible,
  clipUpsertKeyframe,
  keyframeTrackIsActive,
  type AnimatableProperty,
  type Clip,
  type ClipLocation,
  type ClipType,
  type FadeEdge,
  type MediaAsset,
  type Point,
  type Rect,
  type TimelineMarker,
} from "../../model";
import type { Editor, TimelineRangeSelection } from "../../editor/editor";
import { makeFrameRange, type GapSelection } from "../../editor/rippleEngine";
import {
  commitClipProperty,
  moveClips,
  revertClipProperty,
  splitClip,
} from "../../editor/mutations/clipMutations";
import { duplicateClipsToPositions } from "../../editor/mutations/clipboard";
import { clipDurationFrames, seekToFrame, type SourceSegment } from "../../editor/mutations/core";
import { setSlipPreview, slipPreviewState } from "../../preview/slipPreview";
import {
  applyFade,
  applyMoveKeyframe,
  applyMoveVolumeKeyframe,
  commitFade,
  commitMoveKeyframe,
  commitMoveVolumeKeyframe,
} from "../../editor/mutations/keyframes";
import {
  commitSlip,
  commitTrim,
  effectiveTrimEnd,
  expandToLinkGroup,
  isSlipEligible,
  linkedPartnerIds,
} from "../../editor/mutations/linking";
import { multicamMoveViolation, multicamTrimBounds } from "../../editor/mutations/multicamRules";
import { rippleTrimClip, rippleTrimTargets } from "../../editor/mutations/ripple";
import { activateTimeline } from "../../editor/mutations/timelines";
import { keepValidTimelineRangeOrClear, setTimelineRange, validSelectedTimelineRange } from "../../editor/mutations/timelineRange";
import { insertTrack } from "../../editor/mutations/tracks";
import {
  dragIdle,
  makeMoveClipDrag,
  makeSlipDrag,
  makeTrimDrag,
  moveClipDragAll,
  moveClipDragDropTargetTrackIndex,
  type DragState,
  type MoveClipDrag,
} from "../dragState";
import { collectTargets, findSnap, makeSnapState, type SnapTarget } from "../snapEngine";
import {
  audioVolumeKfRect,
  clipBodyRect,
  clipRectFor,
  dbForY,
  dropTargetAt,
  fadeKneeRect,
  frameAt,
  rectContains,
  rowLocationAt,
  trackAt,
  trackHeightAt,
  trackYAt,
  xForFrame,
  type TimelineGeometry,
  type TrackDropTarget,
} from "../timelineGeometry";
import { horizontalAutoScrollStep, keyframeLaneHit, minZoomScale, zoomAnchored, type KeyframeLaneHit } from "../timelineInput";
import type { TimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { showsFadeControls, showsVolumeKeyframes, supportsPrecisionControls, trimEdgeAt, type TrimEdge } from "./clipRendererRules";
import { changeTimelineMarkers, displayedTimelineMarkers, timelineMarker, timelineMarkerSnapFrames } from "./timelineMarkerCommands";
import { markerAt, markerIdsIntersecting } from "./timelineMarkerGeometry";

// Port of TimelineInputController.swift on top of an abstract view host so it runs without a DOM.
// macOS ⌘ maps to Ctrl and ⌥ to Alt.

export type TimelineToolMode = "pointer" | "razor" | "trim";

export type TimelineCursor =
  | "default"
  | "pointer"
  | "crosshair"
  | "ew-resize"
  | "ns-resize"
  | "grab"
  | "grabbing"
  | "not-allowed"
  | "trim-left"
  | "trim-right"
  | "slip";

/** A pointer sample in viewport coordinates of the timeline canvas (ruler at y = 0). */
export interface TimelinePointer {
  x: number;
  y: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  clickCount: number;
}

/** Everything the controller needs from the view; the DOM view and the tests implement it. */
export interface TimelineViewHost {
  /** Document-space layout for the current timeline, zoom and lane state. */
  geometry(): TimelineGeometry;
  scrollX(): number;
  scrollY(): number;
  viewportWidth(): number;
  /** Clamps to the scrollable range for the current zoom. */
  setScrollX(x: number): void;
  setScrollY(y: number): void;
  laneState(): TimelineKeyframeLaneState;
  toolMode(): TimelineToolMode;
  /** Redraw both layers (document or drag preview changed). */
  invalidate(): void;
  /** Redraw only the overlay (snap line, razor line, marquee). */
  invalidateOverlay(): void;
  setCursor(cursor: TimelineCursor): void;
  presentMarkerEditor(id: string): void;
  /** While active, the host calls `autoScrollTick()` every `TimelineAutoScroll.interval`. */
  setAutoScrollActive(active: boolean): void;
}

/** What is under the pointer, in the priority order the hover cursor uses. */
export type TimelineHitZone =
  | { kind: "marker"; markerId: string }
  | { kind: "rangeEdge"; edge: "start" | "end" }
  | { kind: "ruler" }
  | { kind: "keyframeLane"; trackIndex: number; property: AnimatableProperty; keyframe?: KeyframeLaneHit }
  | { kind: "razor"; frame: number }
  | { kind: "clip"; clipId: string; trackIndex: number; part: "trimLeft" | "trimRight" | "fadeKnee" | "volumeKeyframe" | "body" }
  | { kind: "gap"; gap: GapSelection }
  | { kind: "empty" };

interface ExternalDrag {
  assets: MediaAsset[];
  segments: Record<string, SourceSegment>;
  target: TrackDropTarget;
  frame: number;
  isRippleInsert: boolean;
}

interface PreDragState {
  selectedClipIds: Set<string>;
  selectedTimelineMarkerIds: Set<string>;
  selectedGap: GapSelection | null;
  selectedTimelineRange: TimelineRangeSelection | null;
  currentFrame: number;
}

const timelineRangeEdgeHitSlop = 8;

export class TimelineInputController {
  dragState: DragState = dragIdle;
  /** Snap line of the in-timeline drag, in document x. */
  snapIndicatorX: number | undefined;
  /** Snap line of an external drop. */
  externalSnapX: number | undefined;
  razorPreviewFrame: number | undefined;
  hoveredClipId: string | undefined;
  external: ExternalDrag | undefined;
  /** Clips held on their own row during a move (computed once per move gesture). */
  movePinnedIds: ReadonlySet<string> = new Set();

  private snapState = makeSnapState();
  private razorSnapState = makeSnapState();
  private externalSnapState = makeSnapState();
  private scrubWasPlaying = false;
  private lastPointer: TimelinePointer | undefined;
  private autoScrolling = false;
  private preDrag: PreDragState | undefined;

  constructor(
    readonly editor: Editor,
    readonly host: TimelineViewHost,
  ) {}

  // MARK: - Coordinates

  private doc(p: TimelinePointer): Point {
    return { x: p.x + this.host.scrollX(), y: p.y + this.host.scrollY() };
  }

  private inRuler(p: TimelinePointer): boolean {
    return p.y >= 0 && p.y < Layout.rulerHeight;
  }

  get isDragging(): boolean {
    return this.dragState.kind !== "idle";
  }

  private setSnapIndicator(x: number | undefined): void {
    if (this.snapIndicatorX === x) return;
    this.snapIndicatorX = x;
    this.host.invalidateOverlay();
  }

  private setHoveredClipId(id: string | undefined): void {
    if (this.hoveredClipId === id) return;
    this.hoveredClipId = id;
    this.host.invalidate();
  }

  private markerSnapFrames(excluding?: ReadonlySet<string>): number[] {
    return timelineMarkerSnapFrames(this.editor, excluding);
  }

  // MARK: - Pointer down

  pointerDown(p: TimelinePointer): void {
    const editor = this.editor;
    const ui = editor.ui;
    const geometry = this.host.geometry();
    const point = this.doc(p);
    const scrollY = this.host.scrollY();
    this.lastPointer = p;
    this.preDrag = {
      selectedClipIds: ui.selectedClipIds,
      selectedTimelineMarkerIds: ui.selectedTimelineMarkerIds,
      selectedGap: ui.selectedGap,
      selectedTimelineRange: ui.selectedTimelineRange,
      currentFrame: ui.currentFrame,
    };

    const marker = markerAt(point, displayedTimelineMarkers(editor), geometry, scrollY);
    if (marker) {
      this.beginMarkerDrag(marker, frameAt(geometry, point.x), p.alt, p.clickCount);
      this.host.invalidate();
      return;
    }

    if (p.clickCount === 2 && !this.inRuler(p) && p.y >= Layout.rulerHeight) {
      const hit = this.hitTestClip(point, trackAt(geometry, point.y), geometry);
      if (hit) {
        const clip = editor.timeline.tracks[hit.trackIndex].clips[hit.clipIndex];
        if (clip.sourceClipType === "sequence") {
          activateTimeline(editor, clip.mediaRef);
          this.dragState = dragIdle;
          return;
        }
        const asset = editor.mediaAsset(clip.mediaRef);
        if (asset) {
          ui.selectedMediaAssetIds = new Set([asset.id]);
          this.dragState = dragIdle;
          this.host.invalidate();
          return;
        }
      }
    }

    if (this.inRuler(p)) {
      this.setHoveredClipId(undefined);
      const frame = frameAt(geometry, point.x);
      const edge = this.timelineRangeEdgeHit(point, geometry);
      if (edge) this.beginTimelineRangeEdgeDrag(edge);
      else if (p.shift) this.beginTimelineRangeSelection(frame);
      else {
        ui.selectedTimelineMarkerIds = new Set();
        this.beginPlayheadScrub(frame);
      }
      return;
    }

    const row = rowLocationAt(geometry, point.y);
    if (row?.kind === "keyframeLane") {
      ui.selectedTimelineMarkerIds = new Set();
      ui.selectedGap = null;
      this.snapState = makeSnapState();
      this.setSnapIndicator(undefined);
      const hit = keyframeLaneHit(editor.timeline, ui.selectedClipIds, point, row.trackIndex, row.property, geometry);
      if (hit) {
        if (ui.isPlaying) ui.isPlaying = false;
        seekToFrame(editor, hit.frame);
        ui.selectedClipIds = new Set([hit.clipId]);
        this.dragState = {
          kind: "keyframe",
          drag: {
            clipId: hit.clipId,
            trackIndex: row.trackIndex,
            property: row.property,
            originalFrame: hit.frame,
            grabFrame: frameAt(geometry, point.x),
            currentFrame: hit.frame,
          },
        };
        this.host.setCursor("grabbing");
      } else {
        const frame = frameAt(geometry, point.x);
        seekToFrame(editor, frame);
        const track = editor.timeline.tracks[row.trackIndex];
        const target = track?.clips.find(
          (c) => frame >= c.startFrame && frame < clipEndFrame(c) && clipKeyframeFramesSupported(c, row.property),
        );
        if (target) ui.selectedClipIds = new Set([target.id]);
        this.dragState = dragIdle;
      }
      this.host.invalidate();
      return;
    }

    const trackIndex = trackAt(geometry, point.y);
    ui.selectedGap = null;

    if (this.host.toolMode() === "razor") {
      ui.selectedTimelineMarkerIds = new Set();
      const hit = this.hitTestClip(point, trackIndex, geometry);
      if (hit) {
        const clickFrame = this.razorPreviewFrame ?? frameAt(geometry, point.x);
        const clip = editor.timeline.tracks[hit.trackIndex].clips[hit.clipIndex];
        splitClip(editor, clip.id, clickFrame);
        this.host.invalidate();
      }
      return;
    }

    const hit = this.hitTestClip(point, trackIndex, geometry);
    if (hit) {
      ui.selectedTimelineMarkerIds = new Set();
      const clip = editor.timeline.tracks[hit.trackIndex].clips[hit.clipIndex];
      const rect = clipRectFor(geometry, clip, hit.trackIndex);
      this.setHoveredClipId(supportsPrecisionControls(rect.width) ? clip.id : undefined);
      const isShift = p.shift;
      const isAlt = p.alt;
      // Linked behaviour is always on; Alt is the per-drag override.
      const linkedOn = !isAlt;
      const trimEdge = isAlt ? undefined : trimEdgeAt(point.x - rect.x, rect.width);
      const rippleTrim = isShift && trimEdge !== undefined;
      const selected = ui.selectedClipIds;

      if (rippleTrim) {
        if (!selected.has(clip.id)) ui.selectedClipIds = linkedOn ? expandToLinkGroup(editor, new Set([clip.id])) : new Set([clip.id]);
      } else if (isShift) {
        if (selected.has(clip.id)) {
          const remove = linkedOn ? expandToLinkGroup(editor, new Set([clip.id])) : new Set([clip.id]);
          ui.selectedClipIds = new Set([...selected].filter((id) => !remove.has(id)));
        } else {
          const add = linkedOn ? expandToLinkGroup(editor, new Set([clip.id])) : new Set([clip.id]);
          ui.selectedClipIds = new Set([...selected, ...add]);
        }
      } else if (isAlt && !selected.has(clip.id)) {
        ui.selectedClipIds = new Set([clip.id]);
      } else if (!isAlt && !selected.has(clip.id)) {
        ui.selectedClipIds = linkedOn ? expandToLinkGroup(editor, new Set([clip.id])) : new Set([clip.id]);
      }

      const fadeEdge = this.fadeKneeHit(point, clip, rect);
      const kfFrame = clip.mediaType === "audio" ? this.audioVolumeKfHit(point, clip, rect, hit.trackIndex) : undefined;
      if (fadeEdge) {
        const originalFrames = clipFadeFrames(clip, fadeEdge);
        this.dragState = {
          kind: "fadeKnee",
          drag: {
            clipId: clip.id,
            trackIndex: hit.trackIndex,
            edge: fadeEdge,
            originalFrames,
            grabFrame: frameAt(geometry, point.x),
            currentFrames: originalFrames,
          },
        };
      } else if (kfFrame !== undefined) {
        const kfOffset = kfFrame - clip.startFrame;
        const dB = clip.volumeTrack?.keyframes.find((k) => k.frame === kfOffset)?.value ?? 0;
        this.dragState = {
          kind: "audioVolumeKf",
          drag: {
            clipId: clip.id,
            trackIndex: hit.trackIndex,
            originalFrame: kfFrame,
            originalDb: dB,
            grabFrame: frameAt(geometry, point.x),
            currentFrame: kfFrame,
            currentDb: dB,
          },
        };
      } else if (p.ctrl && clip.mediaType === "audio" && this.addVolumeKeyframeOnClick(point, clip, rect, hit.trackIndex)) {
        this.dragState = dragIdle;
      } else if (trimEdge) {
        this.host.setCursor(trimEdge === "left" ? "trim-left" : "trim-right");
        const headroom = this.trimHeadroom(clip, trimEdge, linkedOn, rippleTrim);
        const drag = makeTrimDrag({
          clipId: clip.id,
          trackIndex: hit.trackIndex,
          originalTrimStart: headroom.left,
          originalTrimEnd: headroom.right,
          originalStartFrame: clip.startFrame,
          originalDuration: clip.durationFrames,
          hasNoSourceMedia: clip.mediaType === "image" || clip.mediaType === "text",
          propagateToLinked: linkedOn,
          isRipple: rippleTrim,
        });
        this.dragState = trimEdge === "left" ? { kind: "trimLeft", drag } : { kind: "trimRight", drag };
      } else if (this.host.toolMode() === "trim") {
        if (clip.multicamGroupId !== undefined) {
          editor.refuseWithToast("Can't slip a multicam clip — it would go out of sync with the group.");
          this.dragState = dragIdle;
        } else if (clip.mediaType === "image" || clip.mediaType === "text") {
          this.dragState = dragIdle;
        } else {
          this.host.setCursor("slip");
          if (ui.isPlaying) ui.isPlaying = false;
          const headroom = this.slipHeadroom(clip, linkedOn);
          this.dragState = {
            kind: "slip",
            drag: makeSlipDrag({
              clipId: clip.id,
              grabFrame: frameAt(geometry, point.x),
              maxRightDelta: headroom.right,
              maxLeftDelta: headroom.left,
              propagateToLinked: linkedOn,
            }),
          };
          setSlipPreview(slipPreviewState(editor, clip, 0, linkedOn));
        }
      } else {
        const grabFrame = frameAt(geometry, point.x);
        const companions: MoveClipDrag["companions"] = [];
        const nowSelected = ui.selectedClipIds;
        editor.timeline.tracks.forEach((track, ti) => {
          for (const c of track.clips) {
            if (c.id !== clip.id && nowSelected.has(c.id)) {
              companions.push({ clipId: c.id, originalTrackId: track.id, originalTrack: ti, originalFrame: c.startFrame });
            }
          }
        });
        const drag = makeMoveClipDrag({
          lead: {
            clipId: clip.id,
            originalTrackId: editor.timeline.tracks[hit.trackIndex].id,
            originalTrack: hit.trackIndex,
            originalFrame: clip.startFrame,
          },
          companions,
          grabOffsetFrames: grabFrame - clip.startFrame,
          dropTarget: { kind: "existingTrack", index: hit.trackIndex },
          isDuplicate: isAlt,
        });
        this.movePinnedIds = this.pinnedCompanionIds(drag);
        this.dragState = { kind: "moveClip", drag };
      }
    } else {
      this.setHoveredClipId(undefined);
      ui.isMarqueeSelecting = true;
      if (!p.shift) {
        ui.selectedClipIds = new Set();
        ui.selectedTimelineMarkerIds = new Set();
      }
      ui.selectedGap = this.hitTestGap(point, trackIndex, geometry) ?? null;
      this.dragState = {
        kind: "marquee",
        drag: {
          origin: point,
          current: { x: point.x, y: point.y, width: 0, height: 0 },
          baseSelection: ui.selectedClipIds,
          baseMarkerSelection: ui.selectedTimelineMarkerIds,
        },
      };
    }

    this.snapState = makeSnapState();
    this.host.invalidate();
  }

  // MARK: - Pointer move (drag)

  pointerDrag(p: TimelinePointer): void {
    this.lastPointer = p;
    if (this.dragState.kind === "scrubPlayhead") {
      this.continuePlayheadScrub(p);
      return;
    }
    this.applyDrag(p);
    this.updateAutoScroll(p);
  }

  private applyDrag(p: TimelinePointer): void {
    const editor = this.editor;
    const geometry = this.host.geometry();
    const point = this.doc(p);
    const frame = frameAt(geometry, point.x);
    const ppf = geometry.pixelsPerFrame;
    const state = this.dragState;

    switch (state.kind) {
      case "idle":
      case "scrubPlayhead":
        return;

      case "timelineRange": {
        const targets = collectTargets({
          tracks: editor.timeline.tracks,
          playheadFrame: editor.ui.currentFrame,
          includePlayhead: true,
          markerFrames: this.markerSnapFrames(),
          beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)),
        });
        const snap = findSnap({ position: frame, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: ppf });
        this.setSnapIndicator(snap?.x);
        setTimelineRange(editor, state.drag.anchorFrame, snap ? snap.frame : frame);
        break;
      }

      case "timelineMarker": {
        const drag = state.drag;
        const targets = collectTargets({
          tracks: editor.timeline.tracks,
          playheadFrame: editor.ui.currentFrame,
          includePlayhead: true,
          markerFrames: this.markerSnapFrames(new Set([drag.original.id])),
        });
        const snapped = (position: number, probes: number[] = [0]): number => {
          const snap = findSnap({ position, probeOffsets: probes, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: ppf });
          this.setSnapIndicator(snap?.x);
          return snap ? snap.frame - snap.probeOffset : position;
        };
        const value = { ...drag.value };
        if (drag.adjustsDuration) {
          const end = Math.max(drag.original.startFrame, snapped(frame));
          value.durationFrames = end - drag.original.startFrame;
        } else {
          const raw = drag.original.startFrame + frame - drag.grabFrame;
          value.startFrame = Math.max(0, snapped(raw, [0, value.durationFrames]));
        }
        this.dragState = { kind: "timelineMarker", drag: { ...drag, value } };
        break;
      }

      case "moveClip": {
        const drag = { ...state.drag };
        const candidateFrame = frame - drag.grabOffsetFrames;
        const all = moveClipDragAll(drag);
        const allIds = new Set(all.map((p) => p.clipId));
        const targets = collectTargets({
          tracks: editor.timeline.tracks,
          playheadFrame: editor.ui.currentFrame,
          excludeClipIds: allIds,
          includePlayhead: true,
          markerFrames: this.markerSnapFrames(),
          beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)),
        });
        // Let any selected edge drive snapping, not just the lead start.
        const probeOffsets: number[] = [];
        for (const participant of all) {
          const c = editor.clipFor(participant.clipId);
          if (!c) continue;
          const baseOffset = participant.originalFrame - drag.lead.originalFrame;
          probeOffsets.push(baseOffset, baseOffset + c.durationFrames);
        }
        const snap = findSnap({ position: candidateFrame, probeOffsets, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: ppf });
        this.setSnapIndicator(snap?.x);
        drag.deltaFrames = snap ? snap.frame - snap.probeOffset - drag.lead.originalFrame : candidateFrame - drag.lead.originalFrame;
        const minOrigFrame = Math.min(...all.map((x) => x.originalFrame));
        drag.deltaFrames = Math.max(-minOrigFrame, drag.deltaFrames);
        const cursorTarget = dropTargetAt(geometry, point.y);
        if (cursorTarget.kind === "existingTrack") {
          const leadTrack = drag.lead.originalTrack;
          drag.dropTarget = { kind: "existingTrack", index: leadTrack + this.clampedTrackDelta(drag, cursorTarget.index - leadTrack) };
        } else {
          drag.dropTarget = cursorTarget;
        }
        this.dragState = { kind: "moveClip", drag };
        break;
      }

      case "trimLeft": {
        const drag = { ...state.drag };
        const targets = collectTargets({
          tracks: editor.timeline.tracks,
          playheadFrame: editor.ui.currentFrame,
          excludeClipIds: new Set([drag.clipId]),
          includePlayhead: true,
          markerFrames: this.markerSnapFrames(),
          beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)),
          includeExcludedClipBeats: true,
        });
        const snap = findSnap({ position: frame, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: ppf });
        this.setSnapIndicator(snap?.x);
        const delta = (snap ? snap.frame : frame) - drag.originalStartFrame;
        const maxDelta = drag.originalDuration - 1;
        const minDelta = drag.hasNoSourceMedia ? -drag.originalStartFrame : -drag.originalTrimStart;
        drag.deltaFrames = Math.max(minDelta, Math.min(maxDelta, delta));
        this.dragState = { kind: "trimLeft", drag };
        break;
      }

      case "trimRight": {
        const drag = { ...state.drag };
        const originalEndFrame = drag.originalStartFrame + drag.originalDuration;
        const candidateEnd = Math.max(drag.originalStartFrame + 1, frame);
        const targets = collectTargets({
          tracks: editor.timeline.tracks,
          playheadFrame: editor.ui.currentFrame,
          excludeClipIds: new Set([drag.clipId]),
          includePlayhead: true,
          markerFrames: this.markerSnapFrames(),
          beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)),
          includeExcludedClipBeats: true,
        });
        const snap = findSnap({ position: candidateEnd, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: ppf });
        this.setSnapIndicator(snap?.x);
        drag.deltaFrames = (snap ? snap.frame : candidateEnd) - originalEndFrame;
        // Can't shrink past 1 frame; clips with source media can't extend past it.
        const minDelta = -(drag.originalDuration - 1);
        drag.deltaFrames = drag.hasNoSourceMedia
          ? Math.max(minDelta, drag.deltaFrames)
          : Math.max(minDelta, Math.min(drag.originalTrimEnd, drag.deltaFrames));
        this.dragState = { kind: "trimRight", drag };
        break;
      }

      case "slip": {
        this.setSnapIndicator(undefined);
        const drag = state.drag;
        const delta = Math.max(-drag.maxLeftDelta, Math.min(drag.maxRightDelta, frame - drag.grabFrame));
        if (delta === drag.deltaFrames) return;
        this.dragState = { kind: "slip", drag: { ...drag, deltaFrames: delta } };
        const slipClip = editor.clipFor(drag.clipId);
        if (slipClip) setSlipPreview(slipPreviewState(editor, slipClip, delta, drag.propagateToLinked));
        this.host.invalidate();
        return;
      }

      case "keyframe":
        this.dragState = { kind: "keyframe", drag: this.applyKeyframeDrag(state.drag, frame, geometry) };
        break;

      case "audioVolumeKf":
        this.dragState = { kind: "audioVolumeKf", drag: this.applyVolumeKfDrag(state.drag, frame, point.y, geometry) };
        break;

      case "fadeKnee":
        this.dragState = { kind: "fadeKnee", drag: this.applyFadeKneeDrag(state.drag, frame) };
        break;

      case "marquee": {
        const marq = state.drag;
        const current: Rect = {
          x: Math.min(marq.origin.x, point.x),
          y: Math.min(marq.origin.y, point.y),
          width: Math.abs(point.x - marq.origin.x),
          height: Math.abs(point.y - marq.origin.y),
        };
        if ((current.width > Layout.dragThreshold || current.height > Layout.dragThreshold) && editor.ui.selectedGap !== null) {
          editor.ui.selectedGap = null;
        }
        let selected = new Set(marq.baseSelection);
        editor.timeline.tracks.forEach((track, ti) => {
          for (const clip of track.clips) if (rectsOverlap(clipRectFor(geometry, clip, ti), current)) selected.add(clip.id);
        });
        if (!p.alt) selected = expandToLinkGroup(editor, selected);
        const markerIds = markerIdsIntersecting(current, displayedTimelineMarkers(editor), geometry, this.host.scrollY());
        const nextMarkers = new Set([...marq.baseMarkerSelection, ...markerIds]);
        if (!setsEqual(nextMarkers, editor.ui.selectedTimelineMarkerIds)) editor.ui.selectedTimelineMarkerIds = nextMarkers;
        this.dragState = { kind: "marquee", drag: { ...marq, current } };
        if (!setsEqual(selected, editor.ui.selectedClipIds)) {
          editor.ui.selectedClipIds = selected;
          this.host.invalidate();
        } else {
          this.host.invalidateOverlay();
        }
        return;
      }
    }
    this.host.invalidate();
  }

  // MARK: - Pointer up

  pointerUp(_p?: TimelinePointer): void {
    const editor = this.editor;
    this.stopAutoScroll();
    const state = this.dragState;
    // Reset first so a refusal toast or a re-entrant redraw sees the idle state.
    this.dragState = dragIdle;
    if (state.kind === "slip") setSlipPreview(null);

    switch (state.kind) {
      case "moveClip":
        this.commitMove(state.drag);
        break;
      case "trimLeft":
      case "trimRight": {
        const drag = state.drag;
        const edge: TrimEdge = state.kind === "trimLeft" ? "left" : "right";
        if (drag.deltaFrames !== 0) {
          if (drag.isRipple) rippleTrimClip(editor, drag.clipId, edge, drag.deltaFrames, drag.propagateToLinked);
          else commitTrim(editor, drag.clipId, edge, drag.deltaFrames, drag.propagateToLinked);
        }
        break;
      }
      case "slip":
        if (state.drag.deltaFrames !== 0) commitSlip(editor, state.drag.clipId, state.drag.deltaFrames, state.drag.propagateToLinked);
        break;
      case "keyframe": {
        const drag = state.drag;
        if (drag.currentFrame !== drag.originalFrame) {
          editor.ui.currentFrame = drag.currentFrame;
          commitMoveKeyframe(editor, drag.clipId);
        } else {
          revertClipProperty(editor, drag.clipId);
        }
        break;
      }
      case "audioVolumeKf": {
        const drag = state.drag;
        if (drag.currentFrame !== drag.originalFrame || drag.currentDb !== drag.originalDb) commitMoveVolumeKeyframe(editor, drag.clipId);
        else revertClipProperty(editor, drag.clipId);
        break;
      }
      case "fadeKnee": {
        const drag = state.drag;
        if (drag.currentFrames !== drag.originalFrames) commitFade(editor, drag.clipId, drag.edge, drag.currentFrames);
        else revertClipProperty(editor, drag.clipId);
        break;
      }
      case "marquee":
        editor.ui.isMarqueeSelecting = false;
        break;
      case "scrubPlayhead":
        this.finishPlayheadScrub();
        break;
      case "timelineRange":
        keepValidTimelineRangeOrClear(editor);
        break;
      case "timelineMarker": {
        const drag = state.drag;
        const changed = drag.adjustsDuration
          ? drag.value.durationFrames !== drag.original.durationFrames
          : drag.value.startFrame !== drag.original.startFrame;
        if (changed) {
          try {
            changeTimelineMarkers(editor, { updates: [drag.value], actionName: drag.adjustsDuration ? "Change Marker Duration" : "Move Marker" });
          } catch {
            editor.refuseWithToast("Couldn't change marker.");
          }
        }
        this.host.setCursor("grab");
        break;
      }
      case "idle":
        break;
    }

    this.snapState = makeSnapState();
    this.setSnapIndicator(undefined);
    this.movePinnedIds = new Set();
    this.preDrag = undefined;
    this.host.invalidate();
  }

  private commitMove(drag: MoveClipDrag): void {
    const editor = this.editor;
    if (drag.dropTarget.kind === "existingTrack" && drag.dropTarget.index === drag.lead.originalTrack && drag.deltaFrames === 0) return;
    const resolved = this.resolvedMoveParticipants(drag);
    const resolvedLead = resolved.find((r) => r.clipId === drag.lead.clipId);
    if (!resolvedLead) return;
    const minOrigFrame = Math.min(...resolved.map((r) => r.frame));
    const frameDelta = Math.max(-minOrigFrame, drag.deltaFrames);
    const pinned = this.pinnedCompanionIds(drag);
    const leadTrack = resolvedLead.trackIndex;

    if (drag.dropTarget.kind === "existingTrack") {
      // Rigid translation: non-pinned clips shift by the track delta; pinned clips hold their row.
      const target = moveClipDragDropTargetTrackIndex(drag);
      const delta = target === undefined ? 0 : target - leadTrack;
      const moves = resolved.map((r) => ({
        clipId: r.clipId,
        toTrack: pinned.has(r.clipId) ? r.trackIndex : r.trackIndex + delta,
        toFrame: r.frame + frameDelta,
      }));
      this.commitMoves(moves, drag.isDuplicate);
      return;
    }

    const insertIndex = drag.dropTarget.index;
    const leadTrackType = this.resolvedLeadTrackType(drag);
    if (leadTrackType === undefined) return;
    if (!drag.isDuplicate) {
      const reason = multicamMoveViolation(
        editor,
        resolved.map((r) => ({ clipId: r.clipId, toTrack: r.trackIndex, toFrame: r.frame + frameDelta })),
      );
      if (reason !== null) {
        editor.refuseWithToast(reason);
        return;
      }
    }
    const count = resolved.length;
    const actionName = drag.isDuplicate ? (count === 1 ? "Duplicate Clip to New Track" : "Duplicate Clips to New Track") : "Move Clip to New Track";
    editor.perform(actionName, () => {
      const newIdx = insertTrack(editor, insertIndex, leadTrackType);
      const moves = resolved.map((r) => {
        const hops = !pinned.has(r.clipId) && r.trackIndex === leadTrack;
        const shifted = r.trackIndex >= newIdx ? r.trackIndex + 1 : r.trackIndex;
        return { clipId: r.clipId, toTrack: hops ? newIdx : shifted, toFrame: r.frame + frameDelta };
      });
      this.commitMoves(moves, drag.isDuplicate);
    });
  }

  private commitMoves(moves: { clipId: string; toTrack: number; toFrame: number }[], isDuplicate: boolean): void {
    if (isDuplicate) duplicateClipsToPositions(this.editor, moves);
    else moveClips(this.editor, moves);
  }

  private resolvedMoveParticipants(drag: MoveClipDrag): { clipId: string; trackIndex: number; frame: number }[] {
    const out: { clipId: string; trackIndex: number; frame: number }[] = [];
    for (const p of moveClipDragAll(drag)) {
      const loc = this.editor.findClip(p.clipId);
      if (!loc) continue;
      const clip = this.editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
      out.push({ clipId: p.clipId, trackIndex: loc.trackIndex, frame: clip.startFrame });
    }
    return out;
  }

  private resolvedLeadTrackType(drag: MoveClipDrag): ClipType | undefined {
    const tracks = this.editor.timeline.tracks;
    const loc = this.editor.findClip(drag.lead.clipId);
    if (loc) return tracks[loc.trackIndex].type;
    const byId = tracks.find((t) => t.id === drag.lead.originalTrackId);
    if (byId) return byId.type;
    return tracks[drag.lead.originalTrack]?.type;
  }

  /** Clips that keep their own row while the lead changes track (same link group, or type-incompatible). */
  pinnedCompanionIds(drag: MoveClipDrag): Set<string> {
    const leadTrackType = this.resolvedLeadTrackType(drag);
    const pinned = new Set<string>();
    if (leadTrackType === undefined) return pinned;
    const clips = this.editor.timeline.tracks.flatMap((t) => t.clips);
    const leadLink = clips.find((c) => c.id === drag.lead.clipId)?.linkGroupId;
    for (const c of clips) {
      if (c.id === drag.lead.clipId) continue;
      if (leadLink !== undefined && c.linkGroupId === leadLink) pinned.add(c.id);
      else if (!clipTypeIsCompatible(leadTrackType, c.mediaType)) pinned.add(c.id);
    }
    return pinned;
  }

  /** Clamps track movement to valid, type-compatible tracks. */
  clampedTrackDelta(drag: MoveClipDrag, proposed: number): number {
    const tracks = this.editor.timeline.tracks;
    const pinned = this.movePinnedIds;
    const movers = moveClipDragAll(drag).filter((p) => !pinned.has(p.clipId));
    const step = proposed >= 0 ? -1 : 1;
    let d = proposed;
    while (d !== 0) {
      const ok = movers.every((p) => {
        const dest = p.originalTrack + d;
        const c = this.editor.clipFor(p.clipId);
        if (!(dest >= 0 && dest < tracks.length) || !c) return false;
        return clipTypeIsCompatible(tracks[dest].type, c.mediaType);
      });
      if (ok) return d;
      d += step;
    }
    return 0;
  }

  // MARK: - Cancel (Escape)

  /** Cancels an in-flight drag and restores the exact pre-drag state. Returns false when nothing was in flight. */
  cancelActiveDrag(): boolean {
    const editor = this.editor;
    const state = this.dragState;
    if (state.kind === "idle") return false;
    const pre = this.preDrag;
    this.dragState = dragIdle;
    if (state.kind === "slip") setSlipPreview(null);
    switch (state.kind) {
      case "keyframe":
        revertClipProperty(editor, state.drag.clipId);
        editor.ui.currentFrame = state.drag.originalFrame;
        break;
      case "audioVolumeKf":
      case "fadeKnee":
        revertClipProperty(editor, state.drag.clipId);
        break;
      case "scrubPlayhead":
        editor.ui.isScrubbing = false;
        if (pre) editor.ui.currentFrame = pre.currentFrame;
        if (this.scrubWasPlaying) editor.ui.isPlaying = true;
        this.scrubWasPlaying = false;
        break;
      case "marquee":
        editor.ui.isMarqueeSelecting = false;
        break;
      case "timelineMarker":
        this.host.setCursor("grab");
        break;
      default:
        break;
    }
    if (pre) {
      editor.ui.selectedClipIds = pre.selectedClipIds;
      editor.ui.selectedTimelineMarkerIds = pre.selectedTimelineMarkerIds;
      editor.ui.selectedGap = pre.selectedGap;
      editor.ui.selectedTimelineRange = pre.selectedTimelineRange;
    }
    this.preDrag = undefined;
    this.snapState = makeSnapState();
    this.setSnapIndicator(undefined);
    this.movePinnedIds = new Set();
    this.stopAutoScroll();
    this.host.invalidate();
    return true;
  }

  // MARK: - Hover

  /** Hover classification, in the order `mouseMoved` checks it. */
  hitZone(p: TimelinePointer): TimelineHitZone {
    const editor = this.editor;
    const geometry = this.host.geometry();
    const point = this.doc(p);
    const marker = markerAt(point, displayedTimelineMarkers(editor), geometry, this.host.scrollY());
    if (marker) return { kind: "marker", markerId: marker.id };
    if (this.inRuler(p)) {
      const edge = this.timelineRangeEdgeHit(point, geometry);
      return edge ? { kind: "rangeEdge", edge } : { kind: "ruler" };
    }
    const row = rowLocationAt(geometry, point.y);
    if (row?.kind === "keyframeLane") {
      const keyframe = keyframeLaneHit(editor.timeline, editor.ui.selectedClipIds, point, row.trackIndex, row.property, geometry);
      return keyframe
        ? { kind: "keyframeLane", trackIndex: row.trackIndex, property: row.property, keyframe }
        : { kind: "keyframeLane", trackIndex: row.trackIndex, property: row.property };
    }
    if (this.host.toolMode() === "razor") return { kind: "razor", frame: this.razorFrame(point.x, geometry) };
    const trackIndex = trackAt(geometry, point.y);
    const hit = this.hitTestClip(point, trackIndex, geometry);
    if (hit) {
      const clip = editor.timeline.tracks[hit.trackIndex].clips[hit.clipIndex];
      const rect = clipRectFor(geometry, clip, hit.trackIndex);
      const base = { kind: "clip" as const, clipId: clip.id, trackIndex: hit.trackIndex };
      const edge = trimEdgeAt(point.x - rect.x, rect.width);
      if (edge) return { ...base, part: edge === "left" ? "trimLeft" : "trimRight" };
      if (this.fadeKneeHit(point, clip, rect)) return { ...base, part: "fadeKnee" };
      if (clip.mediaType === "audio" && this.audioVolumeKfHit(point, clip, rect, hit.trackIndex) !== undefined) {
        return { ...base, part: "volumeKeyframe" };
      }
      return { ...base, part: "body" };
    }
    const gap = this.hitTestGap(point, trackIndex, geometry);
    return gap ? { kind: "gap", gap } : { kind: "empty" };
  }

  hover(p: TimelinePointer): void {
    const editor = this.editor;
    const geometry = this.host.geometry();
    const previousRazor = this.razorPreviewFrame;
    const zone = this.hitZone(p);

    if (zone.kind !== "razor") {
      this.razorPreviewFrame = undefined;
      this.razorSnapState = makeSnapState();
    }
    if (zone.kind !== "clip") this.setHoveredClipId(undefined);

    switch (zone.kind) {
      case "marker":
        this.host.setCursor(p.alt ? "ew-resize" : "grab");
        break;
      case "rangeEdge":
        this.host.setCursor("ew-resize");
        break;
      case "ruler":
        this.host.setCursor(p.shift ? "crosshair" : "pointer");
        break;
      case "keyframeLane":
        this.host.setCursor(zone.keyframe ? "grab" : "pointer");
        break;
      case "razor":
        this.razorPreviewFrame = zone.frame;
        this.host.setCursor("crosshair");
        break;
      case "clip": {
        const clip = editor.clipFor(zone.clipId);
        const rect = clip ? clipRectFor(geometry, clip, zone.trackIndex) : undefined;
        this.setHoveredClipId(rect && supportsPrecisionControls(rect.width) ? zone.clipId : undefined);
        if (zone.part === "trimLeft") this.host.setCursor("trim-left");
        else if (zone.part === "trimRight") this.host.setCursor("trim-right");
        else if (zone.part === "fadeKnee") this.host.setCursor("ew-resize");
        else if (zone.part === "volumeKeyframe") this.host.setCursor("grab");
        else if (this.host.toolMode() === "trim" && clip) {
          const slippable = clip.multicamGroupId === undefined && clip.mediaType !== "image" && clip.mediaType !== "text";
          this.host.setCursor(slippable ? "slip" : "not-allowed");
        } else this.host.setCursor("default");
        break;
      }
      default:
        this.host.setCursor("default");
    }
    if (previousRazor !== this.razorPreviewFrame) this.host.invalidateOverlay();
  }

  leave(): void {
    this.setHoveredClipId(undefined);
    if (this.razorPreviewFrame !== undefined) {
      this.razorPreviewFrame = undefined;
      this.host.invalidateOverlay();
    }
  }

  private razorFrame(docX: number, geometry: TimelineGeometry): number {
    const candidate = frameAt(geometry, docX);
    const targets = collectTargets({
      tracks: this.editor.timeline.tracks,
      playheadFrame: this.editor.ui.currentFrame,
      includePlayhead: true,
      markerFrames: this.markerSnapFrames(),
          beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)),
    });
    const snap = findSnap({ position: candidate, targets, state: this.razorSnapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: geometry.pixelsPerFrame });
    return snap ? snap.frame : candidate;
  }

  // MARK: - Wheel / zoom

  /**
   * Windows mapping of the Swift scroll handling: wheel scrolls vertically (and horizontally for trackpad x),
   * Shift+wheel scrolls horizontally, Ctrl+wheel (and trackpad pinch) and Alt+wheel (Swift's Option) zoom at the cursor.
   */
  wheel(p: TimelinePointer, deltaX: number, deltaY: number): void {
    this.setHoveredClipId(undefined);
    if (p.ctrl || p.alt) {
      this.applyZoom(Math.exp(-deltaY * wheelZoomSensitivity), p.x + this.host.scrollX());
      return;
    }
    if (p.shift) {
      this.host.setScrollX(this.host.scrollX() + (deltaX !== 0 ? deltaX : deltaY));
      return;
    }
    if (deltaX !== 0) this.host.setScrollX(this.host.scrollX() + deltaX);
    if (deltaY !== 0) this.host.setScrollY(this.host.scrollY() + deltaY);
  }

  applyZoom(factor: number, anchorDocX: number): void {
    const ui = this.editor.ui;
    const result = zoomAnchored({
      zoomScale: ui.zoomScale,
      minZoomScale: minZoomScale(this.editor.timeline, ui.timelineVisibleWidth),
      factor,
      anchorDocX,
      scrollOriginX: this.host.scrollX(),
    });
    if (!result) return;
    ui.zoomScale = result.newScale;
    this.host.setScrollX(result.scrollX);
    this.host.invalidate();
  }

  // MARK: - Auto-scroll

  private updateAutoScroll(p: TimelinePointer): void {
    const k = this.dragState.kind;
    const eligible = k === "scrubPlayhead" || k === "moveClip" || k === "trimLeft" || k === "trimRight" || k === "marquee" || k === "timelineRange";
    const active = eligible && this.autoScrollDelta(p.x) !== 0;
    if (active === this.autoScrolling) return;
    this.autoScrolling = active;
    this.host.setAutoScrollActive(active);
  }

  private stopAutoScroll(): void {
    if (!this.autoScrolling) return;
    this.autoScrolling = false;
    this.host.setAutoScrollActive(false);
  }

  /** `horizontalAutoScrollDelta(windowPoint:visibleRect:)` for a viewport x. */
  autoScrollDelta(viewportX: number): number {
    const width = this.host.viewportWidth();
    const zone = Math.min(TimelineAutoScroll.edgeZoneWidth, width * TimelineAutoScroll.maxZoneFraction);
    if (!(zone > 0)) return 0;
    if (viewportX < zone) return -horizontalAutoScrollStep(zone - viewportX, zone);
    if (viewportX > width - zone) return horizontalAutoScrollStep(viewportX - (width - zone), zone);
    return 0;
  }

  /** One auto-scroll step: scrolls, then re-applies the drag at the same viewport point. */
  autoScrollTick(): void {
    const p = this.lastPointer;
    if (!p || this.dragState.kind === "idle") {
      this.stopAutoScroll();
      return;
    }
    const delta = this.autoScrollDelta(p.x);
    const before = this.host.scrollX();
    if (delta !== 0) this.host.setScrollX(before + delta);
    if (this.host.scrollX() === before) {
      this.stopAutoScroll();
      return;
    }
    if (this.dragState.kind === "scrubPlayhead") this.scrubAt(p);
    else this.applyDrag(p);
  }

  // MARK: - Hit testing

  hitTestClip(point: Point, trackIndex: number, geometry: TimelineGeometry): ClipLocation | undefined {
    const track = this.editor.timeline.tracks[trackIndex];
    if (!track) return undefined;
    // Clips on a track never overlap and are kept sorted, so stop once a clip starts past the point.
    const frameX = point.x;
    for (let ci = 0; ci < track.clips.length; ci++) {
      const clip = track.clips[ci];
      const rect = clipRectFor(geometry, clip, trackIndex);
      if (rect.x > frameX) break;
      if (rectContains(rect, point)) return { trackIndex, clipIndex: ci };
    }
    return undefined;
  }

  /** Empty track space bounded on the right by a clip: `[previousClipEnd, nextClipStart)`. */
  hitTestGap(point: Point, trackIndex: number, geometry: TimelineGeometry): GapSelection | undefined {
    const track = this.editor.timeline.tracks[trackIndex];
    if (!track) return undefined;
    const top = trackYAt(geometry, trackIndex);
    const bottom = top + trackHeightAt(geometry, trackIndex);
    if (!(point.y >= top && point.y < bottom)) return undefined;
    const frame = frameAt(geometry, point.x);
    const clips = track.clips;
    if (clips.some((c) => frame >= c.startFrame && frame < clipEndFrame(c))) return undefined;
    const after = clips.map((c) => c.startFrame).filter((s) => s > frame);
    if (after.length === 0) return undefined;
    const before = clips.map(clipEndFrame).filter((e) => e <= frame);
    return { trackIndex, range: makeFrameRange(before.length === 0 ? 0 : Math.max(...before), Math.min(...after)) };
  }

  timelineRangeEdgeHit(point: Point, geometry: TimelineGeometry): "start" | "end" | undefined {
    const range = validSelectedTimelineRange(this.editor);
    if (!range) return undefined;
    const startDistance = Math.abs(point.x - xForFrame(geometry, range.startFrame));
    const endDistance = Math.abs(point.x - xForFrame(geometry, range.endFrame));
    if (Math.min(startDistance, endDistance) > timelineRangeEdgeHitSlop) return undefined;
    return startDistance <= endDistance ? "start" : "end";
  }

  private baseClipKeyframeAutomationVisible(trackIndex: number): boolean {
    const track = this.editor.timeline.tracks[trackIndex];
    return track !== undefined && !this.host.laneState().expandedTrackIds.has(track.id);
  }

  audioVolumeKfHit(point: Point, clip: Clip, clipRect: Rect, trackIndex: number): number | undefined {
    if (!this.baseClipKeyframeAutomationVisible(trackIndex)) return undefined;
    if (!showsVolumeKeyframes(this.editor.ui.selectedClipIds.has(clip.id), this.hoveredClipId === clip.id, clipRect)) return undefined;
    const track = clip.volumeTrack;
    if (!track || !keyframeTrackIsActive(track)) return undefined;
    for (const kf of track.keyframes) {
      if (rectContains(audioVolumeKfRect(clip, kf.frame, kf.value, clipRect), point)) return clip.startFrame + kf.frame;
    }
    return undefined;
  }

  fadeKneeHit(point: Point, clip: Clip, clipRect: Rect): FadeEdge | undefined {
    if (!showsFadeControls(this.editor.ui.selectedClipIds.has(clip.id), this.hoveredClipId === clip.id, clipRect)) return undefined;
    if (rectContains(fadeKneeRect(clip, "left", clipRect), point)) return "left";
    if (rectContains(fadeKneeRect(clip, "right", clipRect), point)) return "right";
    return undefined;
  }

  // MARK: - Drag helpers

  private trimHeadroom(clip: Clip, edge: TrimEdge, linked: boolean, ripple: boolean): { left: number; right: number } {
    const editor = this.editor;
    let clips: Clip[];
    if (ripple) {
      clips = rippleTrimTargets(editor, clip.id, edge, linked);
    } else {
      clips = [clip];
      if (linked) for (const id of linkedPartnerIds(editor, clip.id)) {
        const c = editor.clipFor(id);
        if (c) clips.push(c);
      }
    }
    let left = Number.MAX_SAFE_INTEGER;
    let right = Number.MAX_SAFE_INTEGER;
    for (const c of clips) {
      const bounds = ripple ? null : multicamTrimBounds(editor, c);
      if (bounds) {
        left = Math.min(left, bounds.left);
        right = Math.min(right, bounds.right);
      } else {
        left = Math.min(left, c.trimStartFrame);
        right = Math.min(right, effectiveTrimEnd(editor, c));
      }
    }
    return {
      left: left === Number.MAX_SAFE_INTEGER ? clip.trimStartFrame : left,
      right: right === Number.MAX_SAFE_INTEGER ? effectiveTrimEnd(editor, clip) : right,
    };
  }

  /** Timeline-frame slip caps: the tightest source headroom across the clip and (when linked) its partners. */
  private slipHeadroom(clip: Clip, linked: boolean): { right: number; left: number } {
    const editor = this.editor;
    const clips = [clip];
    if (linked) for (const id of linkedPartnerIds(editor, clip.id)) {
      const c = editor.clipFor(id);
      if (c) clips.push(c);
    }
    let right = Number.MAX_SAFE_INTEGER;
    let left = Number.MAX_SAFE_INTEGER;
    for (const c of clips) {
      if (!isSlipEligible(c)) continue;
      const speed = Math.max(c.speed, 0.001);
      right = Math.min(right, Math.floor(c.trimStartFrame / speed));
      left = Math.min(left, Math.floor(effectiveTrimEnd(editor, c) / speed));
    }
    return { right: right === Number.MAX_SAFE_INTEGER ? 0 : right, left: left === Number.MAX_SAFE_INTEGER ? 0 : left };
  }

  private draggedClip(id: string, trackIndex: number): Clip | undefined {
    return this.editor.timeline.tracks[trackIndex]?.clips.find((c) => c.id === id);
  }

  private keyframeDragBounds(clip: Clip, property: AnimatableProperty, currentFrame: number): { lower: number; upper: number } {
    let lower = clip.startFrame;
    let upper = Math.max(clip.startFrame, clipEndFrame(clip) - 1);
    for (const frame of clipKeyframeFrames(clip, property)) {
      if (frame === currentFrame) continue;
      if (frame < currentFrame) lower = Math.max(lower, frame + 1);
      else upper = Math.min(upper, frame - 1);
    }
    return { lower, upper };
  }

  private applyKeyframeDrag(source: Extract<DragState, { kind: "keyframe" }>["drag"], cursorFrame: number, geometry: TimelineGeometry) {
    const drag = { ...source };
    const clip = this.draggedClip(drag.clipId, drag.trackIndex);
    if (!clip) return drag;
    const maximumFrame = Math.max(clip.startFrame, clipEndFrame(clip) - 1);
    const proposed = drag.originalFrame + (cursorFrame - drag.grabFrame);
    if (proposed === drag.currentFrame) return drag;
    const targets: SnapTarget[] = [
      { frame: clip.startFrame, kind: "clipEdge" },
      { frame: maximumFrame, kind: "clipEdge" },
    ];
    for (const property of animatableProperties) {
      if (property === drag.property) continue;
      for (const frame of clipKeyframeFrames(clip, property)) targets.push({ frame, kind: "clipEdge" });
    }
    const snap = findSnap({ position: proposed, targets, state: this.snapState, baseThreshold: Snap.thresholdPixels, pixelsPerFrame: geometry.pixelsPerFrame });
    const candidate = snap ? snap.frame : proposed;
    this.setSnapIndicator(snap?.x);
    const bounds = this.keyframeDragBounds(clip, drag.property, drag.currentFrame);
    const next = Math.max(bounds.lower, Math.min(bounds.upper, candidate));
    if (next !== candidate) this.setSnapIndicator(undefined);
    if (next === drag.currentFrame) return drag;
    this.editor.ui.currentFrame = next;
    applyMoveKeyframe(this.editor, drag.clipId, drag.property, drag.currentFrame, next);
    drag.currentFrame = next;
    return drag;
  }

  private applyVolumeKfDrag(source: Extract<DragState, { kind: "audioVolumeKf" }>["drag"], cursorFrame: number, cursorY: number, geometry: TimelineGeometry) {
    const drag = { ...source };
    const clip = this.draggedClip(drag.clipId, drag.trackIndex);
    if (!clip) return drag;
    const body = clipBodyRect(clipRectFor(geometry, clip, drag.trackIndex));
    const bounds = this.keyframeDragBounds(clip, "volume", drag.currentFrame);
    const proposed = drag.originalFrame + (cursorFrame - drag.grabFrame);
    const newFrame = Math.max(bounds.lower, Math.min(bounds.upper, proposed));
    const newDb = Math.max(VolumeScale.floorDb, Math.min(VolumeScale.ceilingDb, dbForY(cursorY, body)));
    if (newFrame === drag.currentFrame && newDb === drag.currentDb) return drag;
    applyMoveVolumeKeyframe(this.editor, drag.clipId, drag.currentFrame, newFrame, newDb);
    drag.currentFrame = newFrame;
    drag.currentDb = newDb;
    return drag;
  }

  private applyFadeKneeDrag(source: Extract<DragState, { kind: "fadeKnee" }>["drag"], cursorFrame: number) {
    const drag = { ...source };
    const clip = this.draggedClip(drag.clipId, drag.trackIndex);
    if (!clip) return drag;
    const delta = cursorFrame - drag.grabFrame;
    const proposed = drag.edge === "left" ? drag.originalFrames + delta : drag.originalFrames - delta;
    const counterFade = clipFadeFrames(clip, drag.edge === "left" ? "right" : "left");
    const cap = Math.max(0, clip.durationFrames - counterFade);
    const clamped = Math.max(0, Math.min(cap, proposed));
    if (clamped === drag.currentFrames) return drag;
    applyFade(this.editor, drag.clipId, drag.edge, clamped);
    drag.currentFrames = clamped;
    return drag;
  }

  /** Ctrl+click on an audio body adds a volume keyframe; returns true when one was added. */
  private addVolumeKeyframeOnClick(point: Point, clip: Clip, clipRect: Rect, trackIndex: number): boolean {
    if (!this.baseClipKeyframeAutomationVisible(trackIndex)) return false;
    if (!supportsPrecisionControls(clipRect.width) || clip.durationFrames <= 0) return false;
    const body = clipBodyRect(clipRect);
    if (!rectContains(body, point)) return false;
    const pxPerFrame = clipRect.width / clip.durationFrames;
    const offset = Math.max(0, Math.min(Math.max(0, clip.durationFrames - 1), Math.round((point.x - clipRect.x) / pxPerFrame)));
    const absFrame = clip.startFrame + offset;
    const dB = Math.max(VolumeScale.floorDb, Math.min(VolumeScale.ceilingDb, dbForY(point.y, body)));
    commitClipProperty(this.editor, clip.id, (c) => clipUpsertKeyframe(c, "volumeTrack", absFrame, dB), "Add Keyframe");
    this.host.invalidate();
    return true;
  }

  // MARK: - Scrub / range / marker

  private beginPlayheadScrub(frame: number): void {
    const ui = this.editor.ui;
    this.stopAutoScroll();
    this.dragState = { kind: "scrubPlayhead" };
    this.scrubWasPlaying = ui.isPlaying;
    if (this.scrubWasPlaying) ui.isPlaying = false;
    ui.isScrubbing = true;
    seekToFrame(this.editor, frame);
    this.host.invalidateOverlay();
  }

  private continuePlayheadScrub(p: TimelinePointer): void {
    this.setSnapIndicator(undefined);
    this.updateAutoScroll(p);
    this.scrubAt(p);
  }

  private scrubAt(p: TimelinePointer): void {
    const frame = frameAt(this.host.geometry(), p.x + this.host.scrollX());
    if (frame !== this.editor.ui.currentFrame) seekToFrame(this.editor, frame);
    this.host.invalidateOverlay();
  }

  private finishPlayheadScrub(): void {
    const ui = this.editor.ui;
    const resume = this.scrubWasPlaying;
    this.scrubWasPlaying = false;
    ui.isScrubbing = false;
    seekToFrame(this.editor, ui.currentFrame);
    if (resume) ui.isPlaying = true;
  }

  private beginTimelineRangeEdgeDrag(edge: "start" | "end"): void {
    const range = validSelectedTimelineRange(this.editor);
    if (!range) return;
    this.dragState = { kind: "timelineRange", drag: { anchorFrame: edge === "start" ? range.endFrame : range.startFrame } };
    this.snapState = makeSnapState();
    this.setSnapIndicator(undefined);
    this.editor.ui.selectedGap = null;
  }

  private beginTimelineRangeSelection(frame: number): void {
    this.dragState = { kind: "timelineRange", drag: { anchorFrame: frame } };
    this.snapState = makeSnapState();
    this.setSnapIndicator(undefined);
    this.editor.ui.selectedClipIds = new Set();
    this.editor.ui.selectedGap = null;
    setTimelineRange(this.editor, frame, frame);
  }

  private beginMarkerDrag(marker: TimelineMarker, grabFrame: number, adjustsDuration: boolean, clickCount: number): void {
    const original = timelineMarker(this.editor, marker.id);
    if (!original) return;
    const ui = this.editor.ui;
    ui.selectedTimelineMarkerIds = new Set([marker.id]);
    ui.selectedClipIds = new Set();
    ui.selectedGap = null;
    ui.selectedTimelineRange = null;
    this.snapState = makeSnapState();
    this.setSnapIndicator(undefined);
    this.host.setCursor(adjustsDuration ? "ew-resize" : "grabbing");
    this.dragState = { kind: "timelineMarker", drag: { original, adjustsDuration, grabFrame, value: { ...original } } };
    if (clickCount >= 2) this.host.presentMarkerEditor(marker.id);
  }

  // MARK: - External drop (media panel / OS files)

  externalDragUpdate(p: TimelinePointer, assets: MediaAsset[], segments: Record<string, SourceSegment>): void {
    const geometry = this.host.geometry();
    const point = this.doc(p);
    if (!this.external) this.externalSnapState = makeSnapState();
    const frame = this.applyExternalSnap(point.x, assets, segments, geometry);
    this.external = { assets, segments, target: dropTargetAt(geometry, point.y), frame, isRippleInsert: p.ctrl };
    this.host.invalidate();
  }

  externalDragLeave(): void {
    if (!this.external && this.externalSnapX === undefined) return;
    this.external = undefined;
    this.externalSnapX = undefined;
    this.externalSnapState = makeSnapState();
    this.host.invalidate();
  }

  /** Resolves the drop point (with the same snapping as the preview) and clears the preview. */
  externalDrop(p: TimelinePointer, assets: MediaAsset[], segments: Record<string, SourceSegment>): { cursor: TrackDropTarget; frame: number; ripple: boolean } {
    const geometry = this.host.geometry();
    const point = this.doc(p);
    const cursor = dropTargetAt(geometry, point.y);
    const frame = this.applyExternalSnap(point.x, assets, segments, geometry);
    this.externalDragLeave();
    return { cursor, frame, ripple: p.ctrl };
  }

  private applyExternalSnap(docX: number, assets: readonly MediaAsset[], segments: Record<string, SourceSegment>, geometry: TimelineGeometry): number {
    const candidate = frameAt(geometry, docX);
    if (assets.length === 0) {
      this.externalSnapX = undefined;
      return candidate;
    }
    let totalDur = 0;
    for (const a of assets) if (a.type !== "subtitle") totalDur += clipDurationFrames(this.editor, a, segments[a.id]);
    const targets = collectTargets({ tracks: this.editor.timeline.tracks, markerFrames: this.markerSnapFrames(), beatFrames: (clip) => beatSnapFrames(clip, this.editor.timeline.fps, markBeats(), (ref) => beatStore.analysis(ref)) });
    const snap = findSnap({
      position: candidate,
      probeOffsets: [0, totalDur],
      targets,
      state: this.externalSnapState,
      baseThreshold: Snap.thresholdPixels,
      pixelsPerFrame: geometry.pixelsPerFrame,
    });
    this.externalSnapX = snap?.x;
    return snap ? snap.frame - snap.probeOffset : candidate;
  }
}

/** Ctrl/Alt+wheel zoom per pixel of wheel delta: one 100 px notch ≈ four Swift scroll points. */
const wheelZoomSensitivity = Zoom.scrollSensitivity / 25;

function clipKeyframeFramesSupported(clip: Clip, property: AnimatableProperty): boolean {
  if (property === "volume") return clip.mediaType === "audio";
  return clip.mediaType !== "audio";
}

/** NSRect.intersects (positive-area overlap); a zero-size marquee still selects what it lands inside. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  if (b.width === 0 && b.height === 0) return false;
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

