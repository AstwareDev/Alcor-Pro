import { describe, expect, it } from "vitest";
import { textStyleCaption } from "../model";
import { buildSubtitleCueSpecs } from "./captionSpecBuilder";
import { parseSubtitles, subtitleFormatFromExtension, SubtitleParseError, type SubtitleCue } from "./subtitleFileParser";
import { fakeMeasure, testGroupId } from "./testSupport";

function parseError(contents: string, format: "srt" | "webVTT"): SubtitleParseError {
  try {
    parseSubtitles(contents, format);
  } catch (e) {
    if (e instanceof SubtitleParseError) return e;
  }
  throw new Error("expected SubtitleParseError");
}

describe("SubtitleFileParser", () => {
  it("parsesSRTToleratingBOMCRLFDotMillisMissingIndicesAndOutOfOrderCues", () => {
    const srt =
      "\uFEFF1\r\n00:01:00.250 --> 00:01:02,000\r\nLine one\r\nLine two\r\n\r\n" +
      "00:00:01,000 --> 00:00:02,500\r\nFirst.\r\n\r\n" +
      "3\r\n00:00:07,000 --> 00:00:08,000\r\n<i></i>\r\n";
    expect(parseSubtitles(srt, "srt")).toEqual<SubtitleCue[]>([
      { text: "First.", startSeconds: 1.0, endSeconds: 2.5 },
      { text: "Line one\nLine two", startSeconds: 60.25, endSeconds: 62.0 },
    ]);
  });

  it("parsesWebVTTHeaderCommentBlocksIdentifiersAndSettings", () => {
    const vtt = [
      "WEBVTT - Test file",
      "Kind: captions",
      "",
      "NOTE",
      "This comment block is skipped.",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "intro",
      "00:05.000 --> 00:07.500 align:start line:0",
      "<v Speaker><i>Styled</i> &amp; <00:00:06.500>timed</v>{\\an8}",
      "",
      "01:00:00.000 --> 01:00:01.000",
      "Escapes: &lt;tag&gt; &amp;lt;",
    ].join("\n");
    expect(parseSubtitles(vtt, "webVTT")).toEqual<SubtitleCue[]>([
      { text: "Styled & timed", startSeconds: 5.0, endSeconds: 7.5 },
      { text: "Escapes: <tag> &lt;", startSeconds: 3600.0, endSeconds: 3601.0 },
    ]);
  });

  it.each([
    ["1\n00:00:xx,000 --> 00:00:01,000\nBad start.", 2],
    ["1\n00:00:01,000 --> 00:00:01,000\nEnd not after start.", 2],
    ["1\n00:75:00,000 --> 00:76:00,000\nMinutes out of range.", 2],
    ["1\n00:00:01,0000 --> 00:00:02,000\nToo many millisecond digits.", 2],
    ["No timing line at all.", 1],
  ] as const)("malformedCueThrows %#", (srt, line) => {
    const e = parseError(srt, "srt");
    expect(e.kind).toBe("malformedCue");
    expect(e.line).toBe(line);
  });

  it("treatsKeywordPrefixedIdentifiersAsCuesNotComments", () => {
    const vtt = "WEBVTT\n\nNOTE123\n00:01.000 --> 00:02.000\nA cue, not a comment.\n";
    expect(parseSubtitles(vtt, "webVTT")).toEqual([{ text: "A cue, not a comment.", startSeconds: 1.0, endSeconds: 2.0 }]);
    expect(parseError("WEBVTTjunk\n\n00:01.000 --> 00:02.000\nBad header.", "webVTT").kind).toBe("missingWebVTTHeader");
  });

  it("rejectsCuesMissingTheirBlankLineSeparator", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nFirst.\n2\n00:00:03,000 --> 00:00:04,000\nSwallowed.\n";
    const e = parseError(srt, "srt");
    expect(e.kind).toBe("malformedCue");
    expect(e.line).toBe(5);
  });

  it("rejectsMissingHeaderEmptyFilesAndUnknownExtensions", () => {
    expect(parseError("00:00.000 --> 00:01.000\nNo header.", "webVTT").kind).toBe("missingWebVTTHeader");
    expect(parseError("", "srt").kind).toBe("noCues");
    expect(parseError("WEBVTT\n\nNOTE only comments here\n", "webVTT").kind).toBe("noCues");
    expect(subtitleFormatFromExtension("SRT")).toBe("srt");
    expect(subtitleFormatFromExtension("vtt")).toBe("webVTT");
    expect(subtitleFormatFromExtension("mov")).toBeUndefined();
  });
});

describe("SubtitleCueSpecTests", () => {
  const build = (cues: SubtitleCue[]) =>
    buildSubtitleCueSpecs(
      cues,
      { fps: 30, canvasWidth: 1920, canvasHeight: 1080, style: textStyleCaption(), center: { x: 0.5, y: 0.9 }, measure: fakeMeasure },
      testGroupId,
    );

  it("convertsCueSecondsToFramesInOneGroupClampingSubFrameCues", () => {
    const specs = build([
      { text: "one", startSeconds: 1.0, endSeconds: 2.5 },
      { text: "blip", startSeconds: 3.0, endSeconds: 3.01 },
    ]);
    expect(specs.map((s) => s.startFrame)).toEqual([30, 90]);
    expect(specs.map((s) => s.durationFrames)).toEqual([45, 1]);
    expect(specs.every((s) => s.transform !== undefined)).toBe(true);
    const groupId = specs[0].captionGroupId;
    expect(groupId).toBeDefined();
    expect(specs.every((s) => s.captionGroupId === groupId)).toBe(true);
  });

  it("resolvesOverlapsWithoutClosingGaps", () => {
    const specs = build([
      { text: "overlapping", startSeconds: 0, endSeconds: 1.0 },
      { text: "next", startSeconds: 0.9, endSeconds: 2.0 },
      { text: "after gap", startSeconds: 2.2, endSeconds: 3.0 },
    ]);
    expect(specs.map((s) => s.startFrame)).toEqual([0, 27, 66]);
    expect(specs.map((s) => s.durationFrames)).toEqual([27, 33, 24]);
  });
});
