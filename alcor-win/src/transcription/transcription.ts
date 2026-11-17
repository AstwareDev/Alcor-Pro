import { asObject, getArray, getDouble, getString, optDouble, optString, tryString } from "../util/jsonDecode";
import type { Transcript } from "../generation/providers/transcription";

// Port of Transcription/Transcription.swift (the data types and pure helpers). Apple Speech is not ported; on-device
// transcription is Whisper (`localTranscription.ts`).

export interface TranscriptionWord {
  text: string;
  start?: number;
  end?: number;
  speaker?: string;
}

export interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  words: TranscriptionWord[];
  segments: TranscriptionSegment[];
}

export function makeTranscriptionWord(text: string, start?: number, end?: number, speaker?: string): TranscriptionWord {
  const w: TranscriptionWord = { text };
  if (start !== undefined) w.start = start;
  if (end !== undefined) w.end = end;
  if (speaker !== undefined) w.speaker = speaker;
  return w;
}

export function makeTranscriptionSegment(text: string, start: number, end: number, speaker?: string): TranscriptionSegment {
  const s: TranscriptionSegment = { text, start, end };
  if (speaker !== undefined) s.speaker = speaker;
  return s;
}

export function makeTranscriptionResult(p: {
  text: string;
  language?: string;
  words: TranscriptionWord[];
  segments: TranscriptionSegment[];
}): TranscriptionResult {
  const r: TranscriptionResult = { text: p.text, words: p.words, segments: p.segments };
  if (p.language !== undefined) r.language = p.language;
  return r;
}

/** Shifts all timestamps back into source time after transcribing an extracted range. */
export function transcriptionOffsetting(r: TranscriptionResult, offset: number): TranscriptionResult {
  if (offset === 0) return r;
  return makeTranscriptionResult({
    text: r.text,
    ...(r.language !== undefined ? { language: r.language } : {}),
    words: r.words.map((w) =>
      makeTranscriptionWord(
        w.text,
        w.start === undefined ? undefined : w.start + offset,
        w.end === undefined ? undefined : w.end + offset,
        w.speaker,
      ),
    ),
    segments: r.segments.map((s) => makeTranscriptionSegment(s.text, s.start + offset, s.end + offset, s.speaker)),
  });
}

export type TranscriptionErrorKind = "decodeFailed" | "audioExtractionFailed" | "analysisFailed" | "noBackend";

export class TranscriptionError extends Error {
  readonly kind: TranscriptionErrorKind;
  constructor(kind: TranscriptionErrorKind, detail = "") {
    super(transcriptionErrorMessage(kind, detail));
    this.name = "TranscriptionError";
    this.kind = kind;
  }
}

function transcriptionErrorMessage(kind: TranscriptionErrorKind, detail: string): string {
  switch (kind) {
    case "decodeFailed": return "Could not parse transcription result.";
    case "audioExtractionFailed": return `Audio extraction failed: ${detail}`;
    case "analysisFailed": return `Transcription failed: ${detail}`;
    case "noBackend": return "Add an ElevenLabs or OpenAI API key to transcribe audio.";
  }
}

// MARK: - Codable

function decodeWord(json: unknown): TranscriptionWord {
  const c = asObject(json, "TranscriptionWord");
  return makeTranscriptionWord(getString(c, "text"), optDouble(c, "start"), optDouble(c, "end"), optString(c, "speaker"));
}

function decodeSegment(json: unknown): TranscriptionSegment {
  const c = asObject(json, "TranscriptionSegment");
  return makeTranscriptionSegment(getString(c, "text"), getDouble(c, "start"), getDouble(c, "end"), optString(c, "speaker"));
}

/** Synthesized Codable: `language` and the per-word/segment `speaker` are optional, everything else required. */
export function decodeTranscriptionResult(json: unknown): TranscriptionResult {
  const c = asObject(json, "TranscriptionResult");
  const language = tryString(c, "language");
  return makeTranscriptionResult({
    text: getString(c, "text"),
    ...(language !== undefined ? { language } : {}),
    words: getArray(c, "words", decodeWord),
    segments: getArray(c, "segments", decodeSegment),
  });
}

// MARK: - Provider adaptation

/** Longest silence inside one synthesized segment. */
export const segmentGapSeconds = 0.8;
/** Hard cap so unpunctuated transcripts (Whisper words carry no punctuation) still split. */
export const segmentMaxWords = 24;

const sentenceEnd = /[.!?…]["')\]]*$/u;

/** Providers return words only; segments are rebuilt at sentence ends, long pauses and speaker changes. */
export function segmentsFromWords(words: readonly TranscriptionWord[]): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  let run: TranscriptionWord[] = [];
  const flush = (): void => {
    const timed = run.filter((w) => w.start !== undefined && w.end !== undefined);
    const first = timed[0];
    const last = timed[timed.length - 1];
    const text = run.map((w) => w.text.trim()).join(" ").trim();
    if (first?.start !== undefined && last?.end !== undefined && text !== "") {
      segments.push(makeTranscriptionSegment(text, first.start, last.end, first.speaker));
    }
    run = [];
  };
  for (const word of words) {
    const prev = run[run.length - 1];
    if (prev !== undefined) {
      const gap = word.start !== undefined && prev.end !== undefined ? word.start - prev.end : 0;
      if (gap >= segmentGapSeconds || word.speaker !== prev.speaker || run.length >= segmentMaxWords) flush();
    }
    run.push(word);
    if (sentenceEnd.test(word.text.trim())) flush();
  }
  flush();
  return segments;
}

/** Adapts a provider `Transcript` to the Swift `TranscriptionResult` shape. */
export function transcriptionResultFromProvider(t: Transcript): TranscriptionResult {
  const words = t.words
    .map((w) => makeTranscriptionWord(w.text.trim(), w.start, w.end, w.speakerId))
    .filter((w) => w.text !== "");
  return makeTranscriptionResult({
    text: t.text.trim(),
    ...(t.language !== undefined ? { language: t.language } : {}),
    words,
    segments: segmentsFromWords(words),
  });
}

/**
 * Stitches per-chunk results (already shifted into source time) into one. Chunks are cut at fixed boundaries,
 * so a word straddling a boundary may appear in both: it is kept once, in the chunk where it starts.
 */
export function stitchTranscriptionResults(
  parts: readonly { result: TranscriptionResult; start: number; end: number }[],
): TranscriptionResult {
  const words: TranscriptionWord[] = [];
  let language: string | undefined;
  parts.forEach((part, i) => {
    language ??= part.result.language;
    const isLast = i === parts.length - 1;
    for (const w of part.result.words) {
      const start = w.start ?? part.start;
      if (start < part.start && i > 0) continue;
      if (start >= part.end && !isLast) continue;
      words.push(w);
    }
  });
  const text = parts.map((p) => p.result.text.trim()).filter((t) => t !== "").join(" ");
  return makeTranscriptionResult({
    text,
    ...(language !== undefined ? { language } : {}),
    words,
    segments: segmentsFromWords(words),
  });
}
