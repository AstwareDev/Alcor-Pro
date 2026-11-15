import { mediaIo } from "../media/io";
import { pathExtension } from "../media/paths";

// Port of MediaPanel/CaptionsTab/SubtitleFileParser.swift: SRT and WebVTT into plain-text cues.

/** A subtitle cue timed in timeline seconds, with markup already stripped. */
export interface SubtitleCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export type SubtitleFormat = "srt" | "webVTT";

export function subtitleFormatFromExtension(fileExtension: string): SubtitleFormat | undefined {
  switch (fileExtension.toLowerCase()) {
    case "srt": return "srt";
    case "vtt": return "webVTT";
    default: return undefined;
  }
}

export const subtitleFileExtensions: readonly string[] = ["srt", "vtt"];

export type SubtitleParseErrorKind = "unsupportedFileType" | "missingWebVTTHeader" | "malformedCue" | "noCues";

export class SubtitleParseError extends Error {
  readonly kind: SubtitleParseErrorKind;
  /** `malformedCue`: 1-based line. `unsupportedFileType`: unused. */
  readonly line: number | undefined;
  readonly ext: string | undefined;
  constructor(kind: SubtitleParseErrorKind, detail: { line?: number; ext?: string } = {}) {
    super(subtitleErrorMessage(kind, detail));
    this.name = "SubtitleParseError";
    this.kind = kind;
    this.line = detail.line;
    this.ext = detail.ext;
  }
}

function subtitleErrorMessage(kind: SubtitleParseErrorKind, d: { line?: number; ext?: string }): string {
  switch (kind) {
    case "unsupportedFileType": return `Unsupported subtitle file type “.${d.ext ?? ""}”. Use SRT or WebVTT.`;
    case "missingWebVTTHeader": return "Not a WebVTT file — the WEBVTT header is missing.";
    case "malformedCue": return `Malformed cue timing at line ${d.line ?? 0}.`;
    case "noCues": return "The file contains no captions.";
  }
}

/** Decodes bytes as UTF-8, falling back to Latin-1 (which decodes any byte sequence). */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export async function parseSubtitleFile(path: string): Promise<SubtitleCue[]> {
  const format = subtitleFormatFromExtension(pathExtension(path));
  if (!format) throw new SubtitleParseError("unsupportedFileType", { ext: pathExtension(path) });
  return parseSubtitles(decodeSubtitleBytes(await (await mediaIo()).readAll(path)), format);
}

/** `MediaHooks.parseSubtitleDuration`: the latest cue end, or undefined when the file can't be parsed. */
export async function parseSubtitleDuration(path: string): Promise<number | undefined> {
  try {
    const cues = await parseSubtitleFile(path);
    return Math.max(...cues.map((c) => c.endSeconds));
  } catch {
    return undefined;
  }
}

const inlineTrim = (s: string): string => s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");

function isKeywordLine(line: string, keyword: string): boolean {
  return line === keyword || line.startsWith(`${keyword} `) || line.startsWith(`${keyword}\t`);
}

const timestamp = /^(?:(\d{1,4}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})(?=\s|$)/u;

/**
 * `HH:MM:SS.mmm` and `MM:SS.mmm` with `.` or `,` milliseconds. Trailing WebVTT cue settings and SRT coordinate
 * extensions are ignored.
 */
function seconds(token: string): number | undefined {
  const m = timestamp.exec(inlineTrim(token));
  if (!m) return undefined;
  const hours = m[1] === undefined ? 0 : Number.parseInt(m[1], 10);
  const minutes = Number.parseInt(m[2], 10);
  const secs = Number.parseInt(m[3], 10);
  const fraction = Number.parseInt(m[4], 10);
  const milliseconds = fraction * [100, 10, 1][m[4].length - 1];
  return hours * 3600 + minutes * 60 + secs + milliseconds / 1000;
}

const entities: readonly (readonly [string, string])[] = [
  ["&lt;", "<"], ["&gt;", ">"], ["&nbsp;", "\u00A0"], ["&lrm;", "\u200E"], ["&rlm;", "\u200F"], ["&amp;", "&"],
];

export function subtitlePlainText(line: string): string {
  let text = line.replace(/<[^>]*>|\{[^}]*\}/gu, "");
  // `&amp;` decodes last so `&amp;lt;` yields the literal `&lt;`.
  for (const [entity, value] of entities) text = text.split(entity).join(value);
  return inlineTrim(text);
}

export function parseSubtitles(contents: string, format: SubtitleFormat): SubtitleCue[] {
  const normalized = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
  const lines = normalized.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n").map(inlineTrim);

  // Blank-line-separated blocks, tagged with their 0-based starting line.
  const blocks: { start: number; lines: string[] }[] = [];
  lines.forEach((line, index) => {
    if (line === "") return;
    const last = blocks[blocks.length - 1];
    if (last && last.start + last.lines.length === index) last.lines.push(line);
    else blocks.push({ start: index, lines: [line] });
  });
  if (format === "webVTT") {
    const header = blocks[0]?.lines[0];
    if (header === undefined || !isKeywordLine(header, "WEBVTT")) throw new SubtitleParseError("missingWebVTTHeader");
    blocks.shift();
  }

  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    if (format === "webVTT" && ["NOTE", "STYLE", "REGION"].some((k) => isKeywordLine(block.lines[0], k))) continue;
    // The timing line may be preceded by one SRT index or WebVTT cue-identifier line.
    const timingIndex = block.lines.slice(0, 2).findIndex((l) => l.includes("-->"));
    if (timingIndex < 0) throw new SubtitleParseError("malformedCue", { line: block.start + 1 });
    const sides = block.lines[timingIndex].split("-->");
    const start = sides.length === 2 ? seconds(sides[0]) : undefined;
    const end = sides.length === 2 ? seconds(sides[1]) : undefined;
    if (start === undefined || end === undefined || !(end > start)) {
      throw new SubtitleParseError("malformedCue", { line: block.start + timingIndex + 1 });
    }
    const textLines: string[] = [];
    for (let offset = timingIndex + 1; offset < block.lines.length; offset++) {
      const line = block.lines[offset];
      if (line.includes("-->")) throw new SubtitleParseError("malformedCue", { line: block.start + offset + 1 });
      const stripped = subtitlePlainText(line);
      if (stripped !== "") textLines.push(stripped);
    }
    const text = textLines.join("\n");
    if (text !== "") cues.push({ text, startSeconds: start, endSeconds: end });
  }
  if (cues.length === 0) throw new SubtitleParseError("noCues");
  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}
