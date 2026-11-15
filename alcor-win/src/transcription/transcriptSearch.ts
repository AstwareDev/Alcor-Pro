import { cachedOnDisk } from "./transcriptCache";

// Port of Transcription/TranscriptSearch.swift: exact keyword search over cached transcripts.

export interface TranscriptHit {
  assetID: string;
  start: number;
  end: number;
  text: string;
}

const edgePunctuation = /^\p{P}+|\p{P}+$/gu;

/** Query split into words, edge punctuation stripped (so "budget," becomes "budget"). */
export function transcriptSearchTerms(query: string): string[] {
  return query
    .split(/\s+/u)
    .map((t) => t.replace(edgePunctuation, ""))
    .filter((t) => t !== "");
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Case- and diacritic-insensitive; every term must occur (as a substring). */
export function transcriptMatches(text: string, terms: readonly string[]): boolean {
  const haystack = fold(text);
  return terms.every((t) => haystack.includes(fold(t)));
}

export async function searchTranscripts(
  query: string,
  assets: readonly { id: string; url: string }[],
  limit = 20,
): Promise<TranscriptHit[]> {
  const terms = transcriptSearchTerms(query);
  if (terms.length === 0) return [];
  const hits: TranscriptHit[] = [];
  for (const asset of assets) {
    const transcript = await cachedOnDisk(asset.url);
    if (!transcript) continue;
    for (const segment of transcript.segments) {
      if (!transcriptMatches(segment.text, terms)) continue;
      hits.push({ assetID: asset.id, start: segment.start, end: segment.end, text: segment.text });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
