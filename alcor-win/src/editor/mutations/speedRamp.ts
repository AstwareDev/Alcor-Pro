import {
  clipSetSpeedRamp, clipSupportsRetiming, keyframeTrackIsActive, makeKeyframe, makeKeyframeTrack, speedRampFromPreset,
  speedRampPresets, speedRampRange, type BezierHandles, type Interpolation, type KeyframeTrack,
} from "../../model";
import type { Editor } from "../editor";
import { commitClipProperties, refusesMulticamRetime } from "./clipMutations";
import { linkedPartnerIds } from "./linking";
import { setOptional } from "../../model/equality";

export interface SpeedRampPoint {
  /** Clip-relative frame. */
  frame: number;
  speed: number;
  interpolation?: Interpolation;
  bezier?: BezierHandles;
}

/** The ids plus their linked partners that can be retimed, so picture and sound ramp together. */
function rampTargets(editor: Editor, ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const clip = editor.clipFor(id);
    if (clip && clipSupportsRetiming(clip)) out.add(id);
    for (const partner of linkedPartnerIds(editor, id)) {
      const p = editor.clipFor(partner);
      if (p && clipSupportsRetiming(p)) out.add(partner);
    }
  }
  return [...out];
}

/** One undo entry. `presetId` undefined clears the ramp (the clip keeps its mean speed). Returns the clips changed. */
export function applySpeedRampPreset(editor: Editor, ids: readonly string[], presetId: string | undefined): string[] {
  const preset = presetId === undefined ? undefined : speedRampPresets.find((p) => p.id === presetId);
  if (presetId !== undefined && !preset) return [];
  const targets = rampTargets(editor, ids);
  if (targets.length === 0 || refusesMulticamRetime(editor, targets)) return [];
  commitClipProperties(
    editor,
    targets,
    (clip) => clipSetSpeedRamp(clip, preset ? speedRampFromPreset(clip, preset) : undefined),
    preset ? "Speed Ramp" : "Remove Speed Ramp",
  );
  return targets;
}

export function validateSpeedRampPoints(points: readonly SpeedRampPoint[], durationFrames: number): string | undefined {
  if (points.length === 0) return undefined;
  for (const p of points) {
    if (!Number.isInteger(p.frame) || p.frame < 0 || p.frame >= durationFrames) return `frame ${p.frame} is outside the clip (0-${durationFrames - 1})`;
    if (!(p.speed >= speedRampRange.min && p.speed <= speedRampRange.max)) {
      return `speed ${p.speed} must be between ${speedRampRange.min} and ${speedRampRange.max}`;
    }
  }
  return undefined;
}

export function speedTrackFromPoints(points: readonly SpeedRampPoint[]): KeyframeTrack<number> {
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  const track = makeKeyframeTrack<number>();
  for (const p of sorted) {
    const kf = makeKeyframe(p.frame, p.speed, p.interpolation ?? "smooth", p.bezier);
    const last = track.keyframes[track.keyframes.length - 1];
    if (last && last.frame === p.frame) track.keyframes[track.keyframes.length - 1] = kf;
    else track.keyframes.push(kf);
  }
  return track;
}

/** Explicit keyframes (clip-relative frames); an empty list clears the ramp. One undo entry. */
export function setSpeedRampPoints(editor: Editor, ids: readonly string[], points: readonly SpeedRampPoint[]): string[] {
  const targets = rampTargets(editor, ids);
  if (targets.length === 0 || refusesMulticamRetime(editor, targets)) return [];
  commitClipProperties(
    editor,
    targets,
    (clip) => clipSetSpeedRamp(clip, points.length === 0 ? undefined : speedTrackFromPoints(points)),
    points.length === 0 ? "Remove Speed Ramp" : "Speed Ramp",
  );
  return targets;
}

export function setFrameBlending(editor: Editor, ids: readonly string[], on: boolean): void {
  const targets = rampTargets(editor, ids);
  if (targets.length === 0) return;
  commitClipProperties(editor, targets, (clip) => setOptional(clip, "frameBlending", on ? true : undefined), "Change Frame Blending");
}

export function clipHasRamp(editor: Editor, id: string): boolean {
  const clip = editor.clipFor(id);
  return clip?.speedTrack !== undefined && keyframeTrackIsActive(clip.speedTrack);
}
