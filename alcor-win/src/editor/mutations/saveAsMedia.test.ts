import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeIo, type FakeIo } from "../../media/fakeIo";
import { setMediaIo } from "../../media/io";
import type { MediaProbe } from "../../media/probe";
import { makeClip } from "../../model";
import { Editor } from "../editor";
import { linkClips } from "./linking";
import { audioClipForExtraction, canExtractAudio, clipRangeTimeline, extractAudioFromAssets, saveClipAsMedia, saveTimelineRangeAsMedia, type RenderJob, type SaveAsMediaServices } from "./saveAsMedia";
import { Fixtures, makeAsset, makeEditor } from "./testFixtures";

vi.mock("../../media/probe", () => ({
  probeMedia: async (): Promise<MediaProbe> => ({ ok: true, kind: "video", canDecode: true, duration: 2, hasAudio: true, hasVideo: true }),
}));

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

function setup(): Editor {
  const video = Fixtures.clip({ id: "v", mediaRef: "a", mediaType: "video", start: 0, duration: 60, trimStart: 30, speed: 2 });
  const audio = makeClip({ id: "au", mediaRef: "a", mediaType: "audio", sourceClipType: "video", startFrame: 0, durationFrames: 60, trimStartFrame: 30, speed: 2 });
  const editor = makeEditor([Fixtures.videoTrack({ clips: [video] }), Fixtures.audioTrack({ clips: [audio] })]);
  editor.projectPath = "/proj/p.palmier";
  editor.withoutRegistration(() => {
    editor.doc.mediaAssets.push(makeAsset({ id: "a", type: "video", duration: 4, hasAudio: true, sourceWidth: 1281, sourceHeight: 721 }));
  });
  return editor;
}

function fakeServices(jobs: RenderJob[], fail?: string): SaveAsMediaServices {
  return {
    async render(job, dest) {
      jobs.push(job);
      if (fail) throw new Error(fail);
      await io.writeBytes(dest, new Uint8Array([1, 2, 3]));
    },
  };
}

describe("clipRangeTimeline", () => {
  it("bakesTrimAndSpeedAtSourceResolutionWithSourceAudio", () => {
    const editor = setup();
    const t = clipRangeTimeline(editor, { mediaRef: "a", mediaType: "video", trimStartFrame: 30, durationFrames: 60, speed: 2 });
    expect([t.width, t.height]).toEqual([1280, 720]);
    expect(t.tracks.map((x) => x.type)).toEqual(["video", "audio"]);
    const clip = t.tracks[0].clips[0];
    expect([clip.startFrame, clip.durationFrames, clip.trimStartFrame, clip.speed]).toEqual([0, 60, 30, 2]);
  });

  it("audioRangeHasOnlyAnAudioTrack", () => {
    const t = clipRangeTimeline(setup(), { mediaRef: "a", mediaType: "audio", trimStartFrame: 0, durationFrames: 10, speed: 1 });
    expect(t.tracks.map((x) => x.type)).toEqual(["audio"]);
  });
});

describe("audio extraction eligibility", () => {
  it("videoClipUsesItsLinkedAudioPartner", () => {
    const editor = setup();
    linkClips(editor, new Set(["v", "au"]));
    expect(audioClipForExtraction(editor, "v")?.id).toBe("au");
    expect(audioClipForExtraction(editor, "au")?.id).toBe("au");
  });

  it("unlinkedVideoClipExtractsFromItsOwnAsset", () => {
    const editor = setup();
    expect(audioClipForExtraction(editor, "v")?.id).toBe("v");
    expect(audioClipForExtraction(editor, "au")).toBeUndefined();
  });

  it("assetNeedsVideoWithAudio", () => {
    const editor = setup();
    const silent = makeAsset({ id: "s", type: "video", duration: 1, hasAudio: false });
    expect(canExtractAudio(editor, editor.mediaAsset("a") ?? silent)).toBe(true);
    expect(canExtractAudio(editor, silent)).toBe(false);
  });
});

describe("installing rendered media", () => {
  it("savesAClipAsAProjectAssetNamedClip", async () => {
    const editor = setup();
    const jobs: RenderJob[] = [];
    await saveClipAsMedia(editor, "v", fakeServices(jobs));
    const saved = editor.mediaAssets.find((a) => a.name === "a (clip)");
    expect(saved?.type).toBe("video");
    expect(saved?.generationStatus.kind).toBe("none");
    expect(saved?.url.split("\\").join("/")).toMatch(/^\/proj\/p\.palmier\/media\/clip-[0-9A-F]{8}\.mp4$/);
    expect(jobs[0].options.audioOnly).toBeUndefined();
    expect(io.has(saved?.url ?? "")).toBe(true);
  });

  it("extractAudioFromAssetsWritesAnM4aNamedAudioInTheSourceFolder", async () => {
    const editor = setup();
    editor.withoutRegistration(() => {
      const a = editor.doc.mediaAssets.find((x) => x.id === "a");
      if (a) a.folderId = "f1";
    });
    const jobs: RenderJob[] = [];
    await extractAudioFromAssets(editor, ["a"], fakeServices(jobs));
    const saved = editor.mediaAssets.find((a) => a.name === "a (audio)");
    expect(saved?.type).toBe("audio");
    expect(saved?.folderId).toBe("f1");
    expect(saved?.url).toMatch(/\.m4a$/);
    expect(jobs[0].options.audioOnly).toBe(true);
  });

  it("aFailedRenderLeavesAFailedPlaceholder", async () => {
    const editor = setup();
    await saveClipAsMedia(editor, "v", fakeServices([], "boom"));
    const failed = editor.mediaAssets.find((a) => a.name === "a (clip)");
    expect(failed?.generationStatus).toEqual({ kind: "failed", message: "boom" });
  });

  it("savesTheSelectedRangeAsATimelineRangeVideo", async () => {
    const editor = setup();
    editor.ui.selectedTimelineRange = { startFrame: 10, endFrame: 40 };
    const jobs: RenderJob[] = [];
    await saveTimelineRangeAsMedia(editor, fakeServices(jobs));
    expect(editor.mediaAssets.some((a) => a.name === "Timeline range" && a.type === "video")).toBe(true);
    expect(jobs[0].options.range).toEqual({ startFrame: 10, endFrame: 40 });
  });

  it("doesNothingWithoutARange", async () => {
    const editor = setup();
    const jobs: RenderJob[] = [];
    await saveTimelineRangeAsMedia(editor, fakeServices(jobs));
    expect(jobs).toHaveLength(0);
  });
});
