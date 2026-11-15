import {
  clipClampFadesToDuration,
  clipClampKeyframesToDuration,
  clipEndFrame,
  clipRescaleKeyframes,
  clipRescaleWordTimings,
  Zoom,
  type Clip,
  type Track,
  keyframeTrackIsActive,
  timelineMarkerRescaleFrames,
  type MediaAsset,
  type Timeline,
  type TimelineViewState,
  type Transform,
} from "../../model";
import { swiftRound } from "../../util/math";
import type { Editor } from "../editor";
import type { TimelineRangeSelection } from "../editor";
import { fitTransform, sourceDimensions } from "./core";

export interface SettingsMismatch {
  clipFPS: number;
  clipWidth: number;
  clipHeight: number;
}

export type ProjectSettingsAction = { kind: "proceed" } | ({ kind: "mismatch" } & SettingsMismatch);

interface FrameSpan {
  start: number;
  end: number;
}

/**
 * Port of `Timeline.rescaleFrames(by:)`; mutates in place. Beyond the Swift: text word timings are rescaled
 * with the clip duration, and linked clips that shared a span keep sharing one after rounding.
 */
export function timelineRescaleFrames(timeline: Timeline, scale: number): void {
  const originalSpans = new Map<string, FrameSpan>();
  for (const marker of timeline.markers) timelineMarkerRescaleFrames(marker, scale);
  for (const track of timeline.tracks) {
    const order = track.clips.map((_, i) => i).sort((a, b) => (track.clips[a]?.startFrame ?? 0) - (track.clips[b]?.startFrame ?? 0));
    let previousEnd: number | undefined;
    for (const ci of order) {
      const clip = track.clips[ci];
      if (!clip) continue;
      const oldDuration = clip.durationFrames;
      originalSpans.set(clip.id, { start: clip.startFrame, end: clipEndFrame(clip) });
      const scaledStart = swiftRound(clip.startFrame * scale);
      const scaledEnd = swiftRound(clipEndFrame(clip) * scale);
      clip.startFrame = Math.max(scaledStart, previousEnd ?? scaledStart);
      clip.durationFrames = Math.max(1, scaledEnd - clip.startFrame);
      clip.trimStartFrame = swiftRound(clip.trimStartFrame * scale);
      clip.trimEndFrame = swiftRound(clip.trimEndFrame * scale);
      clipRescaleKeyframes(clip, scale);
      clip.fadeInFrames = swiftRound(clip.fadeInFrames * scale);
      clip.fadeOutFrames = swiftRound(clip.fadeOutFrames * scale);
      clipRescaleWordTimings(clip, oldDuration);
      clipClampKeyframesToDuration(clip);
      clipClampFadesToDuration(clip);
      previousEnd = clipEndFrame(clip);
    }
  }
  resyncLinkedClips(timeline, originalSpans);
}

/** Per-track overlap clamping can push one half of a linked pair a frame later; realign when the track has room. */
function resyncLinkedClips(timeline: Timeline, original: ReadonlyMap<string, FrameSpan>): void {
  const groups = new Map<string, { clip: Clip; track: Track }[]>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.linkGroupId === undefined) continue;
      const key = `${clip.linkGroupId}|${original.get(clip.id)?.start}|${original.get(clip.id)?.end}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push({ clip, track });
      else groups.set(key, [{ clip, track }]);
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const start = Math.max(...members.map((m) => m.clip.startFrame));
    const end = Math.max(...members.map((m) => clipEndFrame(m.clip)));
    for (const { clip, track } of members) {
      if (clip.startFrame === start && clipEndFrame(clip) === end) continue;
      if (track.clips.some((other) => other !== clip && other.startFrame < end && clipEndFrame(other) > start)) continue;
      clip.startFrame = start;
      clip.durationFrames = end - start;
      clipClampKeyframesToDuration(clip);
      clipClampFadesToDuration(clip);
    }
  }
}

function transformScaleMatches(transform: Transform, other: Transform): boolean {
  return Math.abs(transform.width - other.width) < 0.0001 && Math.abs(transform.height - other.height) < 0.0001;
}

interface ViewSnapshot {
  currentFrame: number;
  range: TimelineRangeSelection | null;
  zoomScale: number;
  views: Record<string, TimelineViewState>;
}

function captureViews(editor: Editor): ViewSnapshot {
  const views: Record<string, TimelineViewState> = {};
  for (const [id, view] of Object.entries(editor.liveViewStates)) views[id] = { ...view };
  const { currentFrame, selectedTimelineRange: range, zoomScale } = editor.ui;
  return { currentFrame, range: range && { ...range }, zoomScale, views };
}

function restoreViews(editor: Editor, snap: ViewSnapshot): void {
  editor.ui.currentFrame = snap.currentFrame;
  editor.ui.selectedTimelineRange = snap.range && { ...snap.range };
  editor.ui.zoomScale = snap.zoomScale;
  for (const [id, view] of Object.entries(snap.views)) editor.liveViewStates[id] = { ...view };
}

/** Keeps the visible duration constant: pixels per frame shrink as frames per second grow. */
function rescaledZoom(zoomScale: number, scale: number): number {
  return Math.min(Zoom.max, Math.max(Zoom.floor, zoomScale / scale));
}

function rescaleViews(editor: Editor, scale: number): void {
  const ui = editor.ui;
  ui.currentFrame = swiftRound(ui.currentFrame * scale);
  ui.zoomScale = rescaledZoom(ui.zoomScale, scale);
  const range = ui.selectedTimelineRange;
  if (range) ui.selectedTimelineRange = { startFrame: swiftRound(range.startFrame * scale), endFrame: swiftRound(range.endFrame * scale) };
  for (const view of Object.values(editor.liveViewStates)) {
    view.playheadFrame = swiftRound(view.playheadFrame * scale);
    view.zoomScale = rescaledZoom(view.zoomScale, scale);
  }
}

/**
 * Port of applyTimelineSettings. Playhead, range selection and per-timeline view state are not part of the
 * undoable document, so they are snapshotted and restored through the undo entry (Swift's snapshot does the same).
 * `sourcePlayheadFrame` has no TS counterpart yet. Invalid frame rates are refused without mutating.
 */
export function applyTimelineSettings(editor: Editor, fps: number, width: number, height: number): void {
  if (!(Number.isInteger(fps) && fps >= 1)) return;
  const prevFPS = editor.timeline.fps;
  const prevWidth = editor.timeline.width;
  const prevHeight = editor.timeline.height;
  const rescale = fps !== prevFPS && prevFPS > 0 && fps > 0;
  const scale = fps / prevFPS;

  // The playback clock is anchored in old-fps frames; stop it before the frame base changes.
  if (rescale) editor.ui.isPlaying = false;
  const viewsBefore = rescale ? captureViews(editor) : undefined;
  const docBefore = editor.store.committed;

  editor.perform("Change Project Settings", () => {
    if (rescale) {
      for (const timeline of editor.timelines) timelineRescaleFrames(timeline, scale);
    }

    if (width !== prevWidth || height !== prevHeight) {
      for (const track of editor.timeline.tracks) {
        for (const clip of track.clips) {
          const dims = sourceDimensions(editor, clip);
          if (!dims || !(prevWidth > 0 && prevHeight > 0 && width > 0 && height > 0)) continue;
          const sourceAspect = dims.width / dims.height;
          const oldAspect = sourceAspect / (prevWidth / prevHeight);
          const newAspect = sourceAspect / (width / height);

          const scaleAnimated = clip.scaleTrack !== undefined && keyframeTrackIsActive(clip.scaleTrack);
          const oldFit = fitTransform(dims.width, dims.height, prevWidth, prevHeight);
          if (!scaleAnimated && transformScaleMatches(clip.transform, oldFit)) {
            const newFit = fitTransform(dims.width, dims.height, width, height);
            clip.transform.width = newFit.width;
            clip.transform.height = newFit.height;
          } else {
            const heightScale = oldAspect / newAspect;
            clip.transform.height *= heightScale;
            if (clip.scaleTrack && keyframeTrackIsActive(clip.scaleTrack)) {
              for (const kf of clip.scaleTrack.keyframes) kf.value.b *= heightScale;
            }
          }
        }
      }
    }

    for (const timeline of editor.timelines) {
      timeline.fps = fps;
      timeline.settingsConfigured = true;
    }
    editor.timeline.width = width;
    editor.timeline.height = height;
  });

  if (viewsBefore) {
    rescaleViews(editor, scale);
    if (editor.store.committed !== docBefore) {
      const viewsAfter = captureViews(editor);
      editor.store.attachToLastEntry(() => restoreViews(editor, viewsBefore), () => restoreViews(editor, viewsAfter));
    }
  }
}

/** Rounded source fps, or undefined when it would round below 1 (unusable as a project rate). */
function usableFPS(sourceFPS: number | undefined): number | undefined {
  if (sourceFPS === undefined || !Number.isFinite(sourceFPS)) return undefined;
  const rounded = swiftRound(sourceFPS);
  return rounded >= 1 ? rounded : undefined;
}

export function checkProjectSettings(editor: Editor, assets: readonly MediaAsset[], adoptFPS = true): ProjectSettingsAction {
  const firstVideo = assets.find((a) => a.type === "video");
  if (!firstVideo) return { kind: "proceed" };

  const timeline = editor.timeline;
  const timelineIsEmpty = timeline.tracks.every((t) => t.clips.length === 0);
  const canAdoptFPS = adoptFPS && editor.timelines.every((t) => t.tracks.every((tr) => tr.clips.length === 0));

  if (!timeline.settingsConfigured) {
    const clipFPS = usableFPS(firstVideo.sourceFPS);
    const fps = canAdoptFPS ? (clipFPS ?? timeline.fps) : timeline.fps;
    applyTimelineSettings(editor, fps, firstVideo.sourceWidth ?? timeline.width, firstVideo.sourceHeight ?? timeline.height);
    return { kind: "proceed" };
  }

  if (!timelineIsEmpty) return { kind: "proceed" };

  const clipFPS = usableFPS(firstVideo.sourceFPS);
  const clipWidth = firstVideo.sourceWidth;
  const clipHeight = firstVideo.sourceHeight;
  const fpsMismatch = canAdoptFPS && clipFPS !== undefined && clipFPS !== timeline.fps;
  const resMismatch =
    (clipWidth !== undefined && clipWidth !== timeline.width) || (clipHeight !== undefined && clipHeight !== timeline.height);
  if (fpsMismatch || resMismatch) {
    return {
      kind: "mismatch",
      clipFPS: canAdoptFPS ? (clipFPS ?? timeline.fps) : timeline.fps,
      clipWidth: clipWidth ?? timeline.width,
      clipHeight: clipHeight ?? timeline.height,
    };
  }
  return { kind: "proceed" };
}

/** Runs `operation` now, or hands the mismatch to `onMismatch` (the UI keeps the continuation). */
export function addClipsWithSettingsCheck(
  editor: Editor,
  assets: readonly MediaAsset[],
  operation: () => void,
  onMismatch: (mismatch: SettingsMismatch, continuation: () => void) => void,
): void {
  const action = checkProjectSettings(editor, assets);
  if (action.kind === "proceed") operation();
  else onMismatch({ clipFPS: action.clipFPS, clipWidth: action.clipWidth, clipHeight: action.clipHeight }, operation);
}

// MARK: - Canvas aspect ratio / quality presets (Project/Settings/ProjectSettingsPresets.swift)

export type AspectRatioErrorCode = "invalidFormat" | "resolutionTooSmall" | "resolutionTooLarge";

export class AspectRatioError extends Error {
  constructor(readonly code: AspectRatioErrorCode) {
    super(
      {
        invalidFormat: "Use an aspect ratio with two positive numbers, such as 3:2.",
        resolutionTooSmall: "Resolution must be at least 2 × 2 pixels.",
        resolutionTooLarge: "Resolution must not exceed 8192 pixels on either edge.",
      }[code],
    );
    this.name = "AspectRatioError";
  }
}

export interface CanvasAspectRatio {
  horizontal: number;
  vertical: number;
}

/** Swift `Double(String)`: no surrounding whitespace, decimal or exponent forms only. */
function swiftDouble(text: string): number | undefined {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return undefined;
  return Number(text);
}

export function parseCanvasAspectRatio(text: string): CanvasAspectRatio {
  const parts = text.split(":");
  if (parts.length !== 2) throw new AspectRatioError("invalidFormat");
  const horizontal = swiftDouble(parts[0].trim());
  const vertical = swiftDouble(parts[1].trim());
  if (
    horizontal === undefined || vertical === undefined || !Number.isFinite(horizontal) || !Number.isFinite(vertical) ||
    !(horizontal > 0) || !(vertical > 0) || !Number.isFinite(horizontal / vertical)
  ) {
    throw new AspectRatioError("invalidFormat");
  }
  return { horizontal, vertical };
}

/** `CanvasAspectRatio.resolution(shortEdge:)` */
export function canvasAspectRatioResolution(r: CanvasAspectRatio, shortEdge: number): { width: number; height: number } {
  if (shortEdge < 2) throw new AspectRatioError("resolutionTooSmall");
  const ratio = r.horizontal / r.vertical;
  const short = shortEdge % 2 === 0 ? shortEdge : shortEdge + 1;
  const longValue = short * Math.max(ratio, 1 / ratio);
  if (longValue > 8_192) throw new AspectRatioError("resolutionTooLarge");
  const long = swiftRound(longValue / 2) * 2;
  return ratio >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/** `CanvasAspectRatio.displayLabel(width:height:)` */
export function canvasAspectDisplayLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "—";
  let a = width;
  let b = height;
  while (b !== 0) [a, b] = [b, a % b];
  const rw = Math.trunc(width / a);
  const rh = Math.trunc(height / a);
  if (Math.max(rw, rh) <= 100) return `${rw}:${rh}`;
  const ratio = width / height;
  return ratio >= 1 ? `${swiftRound(ratio * 100) / 100}:1` : `1:${swiftRound((1 / ratio) * 100) / 100}`;
}

export const qualityPresetShortEdges = { "720p": 720, "1080p": 1080, "2K": 1440, "4K": 2160 } as const;
export type QualityPresetLabel = keyof typeof qualityPresetShortEdges;

/** `QualityPreset.resolution(currentWidth:currentHeight:)` */
export function qualityPresetResolution(
  shortEdge: number,
  currentWidth: number,
  currentHeight: number,
): { width: number; height: number } {
  if (currentWidth <= currentHeight) return { width: shortEdge, height: Math.trunc((shortEdge * currentHeight) / currentWidth) };
  return { width: Math.trunc((shortEdge * currentWidth) / currentHeight), height: shortEdge };
}

/** CapCut-style named canvas presets, resolved through the aspect-ratio maths above. */
export const canvasPresets: readonly { label: string; aspect: string; shortEdge: number }[] = [
  { label: "YouTube 16:9 1080p", aspect: "16:9", shortEdge: 1080 },
  { label: "YouTube 16:9 4K", aspect: "16:9", shortEdge: 2160 },
  { label: "TikTok / Reels / Shorts 9:16", aspect: "9:16", shortEdge: 1080 },
  { label: "Instagram Square 1:1", aspect: "1:1", shortEdge: 1080 },
  { label: "Instagram Portrait 4:5", aspect: "4:5", shortEdge: 1080 },
  { label: "Cinema 2.39:1", aspect: "2.39:1", shortEdge: 1080 },
];

export function canvasPresetResolution(preset: { aspect: string; shortEdge: number }): { width: number; height: number } {
  return canvasAspectRatioResolution(parseCanvasAspectRatio(preset.aspect), preset.shortEdge);
}

export const customFrameRateRange = { min: 1, max: 120 } as const;

/** Integer fps only: `Timeline.fps` is an Int in the project format (no 23.976 / 29.97 / 59.94). */
export function parseCustomFrameRate(text: string): number | undefined {
  if (!/^\s*\d+\s*$/.test(text)) return undefined;
  const value = Number(text);
  return value >= customFrameRateRange.min && value <= customFrameRateRange.max ? value : undefined;
}
