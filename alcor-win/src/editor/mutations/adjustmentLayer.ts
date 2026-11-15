import { Defaults, clipEndFrame, makeClip, type Clip } from "../../model";
import { secondsToFrame } from "../../util/timeFormatting";
import type { Editor } from "../editor";
import { insertTrack } from "./tracks";

export interface AdjustmentLayerSpec {
  startFrame?: number;
  durationFrames?: number;
  /** Existing video track to place it on; omitted = a new track above all others. */
  trackIndex?: number;
}

export function clipIsAdjustmentLayer(clip: Clip): boolean {
  return clip.adjustment === true;
}

/**
 * Adds an adjustment layer: a clip with no media whose effects, opacity and masks apply to the tracks below it.
 * Returns the clip id, or undefined when `trackIndex` cannot take it. Selects the new clip.
 */
export function addAdjustmentLayer(editor: Editor, spec: AdjustmentLayerSpec = {}): string | undefined {
  const timeline = editor.timeline;
  const startFrame = Math.max(0, Math.trunc(spec.startFrame ?? editor.ui.currentFrame));
  const durationFrames = Math.max(1, Math.trunc(spec.durationFrames ?? secondsToFrame(Defaults.imageDurationSeconds, timeline.fps)));
  if (spec.trackIndex !== undefined) {
    const track = timeline.tracks[spec.trackIndex];
    const end = startFrame + durationFrames;
    if (!track || track.type !== "video" || track.clips.some((c) => c.startFrame < end && clipEndFrame(c) > startFrame)) return undefined;
  }
  const clip = makeClip({
    mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame, durationFrames, adjustment: true,
  });
  editor.perform("Add Adjustment Layer", () => {
    const index = spec.trackIndex ?? insertTrack(editor, 0, "video");
    editor.timeline.tracks[index]?.clips.push(clip);
    editor.sortClips(index);
  });
  editor.ui.selectedClipIds = new Set([clip.id]);
  editor.ui.selectedTransitionId = null;
  return clip.id;
}
