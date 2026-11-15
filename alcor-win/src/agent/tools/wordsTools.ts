import type { FrameRange } from "../../editor/rippleEngine";
import { rippleDeleteRangesOnTrack } from "../../editor/mutations/ripple";
import { cutAggressivenessValues, cutRanges, keptGapMs, type CutAggressiveness } from "../../transcription/wordCutPlanner";
import { swiftRound } from "../../util/math";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import type { Json } from "./timelinePayload";
import { ToolError, argString, safeInt, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";
import {
  lastTranscriptSession, makeTranscriptSession, timelineTranscript, transcriptGroups, transcriptionContext,
  transcriptSessionHasSameWordMapping, type TranscriptSession,
} from "./transcriptionTools";

// Port of ToolExecutor+Words.swift: remove_words. (remove_silence stays pending: it needs on-device speech analysis.)

const removeWordsAllowedKeys = ["words", "matches", "cutAggressiveness", "language"];

function intFromAny(v: unknown): number | undefined {
  return typeof v === "number" ? safeInt(v) : undefined;
}

export function parseWordSpans(raw: readonly unknown[]): [number, number][] {
  return raw.map((element, i) => {
    const n = intFromAny(element);
    if (n !== undefined) return [n, n];
    if (Array.isArray(element) && element.length === 2) {
      const a = intFromAny(element[0]);
      const b = intFromAny(element[1]);
      if (a !== undefined && b !== undefined) return [a, b];
    }
    throw new ToolError(`words[${i}]: expected an integer index or an [start, end] pair.`);
  });
}

export function normalizedWordMatch(text: string): string {
  return text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "").toLowerCase();
}

export function parseWordMatches(raw: readonly unknown[]): Set<string> {
  const matches = raw.map((element, i) => {
    if (typeof element !== "string") throw new ToolError(`matches[${i}]: expected a string.`);
    const normalized = normalizedWordMatch(element);
    if (normalized === "") throw new ToolError(`matches[${i}]: expected a non-empty word.`);
    return normalized;
  });
  return new Set(matches);
}

function msToFrames(ms: number, fps: number): number {
  return swiftRound((ms / 1000) * fps);
}

export async function removeWords({ executor, editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, removeWordsAllowedKeys, "remove_words");
  const rawWords = Array.isArray(args.words) ? args.words : undefined;
  const rawMatches = Array.isArray(args.matches) ? args.matches : undefined;
  if (rawWords?.length === 0 || rawMatches?.length === 0) throw new ToolError("remove_words: words or matches must not be empty.");
  if (rawWords === undefined && rawMatches === undefined) {
    throw new ToolError(
      "Missing 'words' or 'matches'. Pass word indices from get_transcript, e.g. [5, [12, 18]], or exact words like [\"um\", \"uh\"].",
    );
  }
  if (rawWords !== undefined && rawMatches !== undefined) throw new ToolError("remove_words: pass either words or matches, not both.");

  let aggressiveness: CutAggressiveness = "balanced";
  const rawAggressiveness = argString(args, "cutAggressiveness");
  if (rawAggressiveness !== undefined) {
    if (!(cutAggressivenessValues as readonly string[]).includes(rawAggressiveness)) {
      throw new ToolError(`cutAggressiveness must be one of: ${cutAggressivenessValues.join(", ")}.`);
    }
    aggressiveness = rawAggressiveness as CutAggressiveness;
  }

  let session: TranscriptSession;
  const remembered = lastTranscriptSession(executor);
  if (remembered && remembered.timelineId === editor.doc.activeTimelineId) {
    if (rawWords !== undefined && !transcriptSessionHasSameWordMapping(remembered, editor)) {
      throw new ToolError("The timeline sources from the previous get_transcript have changed. Call get_transcript again before remove_words.");
    }
    session = remembered;
  } else {
    if (rawWords !== undefined && remembered !== undefined) {
      throw new ToolError("The previous get_transcript belongs to a different timeline. Call get_transcript again before remove_words.");
    }
    session = makeTranscriptSession(editor, transcriptionContext(args), { kind: "automatic" });
  }
  const transcript = await timelineTranscript(editor, session);
  const allWords = transcript.words;
  if (allWords.length === 0) throw new ToolError("No transcribable speech on the timeline.");

  const selected = new Set<number>();
  const ignored: number[] = [];
  const maxIndex = allWords.length - 1;
  if (rawWords !== undefined) {
    for (const [a, b] of parseWordSpans(rawWords)) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      // Clamp to the valid transcript range so an out-of-range span can't iterate billions of times.
      if (hi < 0 || lo > maxIndex) {
        ignored.push(lo);
        continue;
      }
      if (lo < 0) ignored.push(lo);
      if (hi > maxIndex) ignored.push(hi);
      for (let idx = Math.max(0, lo); idx <= Math.min(maxIndex, hi); idx++) selected.add(idx);
    }
    if (selected.size === 0) {
      throw new ToolError(`None of the requested word indices are in range 0...${maxIndex}. Re-read get_transcript.`);
    }
  } else if (rawMatches !== undefined) {
    const matches = parseWordMatches(rawMatches);
    for (const word of allWords) if (matches.has(normalizedWordMatch(word.text))) selected.add(word.index);
    if (selected.size === 0) {
      throw new ToolError(`No transcript words matched: ${[...matches].sort().join(", ")}. Re-read get_transcript or pass exact word indices.`);
    }
  }

  const keepGapFrames = msToFrames(keptGapMs(aggressiveness), editor.timeline.fps);
  const removedTexts: string[] = [];
  const rangesByTrack = new Map<number, FrameRange[]>();
  const involvedClips: string[] = [];
  for (const group of transcriptGroups(transcript)) {
    if (!group.words.some((w) => selected.has(w.index))) continue;
    removedTexts.push(...group.words.filter((w) => selected.has(w.index) && w.endFrame > w.startFrame).map((w) => w.text));
    const plan = group.words.map((w) => ({ startFrame: w.startFrame, endFrame: w.endFrame, selected: selected.has(w.index) }));
    const ranges = cutRanges({ words: plan, clipStart: group.clipStartFrame, clipEnd: group.clipEndFrame, keepGapFrames });
    if (ranges.length > 0) {
      rangesByTrack.set(group.trackIndex, [...(rangesByTrack.get(group.trackIndex) ?? []), ...ranges]);
      involvedClips.push(group.clipId);
    }
  }
  if (rangesByTrack.size === 0) throw new ToolError("The selected words resolved to no removable frames. Re-read get_transcript.");

  // Cut one track; the ripple carries its linked A/V partners across the same span.
  const trackKeys = [...rangesByTrack.keys()].sort((a, b) => a - b);
  if (trackKeys.length > 1) {
    // Multiple tracks are only coherent as one linked unit (e.g. camera + mic); otherwise cutting them together breaks alignment.
    const groupIds = involvedClips.flatMap((id) => {
      const gid = editor.clipFor(id)?.linkGroupId;
      return gid === undefined ? [] : [gid];
    });
    if (groupIds.length !== involvedClips.length || new Set(groupIds).size !== 1) {
      throw new ToolError(
        `Selected words span multiple unlinked tracks (${trackKeys.join(", ")}). Remove words one track at a time — linked video/audio is cut automatically. If these tracks are the same source (e.g. camera + mic), link them into one unit first.`,
      );
    }
  }
  const primaryTrack = trackKeys[0];
  // Use only the primary track's own ranges; the ripple removes the same span from linked partners.
  const primaryRanges = rangesByTrack.get(primaryTrack) ?? [];

  const snapshot = timelineSnapshot(editor);
  const outcome = editor.perform("Remove Words (Agent)", () => rippleDeleteRangesOnTrack(editor, primaryTrack, primaryRanges));
  if (outcome.kind === "refused") throw new ToolError(`Ripple delete refused: ${outcome.reason}`);

  const extra: Json = {
    removedWords: removedTexts.length,
    removedFrames: outcome.report.removedFrames,
    cutAggressiveness: aggressiveness,
    transcriptionSource: session.context.provider,
  };
  const preview = removedTexts.slice(0, 24).join(" ");
  if (preview !== "") extra.removedText = removedTexts.length > 24 ? `${preview} …` : preview;
  if (ignored.length > 0) extra.indicesIgnored = [...ignored].sort((a, b) => a - b);
  return mutationResult(editor, snapshot, {
    extra,
    notes: ["Word indices shifted — re-read get_transcript before another remove_words."],
  });
}
