import {
  Defaults,
  deepEqual,
  clipCropAt,
  cropAspectLockAspectRatio,
  cropAspectRatioFromPixelAspect,
  cropAspectRatioFromPixels,
  cropIsIdentity,
  cropVisibleHeightFraction,
  cropVisibleWidthFraction,
  makeClip,
  makeCrop,
  makeTransform,
  mediaAssetIsGenerating,
  timelineReachableTimelines,
  timelineTotalFrames,
  type Clip,
  type Crop,
  type CropAspectRatio,
  type MediaAsset,
  type Timeline,
  type Transform,
} from "../../model";
export { deepEqual };
import { newId } from "../../util/id";
import { swiftRound } from "../../util/math";
import { snapshot } from "../../util/snapshot";
import { secondsToFrame } from "../../util/timeFormatting";
import type { Editor } from "../editor";
import { editorHooks } from "./hooks";
import { resolveOrCreateAudioTrack } from "./linking";

// MARK: - Value semantics helpers

/** Detached deep copy of a clip (Swift `var copy = clip`). Safe on drafts and frozen values. */
export function copyClip(clip: Clip): Clip {
  return structuredClone(snapshot(clip));
}

/** Removes every element matching `pred` in place; leaves the array untouched (no Immer change) when none match. */
export function removeWhere<T>(arr: T[], pred: (item: T) => boolean): number {
  let removed = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i] as T)) {
      arr.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

// MARK: - Per-editor transient state

const pendingReplacementsByEditor = new WeakMap<Editor, Set<string>>();

/** Clip ids awaiting an AI-generated replacement (transient, not in `EditorUIState`). */
export function pendingReplacements(editor: Editor): Set<string> {
  let set = pendingReplacementsByEditor.get(editor);
  if (!set) {
    set = new Set();
    pendingReplacementsByEditor.set(editor, set);
  }
  return set;
}

// MARK: - Timeline swap (registerTimelineSwap)

/** Replaces the active timeline's contents with `value` (a detached value). */
function replaceActiveTimeline(editor: Editor, value: Timeline): void {
  editor.doc.timelines[editor.activeTimelineIndex] = value;
}

/**
 * Port of registerTimelineSwap(undoState:redoState:): live edits already changed the timeline without an undo
 * entry; this records one undo step from `before` to the current timeline. No-op when nothing differs.
 */
export function commitTimelineSwap(editor: Editor, before: Timeline, actionName: string): boolean {
  const after = snapshot(editor.timeline);
  if (deepEqual(before, after)) return false;
  const restored = structuredClone(snapshot(before));
  const finalState = structuredClone(after);
  editor.withoutRegistration(() => replaceActiveTimeline(editor, restored));
  editor.perform(actionName, () => replaceActiveTimeline(editor, finalState));
  return true;
}

// MARK: - Playhead

export function seekToFrame(editor: Editor, frame: number): void {
  editor.ui.currentFrame = Math.min(Math.max(0, frame), Math.max(0, timelineTotalFrames(editor.timeline)));
}

export function stepForward(editor: Editor): void {
  seekToFrame(editor, editor.ui.currentFrame + 1);
}

export function stepBackward(editor: Editor): void {
  seekToFrame(editor, editor.ui.currentFrame - 1);
}

export function skipForward(editor: Editor, frames = 5): void {
  seekToFrame(editor, editor.ui.currentFrame + frames);
}

export function skipBackward(editor: Editor, frames = 5): void {
  seekToFrame(editor, editor.ui.currentFrame - frames);
}

// MARK: - Lookups

export function timelineFor(editor: Editor, id: string): Timeline | undefined {
  return editor.timelines.find((t) => t.id === id);
}

/** Port of wouldCreateNestCycle(nesting:into:). */
export function wouldCreateNestCycle(editor: Editor, childId: string, hostId: string): boolean {
  if (childId === hostId) return true;
  const child = timelineFor(editor, childId);
  if (!child) return false;
  return timelineReachableTimelines(child, (id) => timelineFor(editor, id)).some((t) => t.id === hostId);
}

/** Port of clipDisplayLabel(for:); `mediaResolver.displayName` is the manifest entry name. */
export function clipDisplayLabel(editor: Editor, clip: Clip): string {
  if (clip.mediaType === "text") {
    const content = clip.textContent ?? "";
    if (clip.adjustment === true) return "Adjustment Layer";
    if (content === "") return "Text";
    return content.replace(/\n/g, " ").replace(/\r/g, " ");
  }
  const asset = editor.mediaAsset(clip.mediaRef);
  if (asset && mediaAssetIsGenerating(asset)) return asset.name;
  if (clip.sourceClipType === "sequence") {
    const nested = timelineFor(editor, clip.mediaRef);
    if (nested) return nested.name;
  }
  return editor.doc.mediaManifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? "Offline";
}

// MARK: - Fit / crop math

/** `fitTransform(sourceWidth:sourceHeight:canvasWidth:canvasHeight:)` */
export function fitTransform(sourceWidth: number, sourceHeight: number, canvasWidth: number, canvasHeight: number): Transform {
  if (!(sourceWidth > 0 && sourceHeight > 0 && canvasWidth > 0 && canvasHeight > 0)) return makeTransform();
  const canvasAspect = canvasWidth / canvasHeight;
  const relativeAspect = sourceWidth / sourceHeight / canvasAspect;
  const sourceAspect = relativeAspect * canvasAspect;
  if (Math.abs(canvasAspect - sourceAspect) < Defaults.aspectTolerance) return makeTransform();
  if (relativeAspect > 1) return makeTransform({ width: 1.0, height: 1.0 / relativeAspect });
  return makeTransform({ width: relativeAspect, height: 1.0 });
}

/** `fitTransform(sourceWidth:sourceHeight:)` against the active timeline canvas. */
export function fitTransformForSourceSize(editor: Editor, sourceWidth: number, sourceHeight: number): Transform {
  return fitTransform(sourceWidth, sourceHeight, editor.timeline.width, editor.timeline.height);
}

/** `fitTransform(for: asset, canvasWidth:canvasHeight:)`; defaults to the active timeline canvas. */
export function fitTransformForAsset(editor: Editor, asset: MediaAsset, canvasWidth?: number, canvasHeight?: number): Transform {
  if (asset.sourceWidth === undefined || asset.sourceHeight === undefined) return makeTransform();
  return fitTransform(
    asset.sourceWidth,
    asset.sourceHeight,
    canvasWidth ?? editor.timeline.width,
    canvasHeight ?? editor.timeline.height,
  );
}

/** `fitTransform(for: clip)` */
export function fitTransformForClip(editor: Editor, clip: Clip): Transform {
  const dims = sourceDimensions(editor, clip);
  if (!dims) return makeTransform();
  return fitTransformForSourceSize(editor, dims.width, dims.height);
}

/** `mediaCanvasAspect(for: asset, canvasWidth:canvasHeight:)` */
export function mediaCanvasAspectForAsset(asset: MediaAsset, canvasWidth: number, canvasHeight: number): number | undefined {
  const sw = asset.sourceWidth;
  const sh = asset.sourceHeight;
  if (sw === undefined || sh === undefined || !(sw > 0 && sh > 0 && canvasWidth > 0 && canvasHeight > 0)) return undefined;
  const canvasAspect = canvasWidth / canvasHeight;
  return sw / sh / canvasAspect;
}

/** Source pixel dimensions for a clip: asset dims, or the child timeline's for nest carriers. */
export function sourceDimensions(editor: Editor, clip: Clip): { width: number; height: number } | undefined {
  const asset = editor.mediaAssets.find((a) => a.id === clip.mediaRef);
  if (asset && asset.sourceWidth !== undefined && asset.sourceHeight !== undefined && asset.sourceWidth > 0 && asset.sourceHeight > 0) {
    return { width: asset.sourceWidth, height: asset.sourceHeight };
  }
  if (clip.sourceClipType === "sequence") {
    const child = timelineFor(editor, clip.mediaRef);
    if (child && child.width > 0 && child.height > 0) return { width: child.width, height: child.height };
  }
  return undefined;
}

/** `mediaCanvasAspect(for: clip)`: source aspect relative to canvas; undefined when source dimensions are unknown. */
export function mediaCanvasAspectForClip(editor: Editor, clip: Clip): number | undefined {
  const dims = sourceDimensions(editor, clip);
  const { width, height } = editor.timeline;
  if (!dims || !(width > 0) || !(height > 0)) return undefined;
  const canvasAspect = width / height;
  return dims.width / dims.height / canvasAspect;
}

export function cropFittingAspect(
  editor: Editor,
  clip: Clip,
  targetPixelAspect: number,
  anchorX = 0.5,
  anchorY = 0.5,
): Crop {
  const dims = sourceDimensions(editor, clip);
  if (!dims || !(targetPixelAspect > 0)) return makeCrop();
  const sourceAspect = dims.width / dims.height;
  if (Math.abs(sourceAspect - targetPixelAspect) < 0.0001) return makeCrop();
  const ax = Math.min(1, Math.max(0, anchorX));
  const ay = Math.min(1, Math.max(0, anchorY));
  if (sourceAspect > targetPixelAspect) {
    const total = 1 - targetPixelAspect / sourceAspect;
    const left = total * ax;
    return makeCrop({ left, top: 0, right: total - left, bottom: 0 });
  }
  const total = 1 - sourceAspect / targetPixelAspect;
  const top = total * ay;
  return makeCrop({ left: 0, top, right: 0, bottom: total - top });
}

export function displayedCropAspectRatio(editor: Editor, clip: Clip, preferLockedRatio = true): CropAspectRatio | undefined {
  if (preferLockedRatio) {
    const ratio = cropAspectLockAspectRatio(editor.ui.cropAspectLock);
    if (ratio) return ratio;
  }
  const dimensions = sourceDimensions(editor, clip);
  if (!dimensions) return undefined;
  const crop = clipCropAt(clip, editor.ui.currentFrame);
  if (cropIsIdentity(crop)) return cropAspectRatioFromPixels(dimensions.width, dimensions.height);
  const visibleW = cropVisibleWidthFraction(crop);
  const visibleH = cropVisibleHeightFraction(crop);
  if (!(visibleW > 0 && visibleH > 0)) return undefined;
  const sourceAspect = dimensions.width / dimensions.height;
  return cropAspectRatioFromPixelAspect((sourceAspect * visibleW) / visibleH);
}

// MARK: - Clip creation

/** `ClosedRange<Double>` of source seconds. */
export interface SourceSegment {
  lowerBound: number;
  upperBound: number;
}

export function clipDurationFrames(editor: Editor, asset: MediaAsset, segment: SourceSegment | undefined): number {
  const seconds = segment ? segment.upperBound - segment.lowerBound : asset.duration;
  return Math.max(1, secondsToFrame(seconds, editor.timeline.fps));
}

export interface PlaceClipOptions {
  addLinkedAudio?: boolean;
  linkedAudioTrackIndex?: number;
  sourceSegment?: SourceSegment;
  trimStartFrame?: number;
  trimEndFrame?: number;
}

/** Places one clip, optionally with linked audio. Returns the created clip ids. */
export function placeClip(
  editor: Editor,
  asset: MediaAsset,
  trackIndex: number,
  startFrame: number,
  durationFrames: number,
  options: PlaceClipOptions = {},
): string[] {
  const { addLinkedAudio = true, linkedAudioTrackIndex, sourceSegment, trimStartFrame, trimEndFrame } = options;
  return editor.perform("Place Clip", () => {
    const timeline = editor.timeline;
    if (!(trackIndex >= 0 && trackIndex < timeline.tracks.length)) return [];
    editorHooks.prepareMediaVisuals?.(editor, asset);
    const targetIsVideo = timeline.tracks[trackIndex].type === "video";
    const shouldLink = addLinkedAudio && targetIsVideo && asset.hasAudio && (asset.type === "video" || asset.type === "sequence");
    const linkGroupId = shouldLink ? newId() : undefined;
    const fps = timeline.fps;
    const trimStart = sourceSegment ? secondsToFrame(sourceSegment.lowerBound, fps) : 0;
    const totalSourceFrames = secondsToFrame(asset.duration, fps);

    // sourceSegment (source seconds) and explicit trim frames are mutually exclusive; callers pass one.
    const applyTrim = (clip: Clip): void => {
      if (sourceSegment) {
        const consumed = swiftRound(durationFrames * clip.speed);
        clip.trimStartFrame = trimStart;
        clip.trimEndFrame = Math.max(0, totalSourceFrames - trimStart - consumed);
      } else {
        const start = Math.max(0, trimStartFrame ?? 0);
        clip.trimStartFrame = start;
        if (totalSourceFrames > 0) {
          const consumed = swiftRound(durationFrames * clip.speed);
          const remainingTail = Math.max(0, totalSourceFrames - start - consumed);
          clip.trimEndFrame = Math.min(trimEndFrame ?? remainingTail, remainingTail);
        } else if (trimEndFrame !== undefined) {
          clip.trimEndFrame = trimEndFrame;
        }
      }
    };

    const clip = makeClip({
      mediaRef: asset.id,
      mediaType: asset.type,
      sourceClipType: asset.type,
      startFrame,
      durationFrames,
      transform: fitTransformForAsset(editor, asset),
    });
    if (linkGroupId !== undefined) clip.linkGroupId = linkGroupId;
    applyTrim(clip);
    const ids = [clip.id];
    timeline.tracks[trackIndex].clips.push(clip);
    editor.sortClips(trackIndex);

    if (linkGroupId !== undefined) {
      const requested = linkedAudioTrackIndex;
      const audioTrackIdx =
        requested !== undefined && requested >= 0 && requested < editor.timeline.tracks.length
          ? requested
          : resolveOrCreateAudioTrack(editor, startFrame, durationFrames);
      if (!(audioTrackIdx >= 0 && audioTrackIdx < editor.timeline.tracks.length)) return ids;
      const audioClip = makeClip({
        mediaRef: asset.id,
        mediaType: "audio",
        sourceClipType: asset.type,
        startFrame,
        durationFrames,
      });
      audioClip.linkGroupId = linkGroupId;
      applyTrim(audioClip);
      ids.push(audioClip.id);
      editor.timeline.tracks[audioTrackIdx].clips.push(audioClip);
      editor.sortClips(audioTrackIdx);
    }
    return ids;
  });
}

/** Creates clips sequentially; callers clear the target range first. */
export function createClips(
  editor: Editor,
  assets: readonly MediaAsset[],
  trackIndex: number,
  startFrame: number,
  options: { addLinkedAudio?: boolean; linkedAudioTrackIndex?: number; segments?: Record<string, SourceSegment> } = {},
): string[] {
  const { addLinkedAudio = true, linkedAudioTrackIndex, segments = {} } = options;
  return editor.perform("Add Clips", () => {
    let cursor = startFrame;
    const clipIds: string[] = [];
    for (const asset of assets) {
      const segment = segments[asset.id];
      const durationFrames = clipDurationFrames(editor, asset, segment);
      clipIds.push(
        ...placeClip(editor, asset, trackIndex, cursor, durationFrames, {
          addLinkedAudio,
          linkedAudioTrackIndex,
          sourceSegment: segment,
        }),
      );
      cursor += durationFrames;
    }
    return clipIds;
  });
}

/** Removes every clip with `id` from every track and clears its pending-replacement flag. */
export function removeClipInternal(editor: Editor, id: string): void {
  editor.perform("Remove Clip", () => {
    for (const track of editor.timeline.tracks) removeWhere(track.clips, (c) => c.id === id);
  });
  pendingReplacements(editor).delete(id);
}

/** Port of nestBlockReason(childId:): why timeline `childId` can't be nested into the active timeline, if it can't. */
export function nestBlockReason(editor: Editor, childId: string): string | null {
  const child = timelineFor(editor, childId);
  if (!child) return null;
  if (timelineTotalFrames(child) === 0) return `"${child.name}" is empty. Add clips before nesting it.`;
  if (wouldCreateNestCycle(editor, childId, editor.doc.activeTimelineId)) return `Can't nest "${child.name}" — it would contain itself.`;
  return null;
}
