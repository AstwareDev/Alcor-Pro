import { describe, expect, it } from "vitest";
import { SiglipTokenizer } from "./siglipTokenizer";

const vocab: [string, number][] = [
  ["<pad>", 0], ["</s>", 0], ["<unk>", 0],
  ["▁", -3], ["▁a", -2], ["▁dog", -4], ["▁d", -5], ["og", -5], ["▁do", -4.5], ["g", -6], ["▁sun", -3.5], ["set", -4],
];
const tokenizer = new SiglipTokenizer({ vocab, unkId: 2 }, 8);
const id = (piece: string): number => vocab.findIndex(([p]) => p === piece);

describe("SiglipTokenizer", () => {
  it("normalizesLikeTheReference", () => {
    expect(SiglipTokenizer.normalize("  A Dog, on_the   BEACH!! ")).toBe("a dog on the beach");
    expect(SiglipTokenizer.normalize("ＡＢ")).toBe("ab");
  });

  it("picksTheHighestScoringSegmentation", () => {
    // "▁dog" (-4) beats "▁d" + "og" (-10) and "▁do" + "g" (-10.5)
    expect(tokenizer.pieces("dog")).toEqual([id("▁dog")]);
    expect(tokenizer.pieces("A sunset")).toEqual([id("▁a"), id("▁sun"), id("set")].slice(0, 1).concat([id("▁"), id("▁sun")].slice(1), [id("set")]).filter((x) => x >= 0).slice(0, 3));
  });

  it("padsWithEndTokenAndNoMask", () => {
    const ids = Array.from(tokenizer.tokenize("a dog"));
    expect(ids).toEqual([id("▁a"), id("▁dog"), 1, 1, 1, 1, 1, 1]);
    expect(Array.from(tokenizer.tokenize(""))).toEqual(new Array(8).fill(1));
  });

  it("truncatesLeavingRoomForTheEndToken", () => {
    const ids = Array.from(tokenizer.tokenize("a a a a a a a a a a a a"));
    expect(ids).toHaveLength(8);
    expect(ids.slice(0, 7).every((x) => x === id("▁a"))).toBe(true);
    expect(ids[7]).toBe(1);
  });

  it("mapsUnknownCharactersToUnk", () => {
    expect(tokenizer.pieces("a z")).toContain(2);
  });

  it("rejectsNonUnigramJson", () => {
    expect(() => SiglipTokenizer.fromJSON('{"model":{"type":"BPE"}}', 8)).toThrow();
  });
});
