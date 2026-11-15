import type { AnimatableProperty, FadeEdge, Point, Rect, TimelineMarker } from "../model";
import type { TrackDropTarget } from "./timelineGeometry";

export interface KeyframeDrag {
  clipId: string;
  trackIndex: number;
  property: AnimatableProperty;
  originalFrame: number;
  grabFrame: number;
  currentFrame: number;
}

export interface AudioVolumeKfDrag {
  clipId: string;
  trackIndex: number;
  /** kf's absolute frame at drag-start; used by mouseUp to detect no-op drags. */
  originalFrame: number;
  /** kf's dB at drag-start; mouseUp comparison companion to `originalFrame`. */
  originalDb: number;
  /** Cursor frame at drag-start; preserves the pointer's offset to the kf as it moves. */
  grabFrame: number;
  /** kf's current absolute frame; tells the next tick where to find the kf to move. */
  currentFrame: number;
  /** kf's current dB; tells the next tick the kf's current value. */
  currentDb: number;
}

export interface FadeKneeDrag {
  clipId: string;
  trackIndex: number;
  edge: FadeEdge;
  originalFrames: number;
  grabFrame: number;
  currentFrames: number;
}

export interface Participant {
  clipId: string;
  originalTrackId: string;
  originalTrack: number;
  originalFrame: number;
}

export interface MoveClipDrag {
  /** Clip the user grabbed. Vertical drag only relocates this clip. */
  lead: Participant;
  /** Other selected/linked clips that follow horizontally but stay on their own tracks. */
  companions: Participant[];
  grabOffsetFrames: number;
  deltaFrames: number;
  dropTarget: TrackDropTarget;
  isDuplicate: boolean;
}

export function makeMoveClipDrag(
  p: Pick<MoveClipDrag, "lead" | "grabOffsetFrames" | "dropTarget" | "isDuplicate"> & Partial<MoveClipDrag>,
): MoveClipDrag {
  return { companions: [], deltaFrames: 0, ...p };
}

export function moveClipDragAll(d: MoveClipDrag): Participant[] {
  return [d.lead, ...d.companions];
}

export function moveClipDragTrackDelta(d: MoveClipDrag): number {
  return d.dropTarget.kind === "existingTrack" ? d.dropTarget.index - d.lead.originalTrack : 0;
}

export function moveClipDragDropTargetTrackIndex(d: MoveClipDrag): number | undefined {
  return d.dropTarget.kind === "existingTrack" ? d.dropTarget.index : undefined;
}

export interface TrimDrag {
  clipId: string;
  trackIndex: number;
  originalTrimStart: number;
  originalTrimEnd: number;
  originalStartFrame: number;
  originalDuration: number;
  /** Image/Text clips can be trimmed/extended freely without hitting a source-material cap. */
  hasNoSourceMedia: boolean;
  /** When true, trim applies to link-group partners too. */
  propagateToLinked: boolean;
  isRipple: boolean;
  deltaFrames: number;
}

export function makeTrimDrag(p: Omit<TrimDrag, "deltaFrames"> & { deltaFrames?: number }): TrimDrag {
  return { ...p, deltaFrames: p.deltaFrames ?? 0 };
}

export interface SlipDrag {
  clipId: string;
  grabFrame: number;
  /**
   * Timeline-frame caps from source headroom across the slip group:
   * dragging right consumes head material, left consumes tail material.
   */
  maxRightDelta: number;
  maxLeftDelta: number;
  propagateToLinked: boolean;
  deltaFrames: number;
}

export function makeSlipDrag(p: Omit<SlipDrag, "deltaFrames"> & { deltaFrames?: number }): SlipDrag {
  return { ...p, deltaFrames: p.deltaFrames ?? 0 };
}

export interface MarqueeDrag {
  origin: Point;
  current: Rect;
  baseSelection: Set<string>;
  baseMarkerSelection: Set<string>;
}

export function makeMarqueeDrag(origin: Point): MarqueeDrag {
  return {
    origin,
    current: { x: 0, y: 0, width: 0, height: 0 },
    baseSelection: new Set(),
    baseMarkerSelection: new Set(),
  };
}

export interface TimelineRangeDrag {
  anchorFrame: number;
}

export interface TimelineMarkerDrag {
  original: TimelineMarker;
  adjustsDuration: boolean;
  grabFrame: number;
  value: TimelineMarker;
}

export type DragState =
  | { kind: "idle" }
  | { kind: "scrubPlayhead" }
  | { kind: "moveClip"; drag: MoveClipDrag }
  | { kind: "trimLeft"; drag: TrimDrag }
  | { kind: "trimRight"; drag: TrimDrag }
  | { kind: "slip"; drag: SlipDrag }
  | { kind: "keyframe"; drag: KeyframeDrag }
  | { kind: "audioVolumeKf"; drag: AudioVolumeKfDrag }
  | { kind: "fadeKnee"; drag: FadeKneeDrag }
  | { kind: "marquee"; drag: MarqueeDrag }
  | { kind: "timelineRange"; drag: TimelineRangeDrag }
  | { kind: "timelineMarker"; drag: TimelineMarkerDrag };

export const dragIdle: DragState = { kind: "idle" };
