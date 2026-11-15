// Port of EditorViewModel+GeneratedClips.swift.
import { timelineTotalFrames, timelineReachableTimelines, type Clip, type MediaAsset } from "../../model";
import { secondsToFrame } from "../../util/timeFormatting";
import type { Editor } from "../editor";
import { placeClip, timelineFor } from "./core";
import { resolveOrCreateAudioTrack } from "./linking";
import { validSelectedTimelineRange } from "./timelineRange";
import { mediaHooks } from "../../media/mediaHooks";

export interface TimelineSpan {
  startFrame: number;
  frameCount: number;
}

/** The marked range, else the whole timeline; null when empty. */
export function selectedTimelineSpan(editor: Editor): TimelineSpan | null {
  const range = validSelectedTimelineRange(editor);
  if (range) {
    const count = range.endFrame - range.startFrame;
    return count > 0 ? { startFrame: range.startFrame, frameCount: count } : null;
  }
  const total = timelineTotalFrames(editor.timeline);
  return total > 0 ? { startFrame: 0, frameCount: total } : null;
}

/** Places the generating placeholder on a (possibly new) audio track as one undo step named `actionName`. */
export function placeGeneratingAudioClip(
  editor: Editor,
  placeholderId: string,
  startFrame: number,
  spanSeconds: number,
  actionName: string,
): string | null {
  const asset = editor.mediaAsset(placeholderId);
  if (!asset) return null;
  const durationFrames = Math.max(1, secondsToFrame(spanSeconds, editor.timeline.fps));
  return editor.perform(actionName, () => {
    const trackIndex = resolveOrCreateAudioTrack(editor, startFrame, durationFrames);
    const ids = placeClip(editor, asset, trackIndex, startFrame, durationFrames, { addLinkedAudio: false });
    return ids[0] ?? null;
  });
}

/** Called when a generated asset is ready: the clip takes the real duration. */
export function finalizeGeneratingClip(editor: Editor, placeholderId: string, asset: MediaAsset): void {
  patchGeneratingClips(editor, placeholderId, (clip, fps) => {
    clip.durationFrames = Math.max(1, secondsToFrame(asset.duration, fps));
    clip.trimStartFrame = 0;
    clip.trimEndFrame = 0;
  });
}

/** Patches every clip (in every timeline) that references the placeholder; not undoable. */
export function patchGeneratingClips(editor: Editor, placeholderId: string, patch: (clip: Clip, fps: number) => void): void {
  const touched = new Set<string>();
  editor.withoutRegistration(() => {
    for (const timeline of editor.doc.timelines) {
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if (clip.mediaRef !== placeholderId) continue;
          patch(clip, timeline.fps);
          touched.add(timeline.id);
        }
      }
    }
  });
  if (touched.size === 0) return;
  const visible = touched.has(editor.timeline.id) ||
    timelineReachableTimelines(editor.timeline, (id) => timelineFor(editor, id)).some((t) => touched.has(t.id));
  if (visible) mediaHooks.timelineChanged?.();
}
