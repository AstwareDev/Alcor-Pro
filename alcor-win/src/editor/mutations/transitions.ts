import {
  clipEndFrame, clipTypeIsVisual, makeTransition,
  type Clip, type Track, type Transition, type TransitionAlignment, type TransitionKind,
} from "../../model";
import { defaultTransitionFrames, transitionMaxFrames } from "../../transitions/transitionMath";
import type { Editor } from "../editor";

export interface TransitionSpec {
  kind?: TransitionKind;
  durationFrames?: number;
  alignment?: TransitionAlignment;
}

export type TransitionResult = { ok: true; transition: Transition } | { ok: false; reason: string };

export interface TransitionLocation {
  trackIndex: number;
  transition: Transition;
}

export interface Cut {
  trackIndex: number;
  from: Clip;
  to: Clip;
  /** The cut's timeline frame (the incoming clip's start). */
  frame: number;
  transition?: Transition;
}

export function findTransition(editor: Editor, id: string): TransitionLocation | undefined {
  const tracks = editor.timeline.tracks;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const transition = tracks[trackIndex]?.transitions?.find((t) => t.id === id);
    if (transition) return { trackIndex, transition };
  }
  return undefined;
}

export function transitionAtCut(track: Track, fromClipId: string, toClipId: string): Transition | undefined {
  return track.transitions?.find((t) => t.fromClipId === fromClipId || t.toClipId === toClipId);
}

function isEligibleTrack(track: Track): boolean {
  return clipTypeIsVisual(track.type);
}

/** The cut at the end of `fromClipId`: the clip that starts exactly where it ends on the same track. */
export function cutAfterClip(editor: Editor, fromClipId: string): Cut | undefined {
  const tracks = editor.timeline.tracks;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex] as Track;
    const from = track.clips.find((c) => c.id === fromClipId);
    if (!from) continue;
    const to = track.clips.find((c) => c.startFrame === clipEndFrame(from) && c.id !== from.id);
    if (!to) return undefined;
    const transition = transitionAtCut(track, from.id, to.id);
    return { trackIndex, from, to, frame: to.startFrame, ...(transition ? { transition } : {}) };
  }
  return undefined;
}

/** Every touching clip pair on visual tracks, optionally only those without a transition. */
export function timelineCuts(editor: Editor, withoutTransition = false): Cut[] {
  const cuts: Cut[] = [];
  editor.timeline.tracks.forEach((track, trackIndex) => {
    if (!isEligibleTrack(track)) return;
    const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const from = sorted[i] as Clip, to = sorted[i + 1] as Clip;
      if (clipEndFrame(from) !== to.startFrame || from.adjustment === true || to.adjustment === true) continue;
      const transition = transitionAtCut(track, from.id, to.id);
      if (withoutTransition && transition) continue;
      cuts.push({ trackIndex, from, to, frame: to.startFrame, ...(transition ? { transition } : {}) });
    }
  });
  return cuts;
}

function clampDuration(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

/** Adds a transition at the cut between two adjacent clips of one track (default 0.5 s cross dissolve) and selects it. */
export function addTransition(editor: Editor, fromClipId: string, toClipId: string, spec: TransitionSpec = {}): TransitionResult {
  const tracks = editor.timeline.tracks;
  const trackIndex = tracks.findIndex((t) => t.clips.some((c) => c.id === fromClipId));
  const track = tracks[trackIndex];
  if (!track) return { ok: false, reason: `Clip not found: ${fromClipId}` };
  const from = track.clips.find((c) => c.id === fromClipId) as Clip;
  const to = track.clips.find((c) => c.id === toClipId);
  if (!to) return { ok: false, reason: "The clips must be on the same track." };
  if (!isEligibleTrack(track)) return { ok: false, reason: "Transitions go between video, image or text clips." };
  if (from.adjustment === true || to.adjustment === true) return { ok: false, reason: "Adjustment layers cannot have transitions." };
  if (clipEndFrame(from) !== to.startFrame) return { ok: false, reason: "The clips must touch: there is a gap or overlap between them." };
  if (transitionAtCut(track, from.id, to.id)) return { ok: false, reason: "This cut already has a transition." };
  const alignment = spec.alignment ?? "center";
  const max = transitionMaxFrames(alignment, from.durationFrames, to.durationFrames);
  if (max < 1) return { ok: false, reason: "The clips are too short for a transition." };
  const requested = spec.durationFrames ?? defaultTransitionFrames(editor.timeline.fps);
  const transition = makeTransition({
    fromClipId, toClipId, durationFrames: clampDuration(requested, max), alignment, ...(spec.kind ? { kind: spec.kind } : {}),
  });
  editor.perform("Add Transition", () => {
    const t = editor.timeline.tracks[trackIndex] as Track;
    (t.transitions ??= []).push(transition);
  });
  editor.ui.selectedClipIds = new Set();
  editor.ui.selectedTransitionId = transition.id;
  return { ok: true, transition };
}

/** Adds a transition at the end of `fromClipId`, to whichever clip follows it directly. */
export function addTransitionAfterClip(editor: Editor, fromClipId: string, spec: TransitionSpec = {}): TransitionResult {
  const cut = cutAfterClip(editor, fromClipId);
  if (!cut) return { ok: false, reason: "No clip touches the end of that clip." };
  return addTransition(editor, cut.from.id, cut.to.id, spec);
}

/** Ctrl+T: the default transition at the transition-less cut nearest the playhead. */
export function addTransitionNearPlayhead(editor: Editor): TransitionResult {
  const frame = editor.ui.currentFrame;
  let best: Cut | undefined;
  for (const cut of timelineCuts(editor, true)) {
    if (!best || Math.abs(cut.frame - frame) < Math.abs(best.frame - frame)) best = cut;
  }
  if (!best) return { ok: false, reason: "No cut without a transition on any video track." };
  return addTransition(editor, best.from.id, best.to.id);
}

/** Changes kind, duration or alignment. Duration is clamped to what both clips can host. One undo entry. */
export function updateTransition(editor: Editor, id: string, patch: TransitionSpec): TransitionResult {
  const found = findTransition(editor, id);
  if (!found) return { ok: false, reason: `Transition not found: ${id}` };
  const track = editor.timeline.tracks[found.trackIndex] as Track;
  const from = track.clips.find((c) => c.id === found.transition.fromClipId);
  const to = track.clips.find((c) => c.id === found.transition.toClipId);
  if (!from || !to) return { ok: false, reason: "The transition's clips are gone." };
  const alignment = patch.alignment ?? found.transition.alignment;
  const max = transitionMaxFrames(alignment, from.durationFrames, to.durationFrames);
  if (max < 1) return { ok: false, reason: "The clips are too short for that alignment." };
  const duration = clampDuration(patch.durationFrames ?? found.transition.durationFrames, max);
  const kind = patch.kind ?? found.transition.kind;
  const t = found.transition;
  if (t.kind !== kind || t.durationFrames !== duration || t.alignment !== alignment) {
    editor.perform("Change Transition", () => {
      const live = editor.timeline.tracks[found.trackIndex]?.transitions?.find((x) => x.id === id);
      if (!live) return;
      live.kind = kind;
      live.durationFrames = duration;
      live.alignment = alignment;
    });
  }
  const updated = findTransition(editor, id);
  return updated ? { ok: true, transition: updated.transition } : { ok: false, reason: `Transition not found: ${id}` };
}

export function removeTransition(editor: Editor, id: string): boolean {
  const found = findTransition(editor, id);
  if (!found) return false;
  editor.perform("Remove Transition", () => {
    const track = editor.timeline.tracks[found.trackIndex] as Track;
    const list = track.transitions;
    if (!list) return;
    const rest = list.filter((t) => t.id !== id);
    if (rest.length === 0) delete track.transitions;
    else track.transitions = rest;
  });
  if (editor.ui.selectedTransitionId === id) editor.ui.selectedTransitionId = null;
  return true;
}
