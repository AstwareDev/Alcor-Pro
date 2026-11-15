import {
  makeTransform, textLayoutNaturalSize, type Clip, type TextAnimation, type TextMeasurer, type TextStyle, type Transform,
} from "../model";
import { swiftRound } from "../util/math";
import {
  captionCaseApply, makeTextClipSpec, type CaptionCase, type TextClipSpec,
} from "../editor/mutations/captions";
import type { TranscriptionResult } from "../transcription/transcription";
import { captionSpecs, makePhrase } from "./captionBuilder";
import { captionMaximumGapFrames, makeCaptionGapSettings, type CaptionGapSettings } from "./captionGapSettings";
import { captionPreviewMaxTextWidthRatio } from "./constants";
import { mapperPhrases } from "./captionTranscriptMapper";
import type { SubtitleCue } from "./subtitleFileParser";

// Port of MediaPanel/CaptionsTab/CaptionSpecBuilder.swift.

export interface CaptionSpecTarget {
  clip: Clip;
  result: TranscriptionResult;
}

export interface CaptionSpecInput {
  targets: readonly CaptionSpecTarget[];
  fps: number;
  timelineEndFrame: number;
  canvasWidth: number;
  canvasHeight: number;
  style: TextStyle;
  center: { x: number; y: number };
  textCase: CaptionCase;
  maxWords: number | undefined;
  maxCharacters: number | undefined;
  gapSettings: CaptionGapSettings;
  animation: TextAnimation | undefined;
  /** Platform text measurement (Canvas 2D in the app, a stub in tests). */
  measure: TextMeasurer;
  signal?: AbortSignal;
}

export function buildCaptionSpecs(input: CaptionSpecInput, newGroupId: () => string): TextClipSpec[] {
  input.signal?.throwIfAborted();
  const groupId = newGroupId();
  const specs: TextClipSpec[] = [];

  for (const target of input.targets) {
    input.signal?.throwIfAborted();
    const phrases = mapperPhrases(target.clip, target.result, {
      fps: input.fps,
      maxWords: input.maxWords,
      maxCharacters: input.maxCharacters,
      fits: (text) => {
        if (input.signal?.aborted) return true;
        return lineFits(text, input);
      },
    });
    input.signal?.throwIfAborted();
    if (phrases.length === 0) continue;

    const cased = phrases.map((p) => makePhrase(captionCaseApply(input.textCase, p.text), p.start, p.end, p.words));
    specs.push(
      ...captionSpecs(cased, {
        sourceClip: target.clip,
        trackIndex: 0,
        fps: input.fps,
        style: input.style,
        captionGroupId: groupId,
        animation: input.animation,
        transformFor: (text) => (input.signal?.aborted ? undefined : transformFor(text, input.style, input.center, input.canvasWidth, input.canvasHeight, input.measure)),
      }),
    );
    input.signal?.throwIfAborted();
  }
  return adjustedCaptionTiming(specs, input.gapSettings, input.fps, input.timelineEndFrame);
}

/** Specs for imported subtitle cues. Honors the file's timing: overlaps are resolved but gaps are never closed. */
export function buildSubtitleCueSpecs(
  cues: readonly SubtitleCue[],
  p: {
    fps: number;
    canvasWidth: number;
    canvasHeight: number;
    style: TextStyle;
    center: { x: number; y: number };
    measure: TextMeasurer;
    signal?: AbortSignal;
  },
  newGroupId: () => string,
): TextClipSpec[] {
  const groupId = newGroupId();
  const specs: TextClipSpec[] = [];
  for (const cue of cues) {
    p.signal?.throwIfAborted();
    const startFrame = swiftRound(cue.startSeconds * p.fps);
    const endFrame = swiftRound(cue.endSeconds * p.fps);
    specs.push(
      makeTextClipSpec({
        trackIndex: 0,
        startFrame,
        durationFrames: Math.max(1, endFrame - startFrame),
        content: cue.text,
        style: p.style,
        transform: transformFor(cue.text, p.style, p.center, p.canvasWidth, p.canvasHeight, p.measure),
        captionGroupId: groupId,
      }),
    );
  }
  // Zero-gap settings also make the trailing timeline-end hold a no-op.
  const honorFileTiming = makeCaptionGapSettings(0);
  if (!honorFileTiming) throw new Error("unreachable: zero gap is valid");
  return adjustedCaptionTiming(specs, honorFileTiming, p.fps, 0);
}

interface TimedCaption {
  spec: TextClipSpec;
  readonly originalDurationFrames: number;
}

export function adjustedCaptionTiming(
  specs: readonly TextClipSpec[],
  settings: CaptionGapSettings,
  fps: number,
  timelineEndFrame: number,
): TextClipSpec[] {
  const orderedIndices = specs.map((_, i) => i).sort((a, b) => {
    const l = specs[a].startFrame;
    const r = specs[b].startFrame;
    return l === r ? a - b : l - r;
  });
  const captions: TimedCaption[] = orderedIndices.map((i) => ({ spec: specs[i], originalDurationFrames: specs[i].durationFrames }));
  const maximumGapFrames = captionMaximumGapFrames(settings, fps);

  // Resolve collisions before extending captions across eligible gaps.
  for (let nextIndex = 1; nextIndex < captions.length; nextIndex++) {
    const previousIndex = nextIndex - 1;
    const previous = captions[previousIndex];
    const next = captions[nextIndex];
    resolveOverlap(previous, next);

    if (maximumGapFrames > 0) {
      const previousEnd = endFrameOf(previous.spec);
      const gap = positiveDistance(previousEnd, next.spec.startFrame);
      const duration = positiveDistance(previous.spec.startFrame, next.spec.startFrame);
      if (gap !== undefined && gap <= maximumGapFrames && duration !== undefined) {
        previous.spec = resized(previous.spec, duration);
      }
    }
  }

  if (maximumGapFrames > 0 && captions.length > 0) {
    const last = captions[captions.length - 1];
    const available = timelineEndFrame - endFrameOf(last.spec);
    const holdFrames = Math.min(maximumGapFrames, Math.max(0, available));
    if (holdFrames > 0) last.spec = resized(last.spec, last.spec.durationFrames + holdFrames);
  }
  return captions.map((c) => c.spec);
}

function resolveOverlap(previous: TimedCaption, next: TimedCaption): void {
  const previousEnd = endFrameOf(previous.spec);
  if (!(next.spec.startFrame < previousEnd)) return;

  if (next.spec.startFrame <= previous.spec.startFrame) {
    // Preserve transcript order when starts quantize to the same frame.
    previous.spec = resized(previous.spec, 1);
    next.spec = shiftStartPreservingEnd(next.spec, endFrameOf(previous.spec));
    return;
  }

  const overlap = positiveDistance(next.spec.startFrame, previousEnd);
  if (overlap === 1 && previous.originalDurationFrames < next.originalDurationFrames) {
    // The shorter caption owns a one-frame rounding collision.
    next.spec = shiftStartPreservingEnd(next.spec, previousEnd);
    return;
  }

  // Wider overlaps end at the next caption's authoritative start.
  const duration = positiveDistance(previous.spec.startFrame, next.spec.startFrame);
  if (duration !== undefined) previous.spec = resized(previous.spec, duration);
}

function endFrameOf(spec: TextClipSpec): number {
  return spec.startFrame + spec.durationFrames;
}

/** `end - start` when positive. */
function positiveDistance(start: number, end: number): number | undefined {
  const d = end - start;
  return d > 0 ? d : undefined;
}

function shiftStartPreservingEnd(spec: TextClipSpec, startFrame: number): TextClipSpec {
  const wordOffsetFrames = positiveDistance(spec.startFrame, startFrame) ?? 0;
  const originalEnd = endFrameOf(spec);
  const moved: TextClipSpec = { ...spec, startFrame };
  const durationFrames = positiveDistance(startFrame, originalEnd) ?? 1;
  return resized(moved, durationFrames, wordOffsetFrames);
}

function resized(spec: TextClipSpec, durationFrames: number, wordOffsetFrames = 0): TextClipSpec {
  const out: TextClipSpec = { ...spec, durationFrames };
  if (!spec.words) return out;
  const words = spec.words.flatMap((word) => {
    const start = Math.min(Math.max(0, word.startFrame - wordOffsetFrames), durationFrames);
    const end = Math.min(Math.max(start, word.endFrame - wordOffsetFrames), durationFrames);
    return end > start ? [{ text: word.text, startFrame: start, endFrame: end }] : [];
  });
  out.words = words.length === 0 ? undefined : words;
  return out;
}

function lineFits(text: string, input: Pick<CaptionSpecInput, "style" | "canvasWidth" | "canvasHeight" | "measure">): boolean {
  const size = textLayoutNaturalSize(text, input.style, Number.POSITIVE_INFINITY, input.canvasHeight, input.measure);
  return size.width <= input.canvasWidth * captionPreviewMaxTextWidthRatio;
}

function transformFor(
  text: string,
  style: TextStyle,
  center: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number,
  measure: TextMeasurer,
): Transform {
  const natural = textLayoutNaturalSize(text, style, canvasWidth * captionPreviewMaxTextWidthRatio, canvasHeight, measure);
  return makeTransform({
    centerX: center.x,
    centerY: center.y,
    width: natural.width / canvasWidth,
    height: natural.height / canvasHeight,
  });
}
