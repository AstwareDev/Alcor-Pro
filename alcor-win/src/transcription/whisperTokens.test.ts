import { describe, expect, it } from "vitest";
import { isRepeating, splitWords, tokenBytesFromVocab } from "./whisperTokens";

// GPT-2 byte-level stand-ins: "Ġ" is the space byte; "Ã" then "©" are the two UTF-8 bytes of "é".
const vocab: Record<string, number> = {
  "Ġhello": 0, "Ġwor": 1, "ld": 2, ".": 3, "Ã": 4, "©": 5, "Ġcaf": 6, "Ġ\"": 7, "Hi": 8, "ä¸Ń": 9, "æĸĩ": 10, "Ġis": 11,
};
const bytes = tokenBytesFromVocab(vocab);

describe("splitWords", () => {
  it("startsAWordAtEachLeadingSpaceAndKeepsPunctuationWithItsWord", () => {
    expect(splitWords([0, 1, 2, 3], bytes, "en")).toEqual([
      { text: "hello", tokens: 1 },
      { text: "world.", tokens: 3 },
    ]);
  });

  it("keepsAnOpeningQuoteWithTheFollowingWord", () => {
    expect(splitWords([7, 8, 11], bytes, "en")).toEqual([{ text: "\"Hi", tokens: 2 }, { text: "is", tokens: 1 }]);
  });

  it("joinsByteTokensOfOneCharacterAndNeverSplitsInsideIt", () => {
    expect(splitWords([6, 4, 5], bytes, "fr")).toEqual([{ text: "café", tokens: 3 }]);
  });

  it("makesEveryCharacterAWordForUnspacedLanguages", () => {
    expect(splitWords([9, 10], bytes, "zh")).toEqual([{ text: "中", tokens: 1 }, { text: "文", tokens: 1 }]);
  });

  it("returnsNothingForNoTokens", () => {
    expect(splitWords([], bytes, "en")).toEqual([]);
  });
});

describe("isRepeating", () => {
  it("detectsShortCyclesRepeatedManyTimes", () => {
    expect(isRepeating([5, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2])).toBe(true);
    expect(isRepeating(Array<number>(5).fill(7))).toBe(true);
  });

  it("ignoresOrdinaryText", () => {
    expect(isRepeating([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe(false);
    expect(isRepeating([1, 2, 1, 2, 1, 2])).toBe(false);
  });
});
