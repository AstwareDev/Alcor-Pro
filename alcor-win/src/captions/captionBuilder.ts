import { clipEndFrame, clipTimelineFrame, type Clip, type TextAnimation, type TextStyle, type Transform, type WordTiming } from "../model";
import { swiftRound } from "../util/math";
import { makeTextClipSpec, type TextClipSpec } from "../editor/mutations/captions";
import type { TranscriptionSegment, TranscriptionWord } from "../transcription/transcription";

// Port of MediaPanel/CaptionsTab/CaptionBuilder.swift: decides how words from CaptionTranscriptMapper are grouped
// into caption-sized chunks, and maps phrases onto timeline frames.

export interface WordSpan {
  text: string;
  start: number;
  end: number;
}

export interface Phrase {
  text: string;
  start: number;
  end: number;
  /** Member words with their own timings (seconds); empty when word timing is unavailable. */
  words: WordSpan[];
}

export function makePhrase(text: string, start: number, end: number, words: WordSpan[] = []): Phrase {
  return { text, start, end, words };
}

export type Fits = (text: string) => boolean;

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

/** Swift `String.count` (grapheme clusters). */
export function characterCount(text: string): number {
  if (!graphemes) return Array.from(text).length;
  let n = 0;
  for (const _ of graphemes.segment(text)) n += 1;
  return n;
}

function graphemeList(text: string): string[] {
  return graphemes ? Array.from(graphemes.segment(text), (s) => s.segment) : Array.from(text);
}

/** `trimmingCharacters(in: .whitespaces)`: spaces and tabs, not newlines. */
export function trimInlineWhitespace(s: string): string {
  return s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((w) => w !== "").length;
}

function alphanumericCount(text: string): number {
  let n = 0;
  for (const g of graphemeList(text)) if (/^[\p{L}\p{N}]/u.test(g)) n += 1;
  return n;
}

/** General builder: split a transcript segment into caption-sized chunks. */
export function phrasesForSegment(
  segment: TranscriptionSegment,
  options: { words?: readonly TranscriptionWord[]; fits: Fits; maxWords?: number | undefined; maxCharacters?: number | undefined },
): Phrase[] {
  const wordCap = options.maxWords === undefined ? undefined : Math.max(1, options.maxWords);
  const characterCap = options.maxCharacters === undefined ? undefined : Math.max(1, options.maxCharacters);
  // Visual, word, and character limits must all accept a phrase.
  const pieces = split(
    segment.text,
    (text) =>
      options.fits(text) &&
      (wordCap === undefined || wordCount(text) <= wordCap) &&
      (characterCap === undefined || characterCount(text) <= characterCap),
  );
  return time(pieces, segment, options.words ?? []);
}

export function phrasesFromTimedWords(
  words: readonly TranscriptionWord[],
  options: { fits: Fits; maxWords?: number | undefined; maxCharacters?: number | undefined },
): Phrase[] {
  const timed = words.filter((w) => w.start !== undefined && w.end !== undefined);
  const first = timed[0];
  const last = timed[timed.length - 1];
  if (!first || !last || first.start === undefined || last.end === undefined || !(last.end > first.start)) return [];
  const text = timed.map((w) => w.text).join(" ").trim();
  if (text === "") return [];
  const segment: TranscriptionSegment = { text, start: first.start, end: last.end };
  if (first.speaker !== undefined) segment.speaker = first.speaker;
  return phrasesForSegment(segment, { words: timed, ...options });
}

function split(text: string, fits: Fits): string[] {
  const t = trimInlineWhitespace(text);
  if (t === "") return [];
  if (fits(t)) return [t];
  const parts = breakOnce(t);
  if (parts.length <= 1) return [t]; // a single over-long word: keep it
  return parts.flatMap((p) => split(p, fits));
}

/** Break once at the best boundary present: sentence, then clause, then midpoint word. */
function breakOnce(text: string): string[] {
  return breakOn(text, ".!?") ?? breakOn(text, ",;:") ?? breakAtMidWord(text);
}

/** Split after delimiters followed by a space, so "U.S." and "3.14" stay intact. */
function breakOn(text: string, delimiters: string): string[] | undefined {
  const set = new Set(Array.from(delimiters));
  const chars = Array.from(text);
  const pieces: string[] = [];
  let current = "";
  chars.forEach((c, i) => {
    current += c;
    const nextIsBreak = i + 1 >= chars.length || chars[i + 1] === " ";
    if (set.has(c) && nextIsBreak) {
      const piece = trimInlineWhitespace(current);
      if (piece !== "") pieces.push(piece);
      current = "";
    }
  });
  const tail = trimInlineWhitespace(current);
  if (tail !== "") pieces.push(tail);
  return pieces.length > 1 ? pieces : undefined;
}

function breakAtMidWord(text: string): string[] {
  const words = text.split(" ").filter((w) => w !== "");
  if (words.length <= 1) return [text];
  const mid = Math.trunc(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/**
 * Time phrases from word runs by matching shared characters, so timing holds when runs don't split on spaces
 * (contractions, split numbers, punctuation runs).
 */
function time(texts: readonly string[], segment: TranscriptionSegment, words: readonly TranscriptionWord[]): Phrase[] {
  const timed: { text: string; count: number; start: number; end: number }[] = [];
  for (const w of words) {
    if (w.start === undefined || w.end === undefined) continue;
    const count = alphanumericCount(w.text);
    if (count > 0) timed.push({ text: w.text, count, start: w.start, end: w.end });
  }
  if (timed.length === 0) return distribute(texts, segment.start, segment.end);

  const phrases: Phrase[] = [];
  let idx = 0;
  for (const text of texts) {
    const want = alphanumericCount(text);
    let got = 0;
    let first: { start: number; end: number } | undefined;
    let last: { start: number; end: number } | undefined;
    const spans: WordSpan[] = [];
    while (idx < timed.length && got < want) {
      const run = timed[idx];
      first ??= { start: run.start, end: run.end };
      last = { start: run.start, end: run.end };
      spans.push({ text: trimInlineWhitespace(run.text), start: run.start, end: run.end });
      got += run.count;
      idx += 1;
    }
    if (!first || !last) break;
    phrases.push(makePhrase(text, first.start, last.end, spans));
  }
  return phrases.length === texts.length ? phrases : distribute(texts, segment.start, segment.end);
}

/** Share the segment's time across pieces by character count, back to back. */
function distribute(texts: readonly string[], start: number, end: number): Phrase[] {
  if (texts.length === 0) return [];
  const total = texts.reduce((acc, t) => acc + Math.max(characterCount(t), 1), 0);
  const span = Math.max(end - start, 0);
  const phrases: Phrase[] = [];
  let t = start;
  for (const text of texts) {
    const dur = (span * Math.max(characterCount(text), 1)) / total;
    phrases.push(makePhrase(text, t, t + dur));
    t += dur;
  }
  return phrases;
}

/** Maps phrases (source seconds) onto the source clip's timeline frames as text-clip specs. */
export function captionSpecs(
  phrases: readonly Phrase[],
  p: {
    sourceClip: Clip;
    trackIndex: number;
    fps: number;
    style: TextStyle;
    captionGroupId: string | undefined;
    animation?: TextAnimation | undefined;
    transformFor?: (text: string) => Transform | undefined;
    minDurationFrames?: number;
  },
): TextClipSpec[] {
  const { sourceClip, fps } = p;
  const minDurationFrames = p.minDurationFrames ?? 1;
  const speed = Math.max(sourceClip.speed, 0.0001);
  const out: TextClipSpec[] = [];
  for (const phrase of phrases) {
    const visibleStartSource = sourceClip.trimStartFrame;
    const visibleEndSource = visibleStartSource + sourceClip.durationFrames * speed;
    const phraseStartSource = phrase.start * fps;
    const phraseEndSource = phrase.end * fps;
    if (!(phraseEndSource > visibleStartSource && phraseStartSource < visibleEndSource)) continue;

    const clampedTimelineFrame = (sourceSeconds: number): number => {
      const sourceFrame = sourceSeconds * fps;
      const offsetFromTrim = sourceFrame - visibleStartSource;
      const frame = swiftRound(sourceClip.startFrame + offsetFromTrim / speed);
      return Math.min(Math.max(frame, sourceClip.startFrame), clipEndFrame(sourceClip));
    };

    const mappedStart = clipTimelineFrame(sourceClip, phrase.start, fps);
    const mappedEnd = clipTimelineFrame(sourceClip, phrase.end, fps);
    const s = mappedStart ?? sourceClip.startFrame;
    const e = mappedEnd ?? clipEndFrame(sourceClip);
    const duration = Math.max(minDurationFrames, Math.min(clipEndFrame(sourceClip), e) - Math.max(sourceClip.startFrame, s));

    // Map word spans to clip-relative frames, clamped to the clip's own span.
    const words: WordTiming[] = [];
    for (const w of phrase.words) {
      const wordStartSource = w.start * fps;
      const wordEndSource = w.end * fps;
      if (!(wordEndSource > visibleStartSource && wordStartSource < visibleEndSource)) continue;
      const ws = clampedTimelineFrame(w.start);
      const we = clampedTimelineFrame(w.end);
      const rs = Math.min(Math.max(0, ws - s), duration);
      const re = Math.min(Math.max(rs, we - s), duration);
      if (re > rs) words.push({ text: w.text, startFrame: rs, endFrame: re });
    }

    out.push(
      makeTextClipSpec({
        trackIndex: p.trackIndex,
        startFrame: s,
        durationFrames: duration,
        content: phrase.text,
        style: p.style,
        transform: p.transformFor?.(phrase.text),
        captionGroupId: p.captionGroupId,
        words: words.length === 0 ? undefined : words,
        animation: p.animation,
      }),
    );
  }
  return out;
}
