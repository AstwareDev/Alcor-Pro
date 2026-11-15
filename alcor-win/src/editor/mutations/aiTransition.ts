// Port of EditorViewModel+AITransition.swift.
import type { MediaAsset } from "../../model";
import { firstAndLastFrameModel } from "../../generation/catalog";
import { transitionSeed } from "../../generation/edit/editSubmitter";
import type { PendingTransitionPlacement } from "../../generation/generationState";
import type { VideoEntry } from "../../generation/modelConfig";
import { providersWithKeys } from "../../generation/providers/registry";
import { secondsToFrame } from "../../util/timeFormatting";
import type { Editor } from "../editor";
import { frameRangeLength, type GapSelection } from "../rippleEngine";
import { placeClip } from "./core";
import { cancelPendingTransitionSeed, seedGenerationPanel, transitionSeedTasks } from "./aiEdit";
import { patchGeneratingClips } from "./generatedClips";

export const maxTransitionSeconds = 15;

/** Seam for `captureFrameToMedia(source: .timeline(frame:))`: renders the timeline frame into a new image asset. */
export const aiTransitionHooks: {
  captureTimelineFrame?: (editor: Editor, frame: number, name: string) => Promise<MediaAsset>;
} = {};

export function transitionGapSeconds(editor: Editor, lengthFrames: number): number {
  return lengthFrames / Math.max(1, editor.timeline.fps);
}

export function aiTransitionAvailability(editor: Editor, gap: GapSelection): { model?: VideoEntry; refusal?: string } {
  const track = editor.timeline.tracks[gap.trackIndex];
  const length = frameRangeLength(gap.range);
  if (!track || !(gap.range.start > 0) || !(length > 0) || track.type !== "video") return {};
  const seconds = transitionGapSeconds(editor, length);
  if (!(seconds <= maxTransitionSeconds)) {
    return { refusal: `Transitions are limited to ${maxTransitionSeconds} seconds. This gap is ${seconds.toFixed(1)} seconds.` };
  }
  if (providersWithKeys().size === 0) return { refusal: "Add an API key in Settings to generate." };
  const model = firstAndLastFrameModel();
  return model ? { model } : { refusal: "No video model supports first and last frames." };
}

export function transitionSeedIsCurrent(editor: Editor, placement: PendingTransitionPlacement): boolean {
  return editor.doc.activeTimelineId === placement.timelineId && transitionGapIsEmpty(editor, placement);
}

function transitionGapIsEmpty(editor: Editor, placement: PendingTransitionPlacement): boolean {
  const track = editor.timeline.tracks[placement.trackIndex];
  if (!track) return false;
  const end = placement.gapStartFrame + placement.gapLengthFrames;
  return !track.clips.some((c) => c.startFrame < end && c.startFrame + c.durationFrames > placement.gapStartFrame);
}

export function beginAITransition(editor: Editor, gap: GapSelection): void {
  const model = aiTransitionAvailability(editor, gap).model;
  if (!model) return;
  const placement: PendingTransitionPlacement = {
    timelineId: editor.timeline.id,
    trackIndex: gap.trackIndex,
    gapStartFrame: gap.range.start,
    gapLengthFrames: frameRangeLength(gap.range),
  };
  const capture = aiTransitionHooks.captureTimelineFrame;
  if (!capture) {
    editor.showToast("Capturing timeline frames is not available yet.", "error");
    return;
  }
  const gapSeconds = transitionGapSeconds(editor, placement.gapLengthFrames);
  cancelPendingTransitionSeed(editor);
  const controller = new AbortController();
  transitionSeedTasks.set(editor, controller);
  void (async () => {
    try {
      const startFrame = placement.gapStartFrame - 1;
      const endFrame = placement.gapStartFrame + placement.gapLengthFrames;
      if (!transitionSeedIsCurrent(editor, placement)) return;
      const first = await capture(editor, startFrame, `Transition start (frame ${startFrame})`);
      if (controller.signal.aborted || !transitionSeedIsCurrent(editor, placement)) return;
      const last = await capture(editor, endFrame, `Transition end (frame ${endFrame})`);
      if (controller.signal.aborted || !transitionSeedIsCurrent(editor, placement)) return;
      const stored = transitionSeed(model, first, last, gapSeconds);
      seedGenerationPanel(editor, first, stored, { transitionPlacement: placement });
    } catch (e) {
      if (!controller.signal.aborted) editor.showToast(e instanceof Error ? e.message : String(e), "error");
    }
  })();
}

/** Places the placeholder in the gap as one "AI Transition" step. */
export function placeGeneratingTransitionClip(editor: Editor, placeholderId: string, placement: PendingTransitionPlacement): string | null {
  const asset = editor.mediaAsset(placeholderId);
  if (!asset || !transitionSeedIsCurrent(editor, placement)) {
    editor.refuseWithToast("The gap is no longer available, so the transition will land in Media instead.");
    return null;
  }
  return editor.perform("AI Transition", () => {
    const ids = placeClip(editor, asset, placement.trackIndex, placement.gapStartFrame, placement.gapLengthFrames, { addLinkedAudio: false });
    return ids[0] ?? null;
  });
}

export function finalizeTransitionClip(editor: Editor, placeholderId: string, asset: MediaAsset): void {
  patchGeneratingClips(editor, placeholderId, (clip, fps) => {
    const realFrames = Math.max(1, secondsToFrame(asset.duration, fps));
    clip.speed = realFrames / Math.max(1, clip.durationFrames);
    clip.trimStartFrame = 0;
    clip.trimEndFrame = 0;
  });
}
