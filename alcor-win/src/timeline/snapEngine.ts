import { Snap, clipEndFrame, type Clip, type Track } from "../model";

export type SnapTargetKind = "playhead" | "clipEdge" | "beat" | "marker";

export interface SnapTarget {
  frame: number;
  kind: SnapTargetKind;
}

export interface SnapResult {
  frame: number;
  /** Which probe snapped (0 = start, duration = end). */
  probeOffset: number;
  /** Snap indicator pixel position. */
  x: number;
}

/** Mutable state that persists across drag events for sticky snap behavior. */
export interface SnapState {
  currentlySnappedTo: number | undefined;
  currentProbeOffset: number;
}

export function makeSnapState(): SnapState {
  return { currentlySnappedTo: undefined, currentProbeOffset: 0 };
}

export interface CollectTargetsOptions {
  tracks: readonly Track[];
  playheadFrame?: number;
  excludeClipIds?: ReadonlySet<string>;
  includePlayhead?: boolean;
  markerFrames?: readonly number[];
  beatFrames?: (clip: Clip) => number[];
  includeExcludedClipBeats?: boolean;
}

/** Collects clip edges, markers, beats and optionally the playhead as snap targets. */
export function collectTargets(o: CollectTargetsOptions): SnapTarget[] {
  const playheadFrame = o.playheadFrame ?? 0;
  const excludeClipIds = o.excludeClipIds ?? new Set<string>();
  const includeExcludedClipBeats = o.includeExcludedClipBeats ?? false;
  const targets: SnapTarget[] = [];
  if (o.includePlayhead ?? false) targets.push({ frame: playheadFrame, kind: "playhead" });
  for (const frame of o.markerFrames ?? []) targets.push({ frame, kind: "marker" });
  for (const track of o.tracks) {
    for (const clip of track.clips) {
      const excluded = excludeClipIds.has(clip.id);
      if (!excluded) {
        targets.push({ frame: clip.startFrame, kind: "clipEdge" });
        targets.push({ frame: clipEndFrame(clip), kind: "clipEdge" });
      }
      if (o.beatFrames && (!excluded || includeExcludedClipBeats)) {
        for (const frame of o.beatFrames(clip)) targets.push({ frame, kind: "beat" });
      }
    }
  }
  return targets;
}

export interface FindSnapOptions {
  position: number;
  probeOffsets?: readonly number[];
  targets: readonly SnapTarget[];
  state: SnapState;
  baseThreshold: number;
  pixelsPerFrame: number;
}

/**
 * Snap position(s) to the nearest target, with sticky behavior and playhead priority.
 * Mutates `state` (Swift `inout`). The macOS haptic is not ported.
 */
export function findSnap(o: FindSnapOptions): SnapResult | null {
  const { position, targets, state, pixelsPerFrame } = o;
  const probeOffsets = o.probeOffsets ?? [0];
  const baseFrameThreshold = o.baseThreshold / pixelsPerFrame;

  // Sticky: stay snapped until moved stickyMultiplier x threshold away.
  const snapped = state.currentlySnappedTo;
  if (snapped !== undefined) {
    const holdThreshold = baseFrameThreshold * Snap.stickyMultiplier;
    const probePos = position + state.currentProbeOffset;
    if (Math.abs(probePos - snapped) <= holdThreshold && targets.some((t) => t.frame === snapped)) {
      return { frame: snapped, probeOffset: state.currentProbeOffset, x: snapped * pixelsPerFrame };
    }
    state.currentlySnappedTo = undefined;
    state.currentProbeOffset = 0;
  }

  let best: { probeOffset: number; target: SnapTarget; distance: number } | undefined;
  for (const probeOffset of probeOffsets) {
    const probePos = position + probeOffset;
    for (const target of targets) {
      const threshold = target.kind === "playhead" ? baseFrameThreshold * Snap.playheadMultiplier : baseFrameThreshold;
      const dist = Math.abs(probePos - target.frame);
      if (dist <= threshold && dist < (best?.distance ?? Infinity)) {
        best = { probeOffset, target, distance: dist };
      }
    }
  }

  if (!best) return null;
  state.currentlySnappedTo = best.target.frame;
  state.currentProbeOffset = best.probeOffset;
  return { frame: best.target.frame, probeOffset: best.probeOffset, x: best.target.frame * pixelsPerFrame };
}
