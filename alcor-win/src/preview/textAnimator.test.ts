import { describe, expect, it } from "vitest";
import { makeTextAnimation, type TextAnimationPreset, type WordTiming } from "../model/textAnimation";
import { textAnimatorClipEntry, textAnimatorWordState } from "./textAnimator";
import { textTokenTimings, textTypewriterVisibleText, textWords } from "./textRenderer";

function highlightAmount(preset: TextAnimationPreset, word: WordTiming, nextWord: WordTiming | undefined, frame: number): number {
  const animation = makeTextAnimation({ preset, perWordFrames: 6, highlight: { r: 1, g: 0, b: 0, a: 1 } });
  const state = textAnimatorWordState(animation, word, nextWord, frame, { r: 0, g: 0, b: 0, a: 1 });
  return preset === "highlightBlock" ? state.bgColor?.a ?? 0 : state.color.r;
}

const w = (text: string, startFrame: number, endFrame: number): WordTiming => ({ text, startFrame, endFrame });

describe("TextAnimator", () => {
  for (const preset of ["highlightPop", "highlightBlock"] as const) {
    it(`shortWordHighlightAttackUsesOriginalTiming (${preset})`, () => {
      expect(highlightAmount(preset, w("A", 10, 12), w("pause", 30, 40), 11)).toBe(1);
    });
    it(`highlightHoldsAcrossPause (${preset})`, () => {
      expect(highlightAmount(preset, w("hold", 0, 2), w("next", 20, 30), 15)).toBe(1);
    });
    it(`adjacentWordHighlightsCrossfadeWithoutGap (${preset})`, () => {
      for (let frame = 20; frame <= 24; frame++) {
        const outgoing = highlightAmount(preset, w("first", 0, 2), w("next", 20, 30), frame);
        const incoming = highlightAmount(preset, w("next", 20, 30), undefined, frame);
        expect(Math.abs(outgoing + incoming - 1)).toBeLessThan(0.000_001);
      }
    });
    it(`finalWordHighlightHolds (${preset})`, () => {
      expect(highlightAmount(preset, w("final", 70, 72), undefined, 89)).toBe(1);
    });
  }

  it("pop-in and slide-up entrances ease in over perWordFrames", () => {
    const pop = makeTextAnimation({ preset: "popIn", perWordFrames: 10 });
    expect(textAnimatorClipEntry(pop, 0)).toEqual({ opacity: 0, scale: 0.6, dy: 0 });
    expect(textAnimatorClipEntry(pop, 5)).toEqual({ opacity: 0.5, scale: 0.8, dy: 0 });
    expect(textAnimatorClipEntry(pop, 10)).toEqual({ opacity: 1, scale: 1, dy: 0 });
    const slide = textAnimatorClipEntry(makeTextAnimation({ preset: "slideUp", perWordFrames: 10 }), 5);
    expect(slide.dy).toBeCloseTo(0.025, 9);
    expect(textAnimatorClipEntry(makeTextAnimation({ preset: "wordReveal" }), 0)).toEqual({ opacity: 1, scale: 1, dy: 0 });
  });

  it("word reveal tints the active word only when a highlight is set", () => {
    const plain = textAnimatorWordState(makeTextAnimation({ preset: "wordReveal" }), w("a", 0, 30), undefined, 15, { r: 1, g: 1, b: 1, a: 1 });
    expect(plain.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(plain.opacity).toBe(1);
  });
});

describe("TextFrameRenderer token timings", () => {
  it("tokenTimingsSplitAlignedTranscriptSpan", () => {
    const tokens = textWords("New York");
    expect(textTokenTimings(tokens, [w("New York", 10, 50)], 90)).toEqual([w("New", 10, 30), w("York", 30, 50)]);
  });

  it("tokenTimingsMergeAlignedTranscriptSpans", () => {
    expect(textTokenTimings(textWords("NewYork"), [w("New", 10, 30), w("York", 30, 50)], 90)).toEqual([w("NewYork", 10, 50)]);
  });

  it("even timings without word timings; clamped when counts match", () => {
    expect(textTokenTimings(textWords("a b c"), undefined, 90)).toEqual([w("a", 0, 30), w("b", 30, 60), w("c", 60, 90)]);
    expect(textTokenTimings(textWords("a"), [w("x", -5, 200)], 90)).toEqual([w("a", 0, 90)]);
  });

  it("words split on whitespace and newlines over UTF-16 offsets", () => {
    expect(textWords("  hi\nthere  😀x ").map((t) => [t.start, t.text])).toEqual([[2, "hi"], [5, "there"], [12, "😀x"]]);
  });
});

describe("TextFrameRenderer typewriter", () => {
  it("typewriterPreviewTypesFinalTokenBeforeHold", () => {
    expect(textTypewriterVisibleText("Aa Bb Cc", undefined, 54, 36)).toBe("Aa Bb |");
  });

  it("typewriterShowsCompleteTextOnFinalFrame", () => {
    expect(textTypewriterVisibleText("ONE TWO THREE", undefined, 90, 89)).toBe("ONE TWO THREE");
  });

  it("caret blinks every 15 frames while typing", () => {
    expect(textTypewriterVisibleText("ONE TWO", undefined, 90, 0)).toBe("|");
    expect(textTypewriterVisibleText("ONE TWO", undefined, 90, 15)).toBe("O");
  });
});
