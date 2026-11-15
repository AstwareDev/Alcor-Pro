import { describe, expect, it } from "vitest";
import { makeFakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { cutRanges, type PlannerWord } from "./wordCutPlanner";
import { searchTranscripts, transcriptMatches, transcriptSearchTerms } from "./transcriptSearch";
import {
  cachedOnDisk, clearTranscriptMemory, filterTranscript, hasCachedCloudTranscript, storeCloudTranscript, transcriptIdentity,
  transcriptKey, variantPrefix,
} from "./transcriptCache";
import {
  decodeTranscriptionResult, makeTranscriptionResult, makeTranscriptionSegment, makeTranscriptionWord, segmentsFromWords,
  stitchTranscriptionResults, transcriptionOffsetting, transcriptionResultFromProvider,
} from "./transcription";

const full = makeTranscriptionResult({
  text: "Hello there. How are you. Fine thanks.",
  language: "en-US",
  words: [
    makeTranscriptionWord("Hello", 0.0, 0.4),
    makeTranscriptionWord("there", 0.4, 0.8),
    makeTranscriptionWord("How", 5.0, 5.3),
    makeTranscriptionWord("are", 5.3, 5.5),
    makeTranscriptionWord("you", 5.5, 5.8),
    makeTranscriptionWord("Fine", 10.0, 10.4),
    makeTranscriptionWord("thanks", 10.4, 10.9),
  ],
  segments: [
    makeTranscriptionSegment("Hello there.", 0.0, 0.8),
    makeTranscriptionSegment("How are you.", 5.0, 5.8),
    makeTranscriptionSegment("Fine thanks.", 10.0, 10.9),
  ],
});

describe("TranscriptCache", () => {
  it("filterKeepsOnlyOverlappingEntries", () => {
    const windowed = filterTranscript(full, { start: 4.0, end: 6.0 });
    expect(windowed.segments.map((s) => s.text)).toEqual(["How are you."]);
    expect(windowed.words.map((w) => w.text)).toEqual(["How", "are", "you"]);
    expect(windowed.text).toBe("How are you.");
    expect(windowed.language).toBe("en-US");
  });

  it("filterIncludesBoundaryStraddlers", () => {
    const windowed = filterTranscript(full, { start: 0.5, end: 5.2 });
    expect(windowed.segments.map((s) => s.text)).toEqual(["Hello there.", "How are you."]);
  });

  it("resultRoundTripsThroughJSON", () => {
    const decoded = decodeTranscriptionResult(JSON.parse(JSON.stringify(full)));
    expect(decoded.text).toBe(full.text);
    expect(decoded.language).toBe(full.language);
    expect(decoded.segments).toHaveLength(full.segments.length);
    expect(decoded.words).toHaveLength(full.words.length);
    expect(decoded.words[0].start).toBe(full.words[0].start);
  });

  it("keysFollowFileIdentityAndVariant", async () => {
    const io = makeFakeIo();
    io.addFile("/media/a.wav", "abc", 1000);
    setMediaIo(io);
    const auto = await transcriptKey("/media/a.wav", {});
    const lang = await transcriptKey("/media/a.wav", { language: "fr" });
    const ranged = await transcriptKey("/media/a.wav", { range: { start: 1, end: 2.5 } });
    expect(auto).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set([auto, lang, ranged]).size).toBe(3);
    io.addFile("/media/a.wav", "abcd", 2000);
    expect(await transcriptKey("/media/a.wav", {})).not.toBe(auto);
    expect(await transcriptKey("/media/missing.wav", {})).toBeUndefined();
    expect(variantPrefix({})).toBe("cloud|auto|full");
    expect(variantPrefix({ language: "fr", range: { start: 1, end: 2.5 } })).toBe("cloud|fr|1.000...2.500");
    expect(transcriptIdentity("/p", 1500, 3, {})).toBe("cloud|auto|full|/p|1.5|3");
    setMediaIo(undefined);
  });

  it("storesAndReadsBackThroughDisk", async () => {
    const io = makeFakeIo();
    io.addFile("/media/a.wav", "abc", 1000);
    setMediaIo(io);
    expect(await hasCachedCloudTranscript("/media/a.wav", {})).toBe(false);
    await storeCloudTranscript(full, "/media/a.wav", {});
    expect(await hasCachedCloudTranscript("/media/a.wav", {})).toBe(true);
    clearTranscriptMemory();
    expect((await cachedOnDisk("/media/a.wav"))?.text).toBe(full.text);
    setMediaIo(undefined);
  });
});

describe("TranscriptSearch", () => {
  it("parsesTermsStrippingEdgePunctuation", () => {
    expect(transcriptSearchTerms("  budget, meeting!  ")).toEqual(["budget", "meeting"]);
    expect(transcriptSearchTerms("don't stop")).toEqual(["don't", "stop"]);
    expect(transcriptSearchTerms("...")).toEqual([]);
    expect(transcriptSearchTerms("")).toEqual([]);
  });

  it("matchesAllTermsAnyOrder", () => {
    const text = "We reviewed the Q3 budget at the morning meeting.";
    expect(transcriptMatches(text, ["budget", "meeting"])).toBe(true);
    expect(transcriptMatches(text, ["meeting", "budget"])).toBe(true);
    expect(transcriptMatches(text, ["budget", "harbor"])).toBe(false);
  });

  it("caseAndDiacriticInsensitiveAndPartialWord", () => {
    expect(transcriptMatches("Visit the CAFÉ downtown", ["cafe"])).toBe(true);
    expect(transcriptMatches("she was running fast", ["run"])).toBe(true);
  });

  it("searchesCachedTranscriptsUpToTheLimit", async () => {
    const io = makeFakeIo();
    io.addFile("/media/a.wav", "abc", 1000);
    setMediaIo(io);
    await storeCloudTranscript(full, "/media/a.wav", {});
    const hits = await searchTranscripts("how are", [{ id: "a", url: "/media/a.wav" }, { id: "b", url: "/media/none.wav" }]);
    expect(hits).toEqual([{ assetID: "a", start: 5.0, end: 5.8, text: "How are you." }]);
    expect(await searchTranscripts("", [{ id: "a", url: "/media/a.wav" }])).toEqual([]);
    setMediaIo(undefined);
  });
});

describe("WordCutPlanner", () => {
  const words = (selected: number[]): PlannerWord[] =>
    [[0, 10], [11, 20], [21, 30], [31, 40]].map(([s, e], i) => ({ startFrame: s, endFrame: e, selected: selected.includes(i) }));

  it("cutSingleWord", () => {
    expect(cutRanges({ words: words([1]), clipStart: 0, clipEnd: 100, keepGapFrames: 6 })).toEqual([{ start: 11, end: 20 }]);
  });

  it("cutContiguousRun", () => {
    expect(cutRanges({ words: words([1, 2]), clipStart: 0, clipEnd: 100, keepGapFrames: 6 })).toEqual([{ start: 11, end: 30 }]);
  });

  it("cutNonAdjacentYieldsTwoRanges", () => {
    expect(cutRanges({ words: words([0, 2]), clipStart: 0, clipEnd: 100, keepGapFrames: 0 })).toHaveLength(2);
  });

  it("cutOverlappingTimestamps", () => {
    const ws: PlannerWord[] = [
      { startFrame: 0, endFrame: 10, selected: false },
      { startFrame: 9, endFrame: 20, selected: true },
      { startFrame: 19, endFrame: 30, selected: false },
    ];
    expect(cutRanges({ words: ws, clipStart: 0, clipEnd: 100, keepGapFrames: 6 })).toEqual([{ start: 9, end: 20 }]);
  });
});

describe("Transcription helpers", () => {
  it("offsettingShiftsEveryTimestamp", () => {
    const shifted = transcriptionOffsetting(full, 10);
    expect(shifted.words[0].start).toBe(10);
    expect(shifted.segments[2].end).toBeCloseTo(20.9);
    expect(transcriptionOffsetting(full, 0)).toBe(full);
  });

  it("segmentsFromWordsSplitAtSentenceEndsAndPauses", () => {
    const words = [
      makeTranscriptionWord("Hello", 0, 0.4),
      makeTranscriptionWord("there.", 0.5, 0.9),
      makeTranscriptionWord("How", 1.0, 1.2),
      makeTranscriptionWord("are", 1.2, 1.4),
      makeTranscriptionWord("you", 3.0, 3.2),
    ];
    expect(segmentsFromWords(words)).toEqual([
      makeTranscriptionSegment("Hello there.", 0, 0.9),
      makeTranscriptionSegment("How are", 1.0, 1.4),
      makeTranscriptionSegment("you", 3.0, 3.2),
    ]);
  });

  it("providerTranscriptsAdaptToResults", () => {
    const r = transcriptionResultFromProvider({
      text: " Hi there. ",
      language: "en",
      words: [{ text: " Hi", start: 0, end: 0.2, speakerId: "s0" }, { text: "there.", start: 0.3, end: 0.6, speakerId: "s0" }],
    });
    expect(r.text).toBe("Hi there.");
    expect(r.words[0]).toEqual({ text: "Hi", start: 0, end: 0.2, speaker: "s0" });
    expect(r.segments).toEqual([makeTranscriptionSegment("Hi there.", 0, 0.6, "s0")]);
  });

  it("stitchKeepsABoundaryWordOnceInTheChunkWhereItStarts", () => {
    const a = makeTranscriptionResult({ text: "one two", words: [makeTranscriptionWord("one", 1, 2), makeTranscriptionWord("two", 9.5, 10.5)], segments: [] });
    const b = makeTranscriptionResult({ text: "two three", words: [makeTranscriptionWord("two", 9.5, 10.5), makeTranscriptionWord("three", 11, 12)], segments: [] });
    const stitched = stitchTranscriptionResults([{ result: a, start: 0, end: 10 }, { result: b, start: 10, end: 20 }]);
    expect(stitched.words.map((w) => w.text)).toEqual(["one", "two", "three"]);
  });
});
