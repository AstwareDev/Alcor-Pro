import { describe, expect, it } from "vitest";
import { formatTimecode, parseTimecode, roundedToPlaces, secondsToFrame } from "./timeFormatting";

describe("formatTimecode", () => {
  it("zeroFrameIsAllZeros", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
  });

  it("framesRollIntoSecondsAtFpsBoundary", () => {
    expect(formatTimecode(29, 30)).toBe("00:00:00:29");
    expect(formatTimecode(30, 30)).toBe("00:00:01:00");
  });

  it("secondsRollIntoMinutes", () => {
    expect(formatTimecode(1800, 30)).toBe("00:01:00:00");
  });

  it("minutesRollIntoHours", () => {
    expect(formatTimecode(108000, 30)).toBe("01:00:00:00");
  });

  it("twoDigitPaddingHoldsBelowTen", () => {
    expect(formatTimecode(150, 30)).toBe("00:00:05:00");
  });

  it("zeroFpsReturnsFallbackInsteadOfDividingByZero", () => {
    expect(formatTimecode(100, 0)).toBe("00:00:00:00");
  });

  it("twentyFourFpsRollsAtTwentyFour", () => {
    expect(formatTimecode(23, 24)).toBe("00:00:00:23");
    expect(formatTimecode(24, 24)).toBe("00:00:01:00");
  });

  it("timecodeParsingValidatesFields", () => {
    expect(parseTimecode("01:02:03:04", 30)).toBe(111_694);
    expect(parseTimecode("00:00:00:30", 30)).toBeUndefined();
    expect(parseTimecode("invalid", 30)).toBeUndefined();
  });
});

describe("frame/seconds conversion", () => {
  it("secondsToFrameMultipliesByFps", () => {
    expect(secondsToFrame(2.0, 30)).toBe(60);
    expect(secondsToFrame(0.5, 30)).toBe(15);
  });

  it("secondsToFrameTruncatesFractionalResult", () => {
    expect(secondsToFrame(0.45, 30)).toBe(13);
    expect(secondsToFrame(0.4, 30)).toBe(12);
  });
});

describe("TimeFormatting — adversarial", () => {
  it("negativeFrameFormatsWithLeadingSign", () => {
    expect(formatTimecode(-30, 30)).toBe("-00:00:01:00");
    expect(formatTimecode(-1, 30)).toBe("-00:00:00:01");
    expect(formatTimecode(30, 30)).toBe("00:00:01:00");
  });

  it("formatTimecodeAtVeryLargeFrameStillProducesOutput", () => {
    const result = formatTimecode(3_000_000, 30);
    expect(result.split(":").length).toBe(4);
  });
});

describe("roundedToPlaces", () => {
  it("rounds half away from zero", () => {
    expect(roundedToPlaces(1.005 * 1000, 0)).toBe(1005);
    expect(roundedToPlaces(-2.5, 0)).toBe(-3);
    expect(roundedToPlaces(3.14159, 2)).toBe(3.14);
  });
});
