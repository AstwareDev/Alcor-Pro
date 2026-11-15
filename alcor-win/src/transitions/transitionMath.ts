import { clipEndFrame, type Clip, type Track } from "../model/timeline";
import { transitionDefaultSeconds, type Transition, type TransitionAlignment } from "../model/transition";
import { swiftRound } from "../util/math";

/** Timeline frames a transition covers: `[start, end)`. */
export interface TransitionSpan {
  start: number;
  end: number;
}

/** Frames of the outgoing clip (before the cut) and of the incoming clip (after the cut) the span covers. */
export function transitionExtents(durationFrames: number, alignment: TransitionAlignment): { before: number; after: number } {
  if (alignment === "start") return { before: 0, after: durationFrames };
  if (alignment === "end") return { before: durationFrames, after: 0 };
  const before = Math.floor(durationFrames / 2);
  return { before, after: durationFrames - before };
}

export function transitionSpan(cutFrame: number, durationFrames: number, alignment: TransitionAlignment): TransitionSpan {
  const { before } = transitionExtents(durationFrames, alignment);
  return { start: cutFrame - before, end: cutFrame - before + durationFrames };
}

/**
 * Longest duration both clips can host. Each clip gives at most half its length to a transition, so the transitions
 * on both sides of one clip never overlap. 0 means the clips are too short for any transition.
 */
export function transitionMaxFrames(alignment: TransitionAlignment, fromDuration: number, toDuration: number): number {
  const halfFrom = Math.floor(fromDuration / 2);
  const halfTo = Math.floor(toDuration / 2);
  if (alignment === "start") return halfTo;
  if (alignment === "end") return halfFrom;
  return Math.max(0, Math.min(2 * halfTo, 2 * halfFrom + 1));
}

export function defaultTransitionFrames(fps: number): number {
  return Math.max(2, swiftRound(fps * transitionDefaultSeconds));
}

/** Blend position 0…1 of a frame inside the span, sampled at the frame centre so no frame is pure A or pure B. */
export function transitionProgress(span: TransitionSpan, frame: number): number {
  const length = span.end - span.start;
  if (!(length > 0)) return 1;
  return Math.min(1, Math.max(0, (frame - span.start + 0.5) / length));
}

/** Audio crossfade position: 0 at the span start, 1 at its end, so both clips reach exact silence / full level. */
export function transitionAudioProgress(span: TransitionSpan, frame: number): number {
  const length = span.end - span.start;
  if (!(length > 0)) return 1;
  return Math.min(1, Math.max(0, (frame - span.start) / length));
}

export interface ActiveTransition {
  transition: Transition;
  from: Clip;
  to: Clip;
  span: TransitionSpan;
}

export function transitionCutFrame(to: Clip): number {
  return to.startFrame;
}

/** The transition on `track` covering `frame`, if any. Allocates only when one is active. */
export function activeTransitionAt(track: Track, frame: number): ActiveTransition | undefined {
  const list = track.transitions;
  if (!list || list.length === 0) return undefined;
  for (const transition of list) {
    let to: Clip | undefined;
    for (const c of track.clips) if (c.id === transition.toClipId) to = c;
    if (!to) continue;
    const span = transitionSpan(transitionCutFrame(to), transition.durationFrames, transition.alignment);
    if (frame < span.start || frame >= span.end) continue;
    let from: Clip | undefined;
    for (const c of track.clips) if (c.id === transition.fromClipId) from = c;
    if (!from) continue;
    return { transition, from, to, span };
  }
  return undefined;
}

export function transitionIsAdjacent(from: Clip, to: Clip): boolean {
  return from.id !== to.id && clipEndFrame(from) === to.startFrame;
}
