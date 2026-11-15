import type { Clip } from "../model";
import type { SourceRange } from "../transcription/transcriptCache";
import {
  makeTranscriptionSegment, type TranscriptionResult, type TranscriptionSegment, type TranscriptionWord,
} from "../transcription/transcription";
import { phrasesForSegment, phrasesFromTimedWords, type Fits, type Phrase } from "./captionBuilder";

// Port of MediaPanel/CaptionsTab/CaptionTranscriptMapper.swift: which transcript words/segments of a source clip
// fragment should become caption phrases.

/** Visible source span of the clip in source frames. */
export function sourceSpan(clip: Clip): { start: number; end: number } {
  const start = clip.trimStartFrame;
  return { start, end: start + clip.durationFrames * Math.max(clip.speed, 0.0001) };
}

/** Union (in seconds, padded) of every visible span of `mediaRef`'s clips; undefined without usable spans. */
export function sourceUnion(mediaRef: string, clips: readonly Clip[], fps: number, paddingSeconds = 1.0): SourceRange | undefined {
  const spans = clips.filter((c) => c.mediaRef === mediaRef).map(sourceSpan);
  if (!(fps > 0) || spans.length === 0) return undefined;
  const lo = Math.min(...spans.map((s) => s.start));
  const hi = Math.max(...spans.map((s) => s.end));
  if (!(hi > lo)) return undefined;
  return { start: Math.max(lo / fps - paddingSeconds, 0), end: hi / fps + paddingSeconds };
}

export function spokenWordCount(clip: Clip, result: TranscriptionResult, fps: number): number {
  const visible = sourceSpan(clip);
  let count = 0;
  for (const word of result.words) {
    if (word.start === undefined || word.end === undefined) continue;
    const midFrame = ((word.start + word.end) / 2) * fps;
    if (visible.start <= midFrame && midFrame < visible.end) count += 1;
  }
  return count;
}

export function mapperPhrases(
  clip: Clip,
  result: TranscriptionResult,
  p: { fps: number; maxWords: number | undefined; maxCharacters: number | undefined; fits: Fits },
): Phrase[] {
  const hasWordTimings = result.words.some((w) => w.start !== undefined && w.end !== undefined);
  const source = sourceSpan(clip);
  const rate = p.fps;
  if (!(rate > 0)) return [];
  const visibleStart = source.start / rate;
  const visibleEnd = source.end / rate;
  if (!(visibleEnd > visibleStart)) return [];

  if (hasWordTimings) {
    // Prefer word timings so phrase boundaries survive clipped/reordered source fragments.
    return phrasesWithWordTimings(visibleStart, visibleEnd, result, p);
  }
  return result.segments.flatMap((segment) => {
    const clipped = clippedSegment(segment, visibleStart, visibleEnd);
    if (!clipped) return [];
    return phrasesForSegment(clipped, { fits: p.fits, maxWords: p.maxWords, maxCharacters: p.maxCharacters });
  });
}

function phrasesWithWordTimings(
  visibleStart: number,
  visibleEnd: number,
  result: TranscriptionResult,
  p: { maxWords: number | undefined; maxCharacters: number | undefined; fits: Fits },
): Phrase[] {
  const segments = result.segments.length === 0 ? [fallbackSegment(result)] : result.segments;
  const phrases: Phrase[] = [];
  let wordIndex = 0;

  for (const segment of segments) {
    while (wordIndex < result.words.length) {
      const { start, end } = result.words[wordIndex];
      if (start === undefined || end === undefined) {
        wordIndex += 1;
        continue;
      }
      if ((start + end) / 2 < segment.start) {
        wordIndex += 1;
        continue;
      }
      break;
    }

    let i = wordIndex;
    const segmentWords: TranscriptionWord[] = [];
    while (i < result.words.length) {
      const word = result.words[i];
      if (word.start === undefined || word.end === undefined) {
        i += 1;
        continue;
      }
      const mid = (word.start + word.end) / 2;
      if (mid >= segment.end) break;
      if (mid >= segment.start && mid >= visibleStart && mid < visibleEnd) segmentWords.push(word);
      i += 1;
    }

    if (segmentWords.length === 0) continue;
    phrases.push(...phrasesFromTimedWords(segmentWords, p));
  }
  return phrases;
}

function fallbackSegment(result: TranscriptionResult): TranscriptionSegment {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const w of result.words) {
    if (w.start !== undefined && w.end !== undefined) {
      starts.push(w.start);
      ends.push(w.end);
    }
  }
  const start = starts.length === 0 ? 0 : Math.min(...starts);
  const end = ends.length === 0 ? start : Math.max(...ends);
  return makeTranscriptionSegment(result.text, start, end);
}

function clippedSegment(segment: TranscriptionSegment, visibleStart: number, visibleEnd: number): TranscriptionSegment | undefined {
  const start = Math.max(segment.start, visibleStart);
  const end = Math.min(segment.end, visibleEnd);
  if (!(end > start)) return undefined;
  return makeTranscriptionSegment(segment.text, start, end, segment.speaker);
}
