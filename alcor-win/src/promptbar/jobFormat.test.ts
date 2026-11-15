import { describe, expect, it } from "vitest";
import { formatTimecode } from "./jobFormat";

describe("formatTimecode", () => {
  it("formats minutes and seconds", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(7.9)).toBe("0:07");
    expect(formatTimecode(65)).toBe("1:05");
  });
  it("adds hours when needed and clamps negatives", () => {
    expect(formatTimecode(3723)).toBe("1:02:03");
    expect(formatTimecode(-3)).toBe("0:00");
  });
});
