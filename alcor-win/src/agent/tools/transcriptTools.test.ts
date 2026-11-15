import { afterEach, describe, expect, it } from "vitest";
import { makeMediaAsset, makeMulticamMember, makeMulticamSource } from "../../model";
import { setMediaIo } from "../../media/io";
import { makeFakeIo } from "../../media/fakeIo";
import { setup } from "../../editor/mutations/testFixtures";
import { ToolHarness, Fixtures } from "./testHarness";
import "./transcriptGroup";
import { mcpServerTools } from "./toolRegistry";
import {
  lastTranscriptSession, makeTranscriptSession, resolveTranscriptionScope, scopeCaptionRequest, scopeTargets,
  setLastTranscriptSession, setTranscriptionToolDeps, transcriptResponsePayload, transcriptSessionHasSameWordMapping,
  type TimelineWord, type TranscriptSession,
} from "./transcriptionTools";
import { normalizedWordMatch, parseWordMatches, parseWordSpans } from "./wordsTools";

const local = { provider: "openai", language: undefined };

afterEach(() => {
  setTranscriptionToolDeps(undefined);
  setMediaIo(undefined);
});

function setLastForTest(h: ToolHarness, session: TranscriptSession): void {
  setLastTranscriptSession(h.executor, session);
}

describe("remove_words — param validation", () => {
  it("rejectsEmptyWords", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    expect((await h.runRaw("remove_words", { words: [] })).isError).toBe(true);
  });

  it("parsesMixedSpans", () => {
    expect(parseWordSpans([3, [12, 18], 40])).toEqual([[3, 3], [12, 18], [40, 40]]);
  });

  it("parsesWordMatches", () => {
    expect(parseWordMatches(["Um,", " uh ", "HMM"])).toEqual(new Set(["um", "uh", "hmm"]));
    expect(normalizedWordMatch("\"Hello!\"")).toBe("hello");
  });

  it("rejectsEmptyMatches", () => {
    expect(() => parseWordMatches(["..."])).toThrow("expected a non-empty word");
  });

  it("rejectsRememberedScopeFromAnotherTimeline", async () => {
    const h = new ToolHarness();
    setLastForTest(h, makeTranscriptSession(h.editor, local, { kind: "automatic" }));
    const second = Fixtures.timeline();
    setup(h.editor, (e) => {
      e.doc.timelines.push(second);
      e.doc.activeTimelineId = second.id;
    });

    const result = await h.runRaw("remove_words", { words: [0] });

    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("different timeline");
    expect(ToolHarness.textOf(result)).toContain("Call get_transcript again");
  });

  it("rejectsRememberedScopeWhoseTrackDisappeared", async () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ id: "deleted-track", clips: [clip] })] }));
    setLastForTest(h, makeTranscriptSession(h.editor, local, { kind: "track", id: "deleted-track" }));
    setup(h.editor, (e) => {
      e.timeline.tracks = [];
    });

    const result = await h.runRaw("remove_words", { words: [0] });

    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("timeline sources");
    expect(ToolHarness.textOf(result)).toContain("Call get_transcript again");
  });

  it("textMatchesRecomputeAfterTimelineSourcesChange", async () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    setLastForTest(h, makeTranscriptSession(h.editor, local, { kind: "automatic" }));
    setup(h.editor, (e) => {
      e.timeline.tracks[0].clips[0].startFrame = 10;
    });

    const result = await h.runRaw("remove_words", { matches: ["um"] });

    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).not.toContain("timeline sources");
    expect(ToolHarness.textOf(result)).not.toContain("different timeline");
  });

  it("textMatchesFallBackToAutomaticOnAnotherTimeline", async () => {
    const h = new ToolHarness();
    setLastForTest(h, makeTranscriptSession(h.editor, local, { kind: "automatic" }));
    const second = Fixtures.timeline();
    setup(h.editor, (e) => {
      e.doc.timelines.push(second);
      e.doc.activeTimelineId = second.id;
    });

    const result = await h.runRaw("remove_words", { matches: ["um"] });

    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).not.toContain("different timeline");
  });

  it("wordMappingSnapshotIgnoresUnrelatedClipProperties", () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    const session = makeTranscriptSession(h.editor, local, { kind: "automatic" });

    setup(h.editor, (e) => {
      e.timeline.tracks[0].clips[0].volume = 0.5;
      e.timeline.tracks[0].clips[0].transform.centerX = 0.25;
    });
    expect(transcriptSessionHasSameWordMapping(session, h.editor)).toBe(true);

    setup(h.editor, (e) => {
      e.timeline.tracks[0].clips[0].trimStartFrame = 1;
    });
    expect(transcriptSessionHasSameWordMapping(session, h.editor)).toBe(false);
  });
});

describe("get_transcript — param tolerance", () => {
  // Empty timeline so the call returns an empty transcript without needing audio:
  // we only care that key validation accepts (or rejects) the params.

  it("toleratesWordTimestampsFromInspectMediaHabit", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    const result = await h.runRaw("get_transcript", { wordTimestamps: true });
    expect(result.isError).toBe(false);
  });

  it("stillRejectsGenuinelyUnknownKeys", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    expect((await h.runRaw("get_transcript", { bogusKey: true })).isError).toBe(true);
  });

  it("resolvesTrackIndexToStableTrackAndClipIds", () => {
    const first = Fixtures.clip({ id: "first", mediaType: "audio", start: 0, duration: 30 });
    const second = Fixtures.clip({ id: "second", mediaType: "audio", start: 30, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({
      tracks: [
        Fixtures.audioTrack({ id: "first-track", clips: [first] }),
        Fixtures.audioTrack({ id: "second-track", clips: [second] }),
      ],
    }));

    const scope = resolveTranscriptionScope(h.editor, { trackIndex: 1 }, "get_transcript");

    expect(scope).toEqual({ kind: "track", id: "second-track" });
    expect(scopeTargets(h.editor, scope).map((c) => c.id)).toEqual(["second"]);
    expect(scopeCaptionRequest(h.editor, scope).sourceClipIds).toEqual(["second"]);
  });

  it("explicitClipScopeCanChooseNonMasterMulticamMic", () => {
    const masterClip = Fixtures.clip({ id: "master", mediaRef: "lapel", mediaType: "audio", start: 0, duration: 100 });
    const roomClip = Fixtures.clip({ id: "room", mediaRef: "room", mediaType: "audio", start: 0, duration: 100 });
    masterClip.multicamGroupId = "group";
    roomClip.multicamGroupId = "group";
    const sync = { offsetSeconds: 0, confidence: 1, locked: false };
    const master = makeMulticamMember({ id: "master-member", mediaRef: "lapel", kind: "mic", angleLabel: "lapel", sync });
    const room = makeMulticamMember({ mediaRef: "room", kind: "mic", angleLabel: "room", sync });
    const h = new ToolHarness(Fixtures.timeline({
      tracks: [
        Fixtures.audioTrack({ id: "master-track", clips: [masterClip] }),
        Fixtures.audioTrack({ id: "room-track", clips: [roomClip] }),
      ],
    }));
    setup(h.editor, (e) => {
      e.doc.multicamGroups = [makeMulticamSource({ id: "group", name: "Interview", members: [master, room], masterMemberId: master.id })];
    });

    const scope = resolveTranscriptionScope(h.editor, { clipId: "room" }, "get_transcript");

    expect(scope).toEqual({ kind: "clips", ids: ["room"] });
    expect(scopeTargets(h.editor, scope).map((c) => c.id)).toEqual(["room"]);
  });

  it("trackIndexValidationIsSharedByTranscriptAndCaptions", async () => {
    const h = new ToolHarness(Fixtures.timeline());

    const transcript = await h.runRaw("get_transcript", { trackIndex: 4 });
    const captions = await h.runRaw("add_captions", { trackIndex: 4 });

    expect(transcript.isError).toBe(true);
    expect(captions.isError).toBe(true);
    expect(ToolHarness.textOf(transcript)).toContain("out of range");
    expect(ToolHarness.textOf(captions)).toContain("out of range");
  });

  it("trackIndexRejectsFractionalNumbers", async () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    const result = await h.runRaw("get_transcript", { trackIndex: 0.5 });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("must be an integer");
  });

  it("trackIndexAndClipIdAreMutuallyExclusive", async () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] }));
    const result = await h.runRaw("get_transcript", { trackIndex: 0, clipId: "voice" });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("either clipId or trackIndex");
  });

  it("videoScopesResolveToLinkedAudioPartners", () => {
    const video = Fixtures.clip({ id: "video", mediaRef: "media", mediaType: "video", start: 0, duration: 30 });
    const audio = Fixtures.clip({ id: "audio", mediaRef: "media", mediaType: "audio", start: 0, duration: 30 });
    video.linkGroupId = "linked";
    audio.linkGroupId = "linked";
    const h = new ToolHarness(Fixtures.timeline({
      tracks: [Fixtures.videoTrack({ clips: [video] }), Fixtures.audioTrack({ clips: [audio] })],
    }));

    // The linked partner shares media and timing, so both the clip and the video track resolve to it.
    expect(resolveTranscriptionScope(h.editor, { clipId: "video" }, "get_transcript")).toEqual({ kind: "clips", ids: ["audio"] });
    expect(resolveTranscriptionScope(h.editor, { trackIndex: 0 }, "get_transcript")).toEqual({ kind: "clips", ids: ["audio"] });
  });

  it("untranscribableScopeWithoutLinkedAudioStillErrors", async () => {
    const still = Fixtures.clip({ id: "still", mediaRef: "media", mediaType: "image", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [still] })] }));

    const byClip = await h.runRaw("get_transcript", { clipId: "still" });
    expect(byClip.isError).toBe(true);
    expect(ToolHarness.textOf(byClip)).toContain("no transcribable audio");

    const byTrack = await h.runRaw("get_transcript", { trackIndex: 0 });
    expect(byTrack.isError).toBe(true);
    expect(ToolHarness.textOf(byTrack)).toContain("no transcribable audio");
  });

  it("toleratesZeroFilledFrameWindow", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    const result = await h.runRaw("get_transcript", { startFrame: 0, endFrame: 0, granularity: "segments" });
    expect(result.isError).toBe(false);
  });

  it("transcriptSessionReplacesPriorTrackScope", async () => {
    const clip = Fixtures.clip({ id: "voice", mediaType: "audio", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.audioTrack({ id: "voice-track", clips: [clip] })] }));

    const selected = await h.runRaw("get_transcript", { trackIndex: 0 });
    expect(selected.isError).toBe(false);
    expect(lastTranscriptSession(h.executor)?.scope).toEqual({ kind: "track", id: "voice-track" });
    expect(lastTranscriptSession(h.executor)?.timelineId).toBe(h.editor.doc.activeTimelineId);

    const automatic = await h.runRaw("get_transcript");
    expect(automatic.isError).toBe(false);
    expect(lastTranscriptSession(h.executor)?.scope).toEqual({ kind: "automatic" });
    expect(lastTranscriptSession(h.executor)?.timelineId).toBe(h.editor.doc.activeTimelineId);
  });

  it("transcriptAndCaptionSchemasExposeTrackIndex", () => {
    for (const name of ["get_transcript", "add_captions"]) {
      const tool = mcpServerTools().find((t) => t.definition.name === name);
      const properties = tool?.definition.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(properties.trackIndex?.type).toBe("integer");
    }
  });

  it("addCaptionsSchemaExposesMaximumGapSeconds", () => {
    const tool = mcpServerTools().find((t) => t.definition.name === "add_captions");
    const properties = tool?.definition.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.maximumGapSeconds).toMatchObject({ type: "number", minimum: 0, maximum: 2 });
  });

  it("addCaptionsSchemaExposesLengthLimits", () => {
    const tool = mcpServerTools().find((t) => t.definition.name === "add_captions");
    const properties = tool?.definition.inputSchema.properties as Record<string, Record<string, unknown>>;
    for (const key of ["maxWords", "maxCharacters"]) {
      expect(properties[key]?.type).toBe("integer");
      expect(properties[key]?.minimum).toBe(1);
    }
  });

  it("addCaptionsRejectsInvalidMaxCharactersBeforeTranscription", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    for (const value of [0, -1, 1.5, "10", true]) {
      const result = await h.runRaw("add_captions", { maxCharacters: value });
      expect(result.isError).toBe(true);
      expect(ToolHarness.textOf(result)).toContain("maxCharacters");
    }
  });

  it("addCaptionsRejectsInvalidMaximumGapSecondsBeforeTranscription", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    for (const value of [-0.1, 2.1, "0.25", true, Number.POSITIVE_INFINITY]) {
      const result = await h.runRaw("add_captions", { maximumGapSeconds: value });
      expect(result.isError).toBe(true);
      expect(ToolHarness.textOf(result)).toContain("maximumGapSeconds");
    }
  });

  it("segmentsGranularityDeclaresSegmentFormat", async () => {
    const h = new ToolHarness(Fixtures.timeline());
    const json = await h.runOK("get_transcript", { granularity: "segments" });
    expect(json.segmentFormat).toEqual(["firstWordIndex", "text", "start", "end"]);
    expect(json.wordFormat).toBeUndefined();
    expect((await h.runRaw("get_transcript", { granularity: "sentences" })).isError).toBe(true);
  });

  it("usesNestedWordShape", async () => {
    // Words nest under clips with a hoisted wordFormat; there is no top-level words array.
    const h = new ToolHarness(Fixtures.timeline());
    const json = await h.runOK("get_transcript");
    expect(json.wordFormat).toEqual(["index", "text", "start"]);
    expect(Array.isArray(json.clips)).toBe(true);
    expect(json.words).toBeUndefined();
  });

  it("wordRowsSpeakerRunsAndSegments", () => {
    const w = (index: number, text: string, startFrame: number, endFrame: number, speaker: string): TimelineWord => ({
      index, clipId: "c1", trackIndex: 0, clipStartFrame: 0, clipEndFrame: 300, text, startFrame, endFrame, speaker,
    });
    const transcript = {
      context: local,
      words: [
        w(0, "Hello", 0, 10, "S1"), w(1, "there.", 10, 20, "S1"),
        w(2, "Hi", 60, 70, "S2"), w(3, "back.", 70, 80, "S2"),
        w(4, "Great", 90, 100, "S1"),
      ],
      skipped: [],
    };

    const words = transcriptResponsePayload(transcript, { fps: 30, maxWords: 100 });
    expect(words.wordFormat).toEqual(["index", "text", "start"]);
    const rows = (words.clips as Record<string, unknown>[])[0].words as unknown[][];
    expect(rows.length).toBe(5);
    expect(rows[0].length).toBe(3); // no per-word end, no speaker column
    // Speakers arrive as run-length turns keyed by word index.
    const runs = words.speakers as unknown[][];
    expect(runs.length).toBe(3);
    expect(runs[1][0]).toBe(2);
    expect(runs[1][1]).toBe("S2");

    const segs = transcriptResponsePayload(transcript, { fps: 30, maxWords: 100, segments: true });
    const segRows = (segs.clips as Record<string, unknown>[])[0].segments as unknown[][];
    // Sentence end, speaker change, and trailing run each flush: 3 segments.
    expect(segRows.length).toBe(3);
    expect(segRows[0][1]).toBe("Hello there.");
    expect(segRows[0][0]).toBe(0); // firstWordIndex handle
    expect(segRows[0][3]).toBe(20); // segment end retains real end frames
  });
});

describe("add_captions subtitleMediaRef", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld.\n";

  function registerSubtitleAsset(h: ToolHarness, id: string, contents: string): void {
    const io = makeFakeIo();
    io.addFile("/proj/captions.srt", contents);
    setMediaIo(io);
    setup(h.editor, (e) => {
      e.doc.mediaAssets.push(makeMediaAsset({ id, url: "/proj/captions.srt", type: "subtitle", name: "captions", duration: 4 }));
    });
  }

  it("placesSubtitleCuesAsCaptionsAtTheirTimecodesResolvingShortIds", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack()] }));
    registerSubtitleAsset(h, "AB107A6F-155C-417C-8776-41BFA1C3DF07", srt);

    // get_media hands out 8-character id prefixes; the tool must expand them.
    await h.runOK("add_captions", { subtitleMediaRef: "AB107A6F" });

    const captions = h.editor.timeline.tracks[0].clips;
    expect(captions.map((c) => c.textContent)).toEqual(["Hello.", "World."]);
    expect(captions.map((c) => c.startFrame)).toEqual([30, 90]);
    expect(captions.every((c) => c.captionGroupId !== undefined)).toBe(true);
  });

  it("rejectsCombinedOptionsWrongTypesAndMalformedFiles", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack()] }));
    h.addAsset({ id: "vid", type: "video" });
    registerSubtitleAsset(h, "bad", "garbage --> nonsense\nBroken.\n");

    const combined = await h.runRaw("add_captions", { subtitleMediaRef: "bad", maxWords: 3 });
    expect(ToolHarness.textOf(combined)).toContain("maxWords");

    // A non-string value must fail, not fall through to transcription.
    const nonString = await h.runRaw("add_captions", { subtitleMediaRef: 123 });
    expect(ToolHarness.textOf(nonString)).toContain("subtitleMediaRef");

    const wrongType = await h.runRaw("add_captions", { subtitleMediaRef: "vid" });
    expect(ToolHarness.textOf(wrongType)).toContain("not a subtitle file");

    const malformed = await h.runRaw("add_captions", { subtitleMediaRef: "bad" });
    expect(ToolHarness.textOf(malformed)).toContain("Malformed cue timing at line 1");

    expect(h.editor.timeline.tracks.flatMap((t) => t.clips).every((c) => c.mediaType !== "text")).toBe(true);
  });
});
