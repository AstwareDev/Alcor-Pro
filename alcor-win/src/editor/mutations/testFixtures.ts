// Test helpers shared by the mutation tests (port of Tests/PalmierProTests/Fixtures.swift and the per-suite
// `editor(_:)` / `asset(...)` helpers). Only imported by *.test.ts.
import {
  makeMediaAsset,
  makeTimelineMarker,
  type Clip,
  type ClipType,
  type MediaAsset,
  type Timeline,
  type TimelineMarker,
  type Track,
} from "../../model";
import { fixtureAudioTrack, fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../../model/fixtures";
import { Editor, makeEditorDocument } from "../editor";
import { makeFrameRange } from "../rippleEngine";

export const Fixtures = {
  clip: fixtureClip,
  videoTrack: fixtureVideoTrack,
  audioTrack: fixtureAudioTrack,
  timeline: fixtureTimeline,
};

/** `EditorViewModel()` with `timeline = Fixtures.timeline(tracks:)`. */
export function makeEditor(tracks: Track[] = [], p: { fps?: number; markers?: TimelineMarker[] } = {}): Editor {
  const doc = makeEditorDocument();
  const timeline: Timeline = Fixtures.timeline({ fps: p.fps, tracks });
  if (p.markers) timeline.markers = p.markers;
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  return new Editor(doc);
}

export function marker(id: string, name: string, startFrame: number, durationFrames = 0): TimelineMarker {
  return makeTimelineMarker({ id, name, startFrame, durationFrames });
}

export function makeAsset(p: {
  id: string;
  type: ClipType;
  duration: number;
  hasAudio?: boolean;
  sourceWidth?: number;
  sourceHeight?: number;
}): MediaAsset {
  const asset = makeMediaAsset({ id: p.id, url: `/tmp/${p.id}`, type: p.type, name: p.id, duration: p.duration });
  if (p.hasAudio !== undefined) asset.hasAudio = p.hasAudio;
  if (p.sourceWidth !== undefined) asset.sourceWidth = p.sourceWidth;
  if (p.sourceHeight !== undefined) asset.sourceHeight = p.sourceHeight;
  return asset;
}

export function sortedByStart(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startFrame - b.startFrame);
}

export function clipById(editor: Editor, id: string): Clip {
  const clip = editor.clipFor(id);
  if (!clip) throw new Error(`clip ${id} not found`);
  return clip;
}

export function allClips(editor: Editor): Clip[] {
  return editor.timeline.tracks.flatMap((t) => t.clips);
}

/** `[[start, end], ...]` of a track's clips ordered by start frame. */
export function spans(track: Track): number[][] {
  return sortedByStart(track.clips).map((c) => [c.startFrame, c.startFrame + c.durationFrames]);
}

export function starts(track: Track): number[] {
  return sortedByStart(track.clips).map((c) => c.startFrame);
}

/** Direct, unregistered edit of the document (Swift test setup that assigns `e.timeline...` / `e.mediaAssets`). */
export function setup(editor: Editor, fn: (editor: Editor) => void): void {
  editor.withoutRegistration(() => fn(editor));
}

/** Equivalent of setting `e.selectedGap = GapSelection(trackIndex:range:)`. */
export function selectGap(editor: Editor, trackIndex: number, start: number, end: number): void {
  editor.ui.selectedGap = { trackIndex, range: makeFrameRange(start, end) };
}

/** Plain deep copy of the active timeline (what Swift `let before = e.timeline` captures). */
export function timelineCopy(editor: Editor): Timeline {
  return structuredClone(editor.timeline);
}
