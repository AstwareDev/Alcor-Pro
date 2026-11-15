import { clipEndFrame, textStyleCaption, type Clip, type Timeline } from "../model";
import type { TranscriptionResult } from "../transcription/transcription";
import { captionSpecs } from "./captionBuilder";
import { mapperPhrases, spokenWordCount } from "./captionTranscriptMapper";

// Port of the pure parts of EditorViewModel+Captions (TimelineTranscript*) and
// MediaPanel/IndexTab/TranscriptBrowser.swift (TranscriptBrowserMetrics / TimelineIndex / Navigation).

export interface TimelineTranscriptRow {
  id: string;
  clipId: string;
  text: string;
  startFrame: number;
  endFrame: number;
}

export function transcriptRowDurationFrames(row: TimelineTranscriptRow): number {
  return row.endFrame - row.startFrame;
}

export interface TimelineTranscriptDocument {
  fps: number;
  rows: TimelineTranscriptRow[];
  sourceTrackId: string | undefined;
  sourceCaptionGroupId: string | undefined;
}

export type TranscriptIndexSource = { kind: "automatic" } | { kind: "transcript" } | { kind: "captions"; groupId: string };

export type IndexBrowserSection = "transcript" | "markers";

/** `TranscriptBrowserMetrics.durationLabel`: "1.5s" or undefined for non-positive input. */
export function transcriptDurationLabel(durationFrames: number, fps: number): string | undefined {
  if (!(durationFrames > 0) || !(fps > 0)) return undefined;
  const seconds = durationFrames / fps;
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : undefined;
}

/** Row lookup by frame in O(log n) over rows sorted by start frame. */
export class TranscriptTimelineIndex {
  private readonly rows: readonly TimelineTranscriptRow[];
  private readonly longestEndingRowByPrefix: number[] = [];

  constructor(sortedRows: readonly TimelineTranscriptRow[]) {
    this.rows = sortedRows;
    if (sortedRows.length > 0) {
      let longest = 0;
      for (let i = 0; i < sortedRows.length; i++) {
        if (sortedRows[i].endFrame >= sortedRows[longest].endFrame) longest = i;
        this.longestEndingRowByPrefix.push(longest);
      }
    }
  }

  currentRow(frame: number): TimelineTranscriptRow | undefined {
    let lower = 0;
    let upper = this.rows.length;
    while (lower < upper) {
      const mid = lower + Math.trunc((upper - lower) / 2);
      if (this.rows[mid].startFrame <= frame) lower = mid + 1;
      else upper = mid;
    }
    if (lower === 0) return undefined;
    const latestIndex = lower - 1;
    const latest = this.rows[latestIndex];
    if (frame < latest.endFrame) return latest;
    if (latestIndex === 0) return undefined;
    const fallback = this.rows[this.longestEndingRowByPrefix[latestIndex - 1]];
    return frame < fallback.endFrame ? fallback : undefined;
  }
}

/** Caption groups already on the timeline, shown as transcript sources (visible tracks first). */
export function captionFallbacks(timeline: Timeline): TimelineTranscriptDocument[] {
  const tracks = [...timeline.tracks.filter((t) => !t.hidden), ...timeline.tracks.filter((t) => t.hidden)];
  const documents: TimelineTranscriptDocument[] = [];
  for (const track of tracks) {
    const seen = new Set<string>();
    const groupIds: string[] = [];
    for (const clip of track.clips) {
      if (clip.captionGroupId !== undefined && !seen.has(clip.captionGroupId)) {
        seen.add(clip.captionGroupId);
        groupIds.push(clip.captionGroupId);
      }
    }
    for (const groupId of groupIds) {
      const rows = track.clips
        .filter((c) => c.mediaType === "text" && c.captionGroupId === groupId)
        .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => ({ id: c.id, clipId: c.id, text: c.textContent ?? "", startFrame: c.startFrame, endFrame: clipEndFrame(c) }));
      documents.push({ fps: timeline.fps, rows, sourceTrackId: track.id, sourceCaptionGroupId: groupId });
    }
  }
  return documents;
}

/** Rows whose text contains the (trimmed) query, case- and diacritic-insensitively. */
export function filterTranscriptRows(rows: readonly TimelineTranscriptRow[], query: string): TimelineTranscriptRow[] {
  const q = query.trim();
  if (q === "") return [...rows];
  const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const needle = fold(q);
  return rows.filter((r) => fold(r.text).includes(needle));
}

// MARK: - Transcript documents

export interface PreparedTarget {
  id: string;
  trackId: string;
  clip: Clip;
}

/** `makeTimelineTranscriptDocument`: one row per caption phrase of every target, ordered by start frame then id. */
export function makeTimelineTranscriptDocument(
  timeline: Timeline,
  targets: readonly PreparedTarget[],
  results: ReadonlyMap<string, TranscriptionResult>,
): TimelineTranscriptDocument {
  const rows = targets.flatMap((target): TimelineTranscriptRow[] => {
    const result = results.get(target.clip.mediaRef);
    if (!result) return [];
    const phrases = mapperPhrases(target.clip, result, { fps: timeline.fps, maxWords: undefined, maxCharacters: undefined, fits: () => true });
    return captionSpecs(phrases, {
      sourceClip: target.clip,
      trackIndex: 0,
      fps: timeline.fps,
      style: textStyleCaption(),
      captionGroupId: undefined,
    }).map((spec, index) => ({
      id: `${target.clip.id}:${index}:${spec.startFrame}`,
      clipId: target.clip.id,
      text: spec.content,
      startFrame: spec.startFrame,
      endFrame: spec.startFrame + spec.durationFrames,
    }));
  });
  rows.sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { fps: timeline.fps, rows, sourceTrackId: undefined, sourceCaptionGroupId: undefined };
}

/** Track with the most spoken words among the targets; ties keep the first track seen. */
export function dominantSpeechTrack(
  timeline: Timeline,
  targets: readonly PreparedTarget[],
  results: ReadonlyMap<string, TranscriptionResult>,
): string | undefined {
  const wordsByTrack = new Map<string, number>();
  for (const t of targets) {
    const result = results.get(t.clip.mediaRef);
    if (!result) continue;
    wordsByTrack.set(t.trackId, (wordsByTrack.get(t.trackId) ?? 0) + spokenWordCount(t.clip, result, timeline.fps));
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [trackId, count] of wordsByTrack) {
    if (count > bestCount) {
      best = trackId;
      bestCount = count;
    }
  }
  return best;
}
