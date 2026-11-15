import { describe, expect, it } from "vitest";
import { interpolations } from "../../model";
import { keyframeGlyphKind } from "./keyframeGlyph";

describe("keyframe glyphs", () => {
  it("every interpolation has its own shape", () => {
    const kinds = interpolations.map(keyframeGlyphKind);
    expect(new Set(kinds).size).toBe(interpolations.length);
    expect(keyframeGlyphKind("linear")).toBe("diamond");
    expect(keyframeGlyphKind("hold")).toBe("square");
  });
});
