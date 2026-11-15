// Transient per-editor generation state (Swift `EditorViewModel.pendingEdit*`, `pendingPanelSeed`) plus live job progress.
import { createSignal } from "solid-js";
import type { GenerationInput, MediaAsset } from "../model";
import type { Editor } from "../editor/editor";
import { shallowMutable } from "../util/shallowMutable";
import type { TrimmedSource } from "./trimmedSource";

export interface PendingAudioPlacement {
  startFrame: number;
  spanSeconds: number;
  actionName: string;
}

export interface PendingTransitionPlacement {
  timelineId: string;
  trackIndex: number;
  gapStartFrame: number;
  gapLengthFrames: number;
}

export interface PendingPanelSeed {
  asset: MediaAsset;
  stored: GenerationInput;
}

export interface PendingGenerationState {
  panelSeed: PendingPanelSeed | null;
  replacementClipId: string | null;
  trimmedSource: TrimmedSource | null;
  audioPlacement: PendingAudioPlacement | null;
  transitionPlacement: PendingTransitionPlacement | null;
}

const states = new WeakMap<Editor, PendingGenerationState>();

/** Reactive fields; assign a new value to change one. */
export function pendingGeneration(editor: Editor): PendingGenerationState {
  let s = states.get(editor);
  if (!s) {
    s = shallowMutable<PendingGenerationState>({
      panelSeed: null, replacementClipId: null, trimmedSource: null, audioPlacement: null, transitionPlacement: null,
    });
    states.set(editor, s);
  }
  return s;
}

/** Wired by the app: `onProjectCheckpointRequired` (save right after a job id is persisted). */
export const generationHooks: {
  checkpointRequired?: (editor: Editor) => void;
  /** Notification when a generation finished ("AppNotifications.generationComplete"). */
  generationComplete?: (editor: Editor, asset: MediaAsset, count: number) => void;
} = {};

// MARK: - Progress

const [progressMap, setProgressMap] = createSignal<ReadonlyMap<string, number>>(new Map());

/** Reactive provider-reported progress 0...1 of a generating asset; undefined when unknown. */
export function generationProgress(assetId: string): number | undefined {
  return progressMap().get(assetId);
}

export function setGenerationProgress(assetId: string, progress: number | undefined): void {
  const current = progressMap();
  if (current.get(assetId) === progress) return;
  const next = new Map(current);
  if (progress === undefined) next.delete(assetId);
  else next.set(assetId, Math.min(1, Math.max(0, progress)));
  setProgressMap(next);
}
