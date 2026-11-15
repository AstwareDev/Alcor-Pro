import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./textFit";

const measure = (s: string) => s.length * 5;

describe("truncateMiddle", () => {
  it("returnsTextThatFits", () => expect(truncateMiddle("abc", 15, measure)).toBe("abc"));
  it("keepsHeadAndTailWithEllipsis", () => {
    const out = truncateMiddle("juicymarbles_347c_2", 50, measure);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).toMatch(/^juic.*….*_2$/);
  });
  it("neverExceedsTheWidth", () => {
    for (const w of [5, 12, 30, 61]) expect(measure(truncateMiddle("a-very-long-file-name.mp4", w, measure))).toBeLessThanOrEqual(Math.max(w, 5));
  });
  it("handlesEmptyText", () => expect(truncateMiddle("", 0, measure)).toBe(""));
});
