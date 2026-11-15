import { describe, expect, it } from "vitest";
import { fixtureClip, fixtureTimeline, fixtureVideoTrack } from "../model/fixtures";
import {
  captionFallbacks, filterTranscriptRows, transcriptDurationLabel, TranscriptTimelineIndex, type TimelineTranscriptRow,
} from "./transcriptBrowserModel";

const row = (id: string, text: string, start: number, duration = 10): TimelineTranscriptRow => ({
  id, clipId: "source", text, startFrame: start, endFrame: start + duration,
});

describe("TranscriptIndexTests", () => {
  it("formatsDurationToOneDecimalSecond", () => {
    expect(transcriptDurationLabel(30, 30)).toBe("1.0s");
    expect(transcriptDurationLabel(45, 30)).toBe("1.5s");
    expect(transcriptDurationLabel(10, 30)).toBe("0.3s");
  });

  it.each([[0, 30], [30, 0]])("rejectsInvalidDuration frames=%i fps=%i", (frames, fps) => {
    expect(transcriptDurationLabel(frames, fps)).toBeUndefined();
  });

  it("captionGroupProvidesFallbackRowsWithoutAudioTranscript", () => {
    const second = { ...fixtureClip({ id: "second", mediaRef: "text", mediaType: "text", start: 30, duration: 20 }), textContent: "Second cue", captionGroupId: "imported-vtt" };
    const first = { ...fixtureClip({ id: "first", mediaRef: "text", mediaType: "text", start: 0, duration: 20 }), textContent: "First cue", captionGroupId: "imported-vtt" };
    const translated = { ...fixtureClip({ id: "translated", mediaRef: "text", mediaType: "text", start: 0, duration: 20 }), textContent: "Premier sous-titre", captionGroupId: "translated-vtt" };
    const timeline = fixtureTimeline({ tracks: [fixtureVideoTrack({ clips: [second, first] }), fixtureVideoTrack({ clips: [translated] })] });

    const fallbacks = captionFallbacks(timeline);
    const fallback = fallbacks[0];

    expect(fallbacks.map((f) => f.sourceCaptionGroupId)).toEqual(["imported-vtt", "translated-vtt"]);
    expect(fallback.sourceTrackId).toBe(timeline.tracks[0].id);
    expect(fallback.sourceCaptionGroupId).toBe("imported-vtt");
    expect(fallback.rows.map((r) => r.text)).toEqual(["First cue", "Second cue"]);
  });

  it("searchMatchesTranscriptTextCaseInsensitively", () => {
    const rows = [row("first", "Opening line", 0), row("second", "A HIDDEN feature", 10), row("third", "Another hidden detail", 20)];
    expect(filterTranscriptRows(rows, " hidden ").map((r) => r.id)).toEqual(["second", "third"]);
  });

  it("currentRowUsesHalfOpenTimelineRanges", () => {
    const index = new TranscriptTimelineIndex([row("first", "First", 0), row("second", "Second", 10)]);
    expect(index.currentRow(-1)).toBeUndefined();
    expect(index.currentRow(0)?.id).toBe("first");
    expect(index.currentRow(9)?.id).toBe("first");
    expect(index.currentRow(10)?.id).toBe("second");
    expect(index.currentRow(19)?.id).toBe("second");
    expect(index.currentRow(20)).toBeUndefined();
  });

  it("currentRowFallsBackToEarlierOverlappingRow", () => {
    const index = new TranscriptTimelineIndex([row("long", "Long transcript", 0, 100), row("short", "Short transcript", 10, 5)]);
    expect(index.currentRow(14)?.id).toBe("short");
    expect(index.currentRow(15)?.id).toBe("long");
    expect(index.currentRow(99)?.id).toBe("long");
    expect(index.currentRow(100)).toBeUndefined();
  });
});
