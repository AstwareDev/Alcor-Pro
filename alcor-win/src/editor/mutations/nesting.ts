// Port of EditorViewModel+Nesting: nested-timeline eligibility, carrier insertion, create-from-selection, decompose.
// Not ported: tab-bar UI overrides (timelineTabRenameRequest / timelineTabBarExpandedOverride) have no editor state yet.
import {
  clipEndFrame, clipFreshenIds, makeClip, makeCrop, makeTimeline, makeTrack, timelineHasAudioClips, timelineReachableTimelines,
  timelineTotalFrames, type Clip, type ClipType, type Timeline,
} from "../../model";
import { nestFlatten } from "../../preview/nestFlattener";
import { newId } from "../../util/id";
import { snapshot } from "../../util/snapshot";
import type { Editor } from "../editor";
import { clearRegion } from "./clipMutations";
import { deepEqual, fitTransformForSourceSize, nestBlockReason, timelineFor } from "./core";
import type { TrackDropTarget } from "../../timeline/timelineGeometry";
import { expandToLinkGroup, materializeTrackIndex, resolveOrCreateAudioTrack } from "./linking";
import { timelineRegenerateIds } from "./timelines";
import { insertTrack, pruneEmptyTracks } from "./tracks";

export { nestBlockReason, wouldCreateNestCycle } from "./core";

export const nestDiscardedToast = "Nest settings discarded. Undo to restore.";

/** `isVisibleFromActive(_:)` */
export function isVisibleFromActive(editor: Editor, id: string): boolean {
  return id === editor.doc.activeTimelineId
    || timelineReachableTimelines(editor.timeline, (t) => timelineFor(editor, t)).some((t) => t.id === id);
}

function uniqueNestName(editor: Editor): string {
  const used = new Set(editor.doc.timelines.map((t) => t.name));
  let n = 1;
  while (used.has(`Nest ${n}`)) n += 1;
  return `Nest ${n}`;
}

function trackOverlaps(editor: Editor, idx: number, start: number, end: number): boolean {
  return editor.timeline.tracks[idx].clips.some((c) => c.startFrame < end && clipEndFrame(c) > start);
}

/** Inserts linked `.sequence` carrier clips on already-resolved tracks, clearing their span. */
function insertNestCarriers(
  editor: Editor, child: Timeline, start: number, duration: number, videoIdx: number | undefined, audioIdx: number | undefined,
): Set<string> {
  const linkGroupId = videoIdx !== undefined && audioIdx !== undefined ? newId() : undefined;
  const carrierIds = new Set<string>();
  const add = (idx: number, mediaType: ClipType, extra: Partial<Clip>): void => {
    clearRegion(editor, idx, start, start + duration, { prune: false });
    const clip = makeClip({
      mediaRef: child.id, mediaType, sourceClipType: "sequence", startFrame: start, durationFrames: duration, ...extra,
    });
    if (linkGroupId !== undefined) clip.linkGroupId = linkGroupId;
    editor.timeline.tracks[idx].clips.push(clip);
    editor.sortClips(idx);
    carrierIds.add(clip.id);
  };
  if (videoIdx !== undefined) add(videoIdx, "sequence", { transform: fitTransformForSourceSize(editor, child.width, child.height) });
  if (audioIdx !== undefined) add(audioIdx, "audio", {});
  return carrierIds;
}

/** Drops `childId` into the active timeline as a single nested clip. Returns false (with a toast) when refused. */
export function nestTimeline(editor: Editor, childId: string, cursor: TrackDropTarget, atFrame: number): boolean {
  const child = timelineFor(editor, childId);
  if (!child) return false;
  const reason = nestBlockReason(editor, childId);
  if (reason !== null) {
    editor.showToast(reason);
    return false;
  }
  const childValue = snapshot(child);
  const duration = timelineTotalFrames(childValue);
  const startFrame = Math.max(0, atFrame);

  editor.perform("Nest Timeline", () => {
    let videoTarget = cursor;
    if (cursor.kind === "existingTrack") {
      const track = editor.timeline.tracks[cursor.index];
      if (!track || track.type !== "video") videoTarget = { kind: "newTrackAt", index: 0 };
    }
    const videoIdx = materializeTrackIndex(editor, videoTarget, "video");
    const audioIdx = timelineHasAudioClips(childValue) ? resolveOrCreateAudioTrack(editor, startFrame, duration) : undefined;
    insertNestCarriers(editor, childValue, startFrame, duration, videoIdx, audioIdx);
  });
  return true;
}

/** Moves the selected clips into a new "Nest N" timeline and replaces them with linked carriers. */
export function nestSelectedClips(editor: Editor): void {
  const ids = editor.ui.selectedClipIds;
  const lanes: { index: number; type: ClipType; clips: Clip[] }[] = [];
  editor.timeline.tracks.forEach((track, index) => {
    const picked = track.clips.filter((c) => ids.has(c.id));
    if (picked.length > 0) lanes.push({ index, type: track.type, clips: picked.map((c) => structuredClone(snapshot(c))) });
  });
  if (lanes.length === 0) return;

  const all = lanes.flatMap((l) => l.clips);
  const start = Math.min(...all.map((c) => c.startFrame));
  const duration = Math.max(...all.map(clipEndFrame)) - start;

  const active = editor.timeline;
  const child = makeTimeline({
    name: uniqueNestName(editor),
    fps: active.fps,
    width: active.width,
    height: active.height,
    settingsConfigured: active.settingsConfigured,
    tracks: lanes.map((lane) =>
      makeTrack({
        type: lane.type,
        clips: lane.clips.map((c) => {
          c.startFrame -= start;
          return c;
        }),
      }),
    ),
  });
  timelineRegenerateIds(child);

  editor.perform("Nest Clips", () => {
    editor.doc.timelines.push(child);
    editor.ui.selectedClipIds = new Set();
    for (const track of editor.timeline.tracks) track.clips = track.clips.filter((c) => !ids.has(c.id));
    const end = start + duration;
    let videoIdx = lanes.find((l) => l.type !== "audio")?.index;
    let audioIdx = lanes.find((l) => l.type === "audio")?.index;
    if (videoIdx !== undefined && trackOverlaps(editor, videoIdx, start, end)) {
      const inserted = insertTrack(editor, videoIdx, "video");
      videoIdx = inserted;
      if (audioIdx !== undefined && audioIdx >= inserted) audioIdx += 1;
    }
    if (audioIdx !== undefined && trackOverlaps(editor, audioIdx, start, end)) {
      audioIdx = insertTrack(editor, audioIdx + 1, "audio");
    }
    const carriers = insertNestCarriers(editor, child, start, duration, videoIdx, audioIdx);
    pruneEmptyTracks(editor);
    editor.ui.selectedClipIds = carriers;
    editor.doc.openTimelineIds.push(child.id);
  });
}

/** Group-level looks that have no per-clip equivalent after decompose. */
function carrierHasGroupLook(editor: Editor, clip: Clip, child: Timeline): boolean {
  return clip.opacity !== 1 || !deepEqual(clip.crop, makeCrop()) || clip.edgeRounding !== 0 || clip.edgeSoftness !== 0
    || (clip.effects !== undefined && clip.effects.length > 0)
    || clip.fadeInFrames > 0 || clip.fadeOutFrames > 0 || clip.blendMode !== undefined
    || clip.opacityTrack !== undefined || clip.positionTrack !== undefined || clip.scaleTrack !== undefined
    || clip.rotationTrack !== undefined || clip.cropTrack !== undefined
    || !deepEqual(clip.transform, fitTransformForSourceSize(editor, child.width, child.height));
}

/** Replaces a nest clip (and its linked audio) with the child's clips remapped in place. */
export function decomposeNest(editor: Editor, clipId: string): void {
  const loc = editor.findClip(clipId);
  if (!loc) return;
  const clicked = snapshot(editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex]);
  const childLive = timelineFor(editor, clicked.mediaRef);
  if (clicked.sourceClipType !== "sequence" || !childLive) return;
  const child = snapshot(childLive);

  let videoCarrier: Clip | undefined;
  let audioCarrier: Clip | undefined;
  const group = expandToLinkGroup(editor, new Set([clicked.id]));
  for (const id of group) {
    const l = editor.findClip(id);
    if (!l) continue;
    const c = snapshot(editor.timeline.tracks[l.trackIndex].clips[l.clipIndex]);
    if (c.sourceClipType !== "sequence" || c.mediaRef !== clicked.mediaRef) continue;
    if (c.mediaType === "audio") audioCarrier = c;
    else videoCarrier = c;
  }
  editor.ui.selectedClipIds = new Set([...editor.ui.selectedClipIds].filter((id) => !group.has(id)));

  const groups = new Map<string, string>();
  const freshen = (clip: Clip, volumeScale: number): Clip => {
    const c = structuredClone(snapshot(clip));
    clipFreshenIds(c, groups);
    c.volume *= volumeScale;
    return c;
  };

  // Top lane reuses the carrier's track; later lanes reuse free-span tracks below before inserting new ones.
  const place = (lanes: Clip[][], carrier: Clip, type: ClipType, volumeScale: number): void => {
    const l = editor.findClip(carrier.id);
    if (!l) return;
    const spanStart = carrier.startFrame;
    const spanEnd = clipEndFrame(carrier);
    editor.timeline.tracks[l.trackIndex].clips.splice(l.clipIndex, 1);
    let idx = l.trackIndex;
    for (const lane of lanes) {
      const track = editor.timeline.tracks[idx];
      const free = track !== undefined && track.type === type
        && !track.clips.some((c) => c.startFrame < spanEnd && clipEndFrame(c) > spanStart);
      if (!free) idx = insertTrack(editor, idx, type);
      editor.timeline.tracks[idx].clips.push(...lane.map((c) => freshen(c, volumeScale)));
      editor.sortClips(idx);
      idx += 1;
    }
  };

  editor.perform("Decompose Nested Timeline", () => {
    if (videoCarrier) place(nestFlatten(videoCarrier, child, true).videoTracks, videoCarrier, "video", 1);
    if (audioCarrier) place(nestFlatten(audioCarrier, child, false).audioTracks, audioCarrier, "audio", audioCarrier.volume);
    pruneEmptyTracks(editor);
  });

  if ((videoCarrier && carrierHasGroupLook(editor, videoCarrier, child))
    || (audioCarrier && (audioCarrier.fadeInFrames > 0 || audioCarrier.fadeOutFrames > 0 || audioCarrier.volumeTrack !== undefined))) {
    editor.showToast(nestDiscardedToast);
  }
}
