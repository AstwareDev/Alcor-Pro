import { describe, expect, it } from "vitest";
import { makeClip, makeTextAnimation, makeTextStyle, makeTransform } from "../model";
import { makeTranscriptionSegment, makeTranscriptionWord } from "../transcription/transcription";
import { captionSpecs, makePhrase, phrasesForSegment, phrasesFromTimedWords } from "./captionBuilder";

const segment = (text: string, start: number, end: number) => makeTranscriptionSegment(text, start, end);
const all = () => true;

describe("CaptionBuilder", () => {
  it("keepsSegmentWholeWhenItFits", () => {
    expect(phrasesForSegment(segment("Hello there", 1.0, 2.0), { fits: all })).toEqual([makePhrase("Hello there", 1.0, 2.0)]);
  });

  it("splitsAtSentenceBoundary", () => {
    const phrases = phrasesForSegment(segment("One. Two.", 0, 8), { fits: (t) => t.length <= 5 });
    expect(phrases.map((p) => p.text)).toEqual(["One.", "Two."]);
    expect(phrases.map((p) => p.start)).toEqual([0.0, 4.0]);
    expect(phrases.map((p) => p.end)).toEqual([4.0, 8.0]);
  });

  it("splitsAtClauseWhenNoSentence", () => {
    const phrases = phrasesForSegment(segment("alpha, beta", 0, 2), { fits: (t) => t.length <= 6 });
    expect(phrases.map((p) => p.text)).toEqual(["alpha,", "beta"]);
  });

  it("splitsAtMidWordWhenNoPunctuation", () => {
    const phrases = phrasesForSegment(segment("a b c d", 0, 4), { fits: (t) => t.length <= 3 });
    expect(phrases.map((p) => p.text)).toEqual(["a b", "c d"]);
  });

  it("capsWordsPerCaption", () => {
    const phrases = phrasesForSegment(segment("one two three four five six", 0, 6), { fits: all, maxWords: 2 });
    expect(phrases.every((p) => p.text.split(" ").length <= 2)).toBe(true);
    expect(phrases.map((p) => p.text).join(" ")).toBe("one two three four five six");
  });

  it("maxWordsStillPrefersSentenceBoundary", () => {
    const phrases = phrasesForSegment(segment("Hi there. How are you", 0, 6), { fits: all, maxWords: 3 });
    expect(phrases.map((p) => p.text)).toEqual(["Hi there.", "How are you"]);
  });

  it("capsCharactersPerCaption", () => {
    const phrases = phrasesForSegment(segment("one two three four", 0, 4), { fits: all, maxCharacters: 8 });
    expect(phrases.every((p) => p.text.length <= 8)).toBe(true);
    expect(phrases.map((p) => p.text).join(" ")).toBe("one two three four");
  });

  it("characterCapIncludesSpacesAndPunctuation", () => {
    const phrases = phrasesForSegment(segment("hi, you", 0, 2), { fits: all, maxCharacters: 6 });
    expect(phrases.map((p) => p.text)).toEqual(["hi,", "you"]);
  });

  it("wordAndCharacterCapsApplyTogetherWithoutDroppingText", () => {
    const phrases = phrasesForSegment(segment("a bb ccc dddd", 0, 4), { fits: all, maxWords: 2, maxCharacters: 5 });
    expect(phrases.every((p) => p.text.split(" ").length <= 2)).toBe(true);
    expect(phrases.every((p) => p.text.length <= 5)).toBe(true);
    expect(phrases.map((p) => p.text).join(" ")).toBe("a bb ccc dddd");
  });

  it("keepsPunctuatedTokensIntact", () => {
    const phrases = phrasesForSegment(segment("U.S. army here", 0, 6), { fits: (t) => t.length <= 6 });
    expect(phrases.map((p) => p.text)).toEqual(["U.S.", "army", "here"]);
  });

  it("distributesTimeByCharacterCount", () => {
    const phrases = phrasesForSegment(segment("aaaa bb", 0, 6), { fits: (t) => t.length <= 4 });
    expect(phrases.map((p) => p.text)).toEqual(["aaaa", "bb"]);
    expect(phrases.map((p) => p.start)).toEqual([0.0, 4.0]);
    expect(phrases.map((p) => p.end)).toEqual([4.0, 6.0]);
  });

  it("denseWordTimingsRemainExact", () => {
    const words = [
      makeTranscriptionWord("Okay,", 1.235, 1.413),
      makeTranscriptionWord("so", 1.43, 1.609),
      makeTranscriptionWord("I've", 1.641, 1.739),
      makeTranscriptionWord("been", 1.739, 1.836),
      makeTranscriptionWord("sleeping", 1.836, 2.161),
    ];
    const phrases = phrasesForSegment(segment("Okay, so I've been sleeping", 1.235, 2.161), {
      words,
      fits: (t) => t === "Okay," || t === "so I've been sleeping",
    });
    expect(phrases.map((p) => p.text)).toEqual(["Okay,", "so I've been sleeping"]);
    expect(phrases.map((p) => p.start)).toEqual([1.235, 1.43]);
    expect(phrases[0].end).toBe(1.413);
  });

  it("phrasesFromWordsUseOnlyPassedWords", () => {
    const phrases = phrasesFromTimedWords(
      [makeTranscriptionWord("Okay,", 1.0, 1.2), makeTranscriptionWord("go", 2.0, 2.2)],
      { fits: all },
    );
    expect(phrases.map((p) => p.text)).toEqual(["Okay, go"]);
    expect(phrases[0].words.map((w) => w.text)).toEqual(["Okay,", "go"]);
  });

  it("keepsOverlongSingleWord", () => {
    const phrases = phrasesForSegment(segment("supercalifragilistic", 0, 1), { fits: () => false });
    expect(phrases.map((p) => p.text)).toEqual(["supercalifragilistic"]);
  });
});

describe("CaptionBuilder.specs", () => {
  const clip = makeClip({ mediaRef: "m", startFrame: 30, durationFrames: 120 });
  const style = makeTextStyle();

  it("carriesWordTimingsAndAnimation", () => {
    const p = makePhrase("hi there", 1.0, 2.0, [
      { text: "hi", start: 1.0, end: 1.4 },
      { text: "there", start: 1.5, end: 2.0 },
    ]);
    const specs = captionSpecs([p], { sourceClip: clip, trackIndex: 0, fps: 30, style, captionGroupId: "g1", animation: makeTextAnimation({ preset: "wordSlide" }) });
    expect(specs[0].animation?.preset).toBe("wordSlide");
    const words = specs[0].words ?? [];
    expect(words.map((w) => w.text)).toEqual(["hi", "there"]);
    expect([words[0].startFrame, words[0].endFrame]).toEqual([0, 12]); // clip-relative
    expect([words[1].startFrame, words[1].endFrame]).toEqual([15, 30]);
  });

  it("mapsWordEndingAtClipBoundary", () => {
    const source = makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 30 });
    const p = makePhrase("hi there", 0.0, 1.0, [
      { text: "hi", start: 0.0, end: 0.5 },
      { text: "there", start: 0.5, end: 1.0 },
    ]);
    const specs = captionSpecs([p], { sourceClip: source, trackIndex: 0, fps: 30, style, captionGroupId: undefined, animation: makeTextAnimation({ preset: "wordSlide" }) });
    expect(specs[0].words).toEqual([
      { text: "hi", startFrame: 0, endFrame: 15 },
      { text: "there", startFrame: 15, endFrame: 30 },
    ]);
  });

  it("mapsSecondsThroughClipPlacement", () => {
    const specs = captionSpecs([makePhrase("hi", 1.0, 2.0)], { sourceClip: clip, trackIndex: 0, fps: 30, style, captionGroupId: "g1" });
    expect(specs).toHaveLength(1);
    expect(specs[0].startFrame).toBe(60);
    expect(specs[0].durationFrames).toBe(30);
    expect(specs[0].captionGroupId).toBe("g1");
  });

  it("clampsPhraseRunningPastClipEnd", () => {
    const specs = captionSpecs([makePhrase("long", 1.0, 10.0)], { sourceClip: clip, trackIndex: 0, fps: 30, style, captionGroupId: undefined });
    expect(specs[0].startFrame).toBe(60);
    expect(specs[0].durationFrames).toBe(90);
  });

  it("clampsPhraseSpanningTrimmedClip", () => {
    const trimmed = { ...clip, trimStartFrame: 60 };
    const specs = captionSpecs([makePhrase("full", 0.0, 10.0)], { sourceClip: trimmed, trackIndex: 0, fps: 30, style, captionGroupId: undefined });
    expect(specs).toHaveLength(1);
    expect(specs[0].startFrame).toBe(30);
    expect(specs[0].durationFrames).toBe(120);
  });

  it("transformForResolvesEachBox", () => {
    const box = makeTransform({ centerX: 0.5, centerY: 0.85, width: 0.4, height: 0.1 });
    const specs = captionSpecs([makePhrase("hi", 1.0, 2.0)], { sourceClip: clip, trackIndex: 0, fps: 30, style, captionGroupId: undefined, transformFor: () => box });
    expect(specs[0].transform).toEqual(box);
  });

  it("dropsPhraseEntirelyBeforeTrimIn", () => {
    const trimmed = { ...clip, trimStartFrame: 60 };
    const specs = captionSpecs([makePhrase("gone", 0.5, 1.0)], { sourceClip: trimmed, trackIndex: 0, fps: 30, style, captionGroupId: undefined });
    expect(specs).toEqual([]);
  });
});
