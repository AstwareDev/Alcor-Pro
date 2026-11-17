import { describe, expect, it } from "vitest";
import type { Transcript } from "../generation/providers/transcription";
import { windowIsSilence } from "./localTranscription";
import { stitchWindows } from "./whisperWindows";
import { cutRanges } from "./wordCutPlanner";
import { transcriptionResultFromProvider } from "./transcription";

describe("windowIsSilence", () => {
  it("dropsAWindowThatLooksSilentAndWasDecodedWithLowConfidence", () => {
    expect(windowIsSilence({ noSpeechProb: 0.9, avgLogprob: -1.4 })).toBe(true);
  });

  it("keepsConfidentOrAudibleWindows", () => {
    expect(windowIsSilence({ noSpeechProb: 0.9, avgLogprob: -0.3 })).toBe(false);
    expect(windowIsSilence({ noSpeechProb: 0.2, avgLogprob: -2 })).toBe(false);
  });
});

// What the engine hands to the shared pipeline: stitched Whisper words, punctuation attached, in source seconds.
const stitched = stitchWindows([
  { start: 0, end: 30, words: [{ text: "Hello", start: 0.1, end: 0.5 }, { text: "world.", start: 0.5, end: 1 }, { text: "Cut", start: 2, end: 2.3 }, { text: "this", start: 2.3, end: 2.6 }, { text: "out,", start: 2.6, end: 3 }, { text: "please", start: 4, end: 4.6 }] },
]);
const transcript: Transcript = { text: stitched.map((w) => w.text).join(" "), language: "en", words: stitched };

describe("local transcript in the shared format", () => {
  const result = transcriptionResultFromProvider(transcript);

  it("keepsWordsWithTheirSecondsAndSplitsSegmentsAtSentenceEndsAndPauses", () => {
    expect(result.language).toBe("en");
    expect(result.words.map((w) => [w.text, w.start, w.end])).toEqual(transcript.words.map((w) => [w.text, w.start, w.end]));
    expect(result.segments.map((s) => s.text)).toEqual(["Hello world.", "Cut this out,", "please"]);
    expect(result.segments[1]?.start).toBe(2);
    expect(result.segments[1]?.end).toBe(3);
  });

  it("leavesNoSpeakerLabelsBecauseThisBackendDoesNotDiarize", () => {
    expect(result.words.every((w) => w.speaker === undefined)).toBe(true);
    expect(result.segments.every((s) => s.speaker === undefined)).toBe(true);
  });

  it("drivesWordCutsLikeAnyOtherBackend", () => {
    const fps = 30;
    const words = result.words.map((w) => ({
      startFrame: Math.round((w.start ?? 0) * fps),
      endFrame: Math.round((w.end ?? 0) * fps),
      selected: w.text === "this" || w.text === "out,",
    }));
    const cuts = cutRanges({ words, clipStart: 0, clipEnd: 150, keepGapFrames: 0 });
    expect(cuts).toEqual([{ start: 69, end: 120 }]); // the cut runs on through the pause up to the next kept word
  });
});
