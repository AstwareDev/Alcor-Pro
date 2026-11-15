// Test-only builders shared by the media tool tests.
import {
  makeExternalSource, makeMediaManifestEntry, type ClipType, type MediaManifestEntry,
} from "../../model";
import {
  makeTranscriptionResult, makeTranscriptionSegment, makeTranscriptionWord, type TranscriptionResult,
} from "../../transcription/transcription";

export function manifestEntry(p: { id: string; name: string; type: ClipType; path: string; duration: number } & Partial<MediaManifestEntry>): MediaManifestEntry {
  const { path, ...rest } = p;
  return makeMediaManifestEntry({ ...rest, source: makeExternalSource(path) });
}

/** `[text, start, end, words]` rows become segments plus evenly split words. */
export function transcriptOf(rows: [string, number, number, string[]][]): TranscriptionResult {
  const words = rows.flatMap(([, start, end, ws]) =>
    ws.map((w, i) => makeTranscriptionWord(w, start + ((end - start) * i) / ws.length, start + ((end - start) * (i + 1)) / ws.length)),
  );
  return makeTranscriptionResult({
    text: rows.map((r) => r[0]).join(" "),
    words,
    segments: rows.map(([text, start, end]) => makeTranscriptionSegment(text, start, end)),
  });
}
