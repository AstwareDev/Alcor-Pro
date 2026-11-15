import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { makeFakeIo, type FakeIo } from "../../media/fakeIo";
import { setMediaIo } from "../../media/io";
import { createFolder, moveAssetsToFolder } from "../../media/library";
import type { MediaAsset } from "../../model";
import type { TranscriptionResult } from "../../transcription/transcription";
import { setInspectBackend, type InspectMediaBackend, type InspectTranscribeRequest } from "./inspectBackend";
import { manifestEntry, transcriptOf } from "./mediaTestSupport";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => {
  setMediaIo(undefined);
  setInspectBackend(undefined);
});

/** Like the Swift `makeAsset`: also registers a manifest entry so library reads (get_media) see it. */
function makeLibraryAsset(h: ToolHarness, name: string, type: "video" | "audio" | "image" = "video", duration = 5): MediaAsset {
  const asset = h.addAsset({ type, duration });
  h.editor.withoutRegistration(() => {
    const draft = h.editor.doc.mediaAssets.find((a) => a.id === asset.id);
    if (draft) draft.name = name;
    h.editor.doc.mediaManifest.entries.push(manifestEntry({ id: asset.id, name, type, path: asset.url, duration }));
  });
  return asset;
}

describe("get_media", () => {
  it("getMediaOnEmptyManifestReturnsEmptyAssets", async () => {
    const h = new ToolHarness();
    const json = await h.runOK("get_media");
    expect(json.assets).toEqual([]);
    const timelines = json.timelines as Json[];
    expect(timelines.length).toBe(1);
    expect(timelines[0].active).toBe(true);
  });

  it("getMediaIdentifiesEnhanceableDrafts", async () => {
    const h = new ToolHarness();
    const asset = makeLibraryAsset(h, "Draft");
    h.editor.withoutRegistration(() => {
      const entry = h.editor.doc.mediaManifest.entries.find((e) => e.id === asset.id);
      if (entry) {
        entry.generationInput = {
          prompt: "Draft", model: "flux-3", duration: 8, aspectRatio: "16:9", resolution: "720p", draft: true,
          backendJobId: "draft-job", resultURLs: ["video", "cache"],
        };
      }
    });
    const json = await h.runOK("get_media", { ids: [asset.id] });
    const result = (json.assets as Json[])[0];
    expect(result.draft).toBe(true);
    expect(result.canEnhanceDraft).toBe(true);
  });

  it("getMediaRoundsFloatingPointNumbersToThreeDecimalPlaces", async () => {
    const h = new ToolHarness();
    h.editor.withoutRegistration(() => {
      h.editor.doc.mediaManifest.entries = [
        manifestEntry({
          id: "asset-1", name: "Clip", type: "video", path: "/tmp/media.mov", duration: 12.3456789,
          generationInput: { prompt: "Generate", model: "model-1", duration: 5, aspectRatio: "16:9" },
          sourceWidth: 1920, sourceHeight: 1080, sourceFPS: 29.97002997, hasAudio: true,
        }),
      ];
    });
    const raw = ToolHarness.textOf(await h.runRaw("get_media"));
    expect(/-?\d+\.\d{4,}/.test(raw)).toBe(false);
    const entry = (JSON.parse(raw).assets as Json[])[0];
    expect(entry.durationSeconds).toBe(12.346);
    expect(entry.fps).toBe(29.97);
    expect(entry.prompt).toBe("Generate");
    expect(entry.generationInput).toBeUndefined();
    expect(entry.source).toBeUndefined();
  });

  it("getMediaReportsFolderPathsAndScopesByFolder", async () => {
    const h = new ToolHarness();
    const refs = createFolder(h.editor, "Refs");
    const sub = createFolder(h.editor, "Sub", refs);
    const inSub = makeLibraryAsset(h, "a");
    makeLibraryAsset(h, "b");
    moveAssetsToFolder(h.editor, new Set([inSub.id]), sub);

    const json = await h.runOK("get_media");
    expect(json.folders).toEqual(["Refs", "Refs/Sub"]);
    const filed = (json.assets as Json[]).find((a) => a.name === "a");
    expect(filed?.folder).toBe("Refs/Sub");

    const scoped = await h.runOK("get_media", { folder: "Refs" });
    const scopedAssets = scoped.assets as Json[];
    expect(scopedAssets.length).toBe(1);
    expect(scopedAssets[0].name).toBe("a");
    expect(scoped.timelines).toBeUndefined();
  });

  it("getMediaIdsFilterReturnsOnlyThoseAssets", async () => {
    const h = new ToolHarness();
    const a = makeLibraryAsset(h, "a");
    makeLibraryAsset(h, "b");
    const json = await h.runOK("get_media", { ids: [a.id] });
    const assets = json.assets as Json[];
    expect(assets.length).toBe(1);
    expect(a.id.startsWith(assets[0].id as string)).toBe(true);
  });

  it("pendingFilterReturnsUnresolvedAssetsWithStatus", async () => {
    const h = new ToolHarness();
    makeLibraryAsset(h, "done");
    const busy = makeLibraryAsset(h, "busy");
    h.editor.withoutRegistration(() => {
      const entry = h.editor.doc.mediaManifest.entries.find((e) => e.id === busy.id);
      if (entry) entry.generationStatus = "downloading";
    });
    const json = await h.runOK("get_media", { pending: true });
    const assets = json.assets as Json[];
    expect(assets.length).toBe(1);
    expect(assets[0].generationStatus).toBe("downloading");
    expect(json.timelines).toBeUndefined();
  });

  it("rejectsUnknownKeysAndMissingFolder", async () => {
    const h = new ToolHarness();
    expect((await h.runRaw("get_media", { bogus: 1 })).isError).toBe(true);
    const missing = await h.runRaw("get_media", { folder: "Nope" });
    expect(missing.isError).toBe(true);
    expect(ToolHarness.textOf(missing)).toContain("Folder not found: 'Nope'");
  });
});

function installBackend(options: { transcript?: TranscriptionResult; transcribeError?: string } = {}) {
  const transcribeCalls: InspectTranscribeRequest[] = [];
  const frameTimes: number[][] = [];
  const backend: InspectMediaBackend = {
    readImage: async () => ({ base64: "SU1H", mime: "image/png", encodedByteSize: 3, pixelWidth: 4, pixelHeight: 2 }),
    videoFrames: async (_path, times) => {
      frameTimes.push([...times]);
      return times.map((t) => ({ timestamp: t, base64: "RlJN" }));
    },
    overview: async () => ({ base64: "U0hU", timestamps: [0.5, 12.34567] }),
    transcribe: async (req) => {
      transcribeCalls.push(req);
      if (options.transcribeError !== undefined) throw new Error(options.transcribeError);
      return options.transcript ?? transcriptOf([["hello there", 0, 1.234, ["hello", "there"]]]);
    },
  };
  setInspectBackend(backend);
  return { transcribeCalls, frameTimes };
}

describe("inspect_media", () => {
  it("rejectsBadArgsAndMissingFiles", async () => {
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video", duration: 5 });
    expect((await h.runRaw("inspect_media", {})).isError).toBe(true);
    expect((await h.runRaw("inspect_media", { mediaRef: "nope" })).isError).toBe(true);
    expect((await h.runRaw("inspect_media", { mediaRef: a.id, bogus: 1 })).isError).toBe(true);
    const missing = await h.runRaw("inspect_media", { mediaRef: a.id });
    expect(ToolHarness.textOf(missing)).toBe(`Media file not on disk: ${a.id.slice(0, 8)}`);
    h.editor.withoutRegistration(() => {
      const draft = h.editor.doc.mediaAssets.find((x) => x.id === a.id);
      if (draft) draft.generationStatus = { kind: "generating" };
    });
    expect(ToolHarness.textOf(await h.runRaw("inspect_media", { mediaRef: a.id }))).toBe(
      `Asset ${a.id.slice(0, 8)} is still generating. Poll get_media and retry once generationStatus becomes 'none'.`,
    );
  });

  it("imageReturnsStillAndMetadata", async () => {
    installBackend();
    const h = new ToolHarness();
    const a = h.addAsset({ type: "image", duration: 5 });
    io.addFile(a.url, "xxxx");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ kind: "image", base64: "SU1H", mediaType: "image/png" });
    const meta = JSON.parse(ToolHarness.allText({ content: [result.content[1]], isError: false })) as Json;
    expect(meta.mimeType).toBe("image/png");
    expect(meta.byteSize).toBe(4);
    expect(meta.coordinateGrid).toBe("0-1, origin top-left");
    expect(meta.imageProperties).toEqual({ pixelWidth: 4, pixelHeight: 2 });
  });

  it("videoSamplesFramesAcrossWindowAndTranscribes", async () => {
    const { transcribeCalls, frameTimes } = installBackend();
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video", duration: 10, hasAudio: true });
    io.addFile(a.url, "x");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id, maxFrames: 4, startSeconds: 2, endSeconds: 6 });
    expect(result.isError).toBe(false);
    expect(frameTimes[0]).toEqual([2.5, 3.5, 4.5, 5.5]);
    expect(result.content.filter((b) => b.kind === "image").length).toBe(4);
    const meta = JSON.parse(ToolHarness.allText(result)) as Json;
    expect(meta.timeRange).toEqual([2, 6]);
    expect(meta.frameTimestamps).toEqual([2.5, 3.5, 4.5, 5.5]);
    expect((meta.transcription as Json).segments).toEqual([["hello there", 0, 1.23]]);
    expect((meta.transcription as Json).timing).toBe("sourceSeconds");
    expect(transcribeCalls[0].range).toEqual({ start: 2, end: 6 });
  });

  it("videoClampsFrameCountAndReportsTranscriptionError", async () => {
    const { frameTimes } = installBackend({ transcribeError: "no key" });
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video", duration: 10, hasAudio: true });
    io.addFile(a.url, "x");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id, maxFrames: 99 });
    expect(frameTimes[0].length).toBe(12);
    const meta = JSON.parse(ToolHarness.allText(result)) as Json;
    expect(meta.transcriptionError).toBe("no key");
    expect(meta.transcription).toBeUndefined();
  });

  it("videoWithoutAudioSkipsTranscription", async () => {
    const { transcribeCalls } = installBackend();
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video", duration: 10, hasAudio: false });
    io.addFile(a.url, "x");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id });
    expect(result.isError).toBe(false);
    expect(transcribeCalls.length).toBe(0);
  });

  it("overviewReturnsStoryboard", async () => {
    installBackend();
    const h = new ToolHarness();
    const a = h.addAsset({ type: "video", duration: 10 });
    io.addFile(a.url, "x");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id, overview: true });
    expect(result.content[0]).toEqual({ kind: "image", base64: "U0hU", mediaType: "image/jpeg" });
    const meta = JSON.parse(ToolHarness.allText(result)) as Json;
    expect(meta.overview).toEqual({ tileTimestamps: [0.5, 12.346] });
    expect(meta.coordinateGrid).toBeUndefined();
  });

  it("audioTranscriptionMapsToClipFrames", async () => {
    installBackend({ transcript: transcriptOf([["one two", 1, 2, ["one", "two"]], ["later", 100, 101, ["later"]]]) });
    const clip = Fixtures.clip({ id: "clip", start: 30, duration: 90 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    const a = h.addAsset({ type: "audio", duration: 200 });
    h.editor.withoutRegistration(() => {
      h.editor.timeline.tracks[0].clips[0].mediaRef = a.id;
    });
    io.addFile(a.url, "x");
    const result = await h.runOK("inspect_media", { mediaRef: a.id, clipId: "clip", wordTimestamps: true });
    expect(result.timelineMapping).toMatchObject({ clipId: "clip", clipStartFrame: 30, clipEndFrame: 120, fps: 30 });
    expect(result.timing).toBe("projectFrames");
    expect(result.segments).toEqual([["one two", 60, 90]]);
    expect(result.words).toEqual([["one", 60, 75], ["two", 75, 90]]);
  });

  it("rejectsClipForOtherMediaAndInvalidRange", async () => {
    installBackend();
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));
    const a = h.addAsset({ type: "audio", duration: 5 });
    io.addFile(a.url, "x");
    const other = await h.runRaw("inspect_media", { mediaRef: a.id, clipId: "clip" });
    expect(ToolHarness.textOf(other)).toContain("does not reference mediaRef");
    expect(ToolHarness.textOf(await h.runRaw("inspect_media", { mediaRef: a.id, clipId: "zzz" }))).toBe("Clip not found: zzz");
    const range = await h.runRaw("inspect_media", { mediaRef: a.id, startSeconds: 4, endSeconds: 2 });
    expect(ToolHarness.textOf(range)).toBe("Invalid time range [4.0, 2.0] for media of duration 5.0s");
  });

  it("audioTranscriptionFailureIsAnError", async () => {
    installBackend({ transcribeError: "boom" });
    const h = new ToolHarness();
    const a = h.addAsset({ type: "audio", duration: 5 });
    io.addFile(a.url, "x");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toBe("Transcription failed: boom");
  });

  it("subtitleListsCues", async () => {
    const h = new ToolHarness();
    const a = h.addAsset({ type: "subtitle", duration: 4 });
    h.editor.withoutRegistration(() => {
      const draft = h.editor.doc.mediaAssets.find((x) => x.id === a.id);
      if (draft) draft.url = "/tmp/subs.srt";
    });
    io.addFile("/tmp/subs.srt", "1\n00:00:01,000 --> 00:00:02,500\nHi there\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n");
    const result = await h.runOK("inspect_media", { mediaRef: a.id });
    expect(result.cueCount).toBe(2);
    expect(result.cues).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: "Hi there" },
      { startSeconds: 3, endSeconds: 4, text: "Bye" },
    ]);
  });

  it("lottieReportsUnsupportedInsteadOfFakingFrames", async () => {
    const h = new ToolHarness();
    const a = h.addAsset({ type: "lottie", duration: 2 });
    io.addFile(a.url, "{}");
    const result = await h.runRaw("inspect_media", { mediaRef: a.id });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Lottie rendering isn't available");
  });
});
