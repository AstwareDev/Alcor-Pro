import { describe, expect, it } from "vitest";
import { decodeMediaManifest, decodeProjectFileText, Project } from "../model";
import { MemoryFileSystem } from "../project/memoryFileSystem";
import { buildGeneratedSample } from "./generatedSample";
import { materializeSample, sampleProjectList, type SampleDeps } from "./sampleProjects";
import { synthPng, synthWav } from "./syntheticMedia";

describe("generated sample", () => {
  const built = buildGeneratedSample();

  it("roundTripsThroughTheProjectCodecs", () => {
    const file = decodeProjectFileText(JSON.stringify(built.project));
    expect(file.timelines).toHaveLength(1);
    expect(file.activeTimelineId).toBe(file.timelines[0]?.id);
    expect(decodeMediaManifest(JSON.parse(JSON.stringify(built.manifest))).entries).toHaveLength(3);
  });

  it("everyMediaClipPointsAtAManifestEntryWhoseFileIsGenerated", () => {
    const ids = new Set(built.manifest.entries.map((e) => e.id));
    const paths = new Set(built.files.map((f) => f.relativePath));
    for (const entry of built.manifest.entries) expect("project" in entry.source && paths.has(entry.source.project.relativePath)).toBe(true);
    const clips = built.project.timelines.flatMap((t) => t.tracks.flatMap((track) => track.clips));
    for (const clip of clips) expect(clip.mediaType === "text" ? clip.mediaRef === "" : ids.has(clip.mediaRef)).toBe(true);
  });

  it("usesTitlesAnimatedTextAShapeSolidsAndAudioAndFitsTheTimeline", () => {
    const timeline = built.project.timelines[0];
    const clips = timeline?.tracks.flatMap((t) => t.clips) ?? [];
    expect(clips.some((c) => c.mediaType === "text" && c.textAnimation?.preset === "typewriter")).toBe(true);
    expect(clips.some((c) => c.textStyle?.background.enabled === true)).toBe(true);
    expect(clips.filter((c) => c.mediaType === "image")).toHaveLength(2);
    expect(clips.some((c) => c.mediaType === "audio")).toBe(true);
    for (const track of timeline?.tracks ?? []) {
      let end = 0;
      for (const clip of [...track.clips].sort((a, b) => a.startFrame - b.startFrame)) {
        expect(clip.startFrame).toBeGreaterThanOrEqual(end);
        end = clip.startFrame + clip.durationFrames;
      }
      expect(end).toBeLessThanOrEqual(240);
    }
  });

  it("buildsAFreshPackageThroughTheSamplePipeline", async () => {
    const fs = new MemoryFileSystem();
    const deps: SampleDeps = { fs, cacheRoot: async () => "/app/Samples", fetchText: async () => "", download: async () => undefined };
    const sample = sampleProjectList[0];
    if (!sample) throw new Error("no sample");
    const path = await materializeSample(deps, sample);
    expect(await fs.exists(`${path}/${Project.timelineFilename}`)).toBe(true);
    expect(await fs.exists(`${path}/media/arpeggio.wav`)).toBe(true);
  });
});

async function inflate(zlib: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([zlib.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("synthWav", () => {
  it("writesAPcmHeaderThatMatchesItsLength", () => {
    const wav = synthWav([{ at: 0, seconds: 0.5, hz: 440, gain: 0.5 }], 1, 8000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(8000 * 2);
    expect(wav.length).toBe(44 + 8000 * 2);
  });

  it("isAudibleWithoutClipping", () => {
    const wav = synthWav([{ at: 0.1, seconds: 0.5, hz: 440, gain: 1 }], 1, 8000);
    const view = new DataView(wav.buffer);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeGreaterThan(5000);
    expect(peak).toBeLessThan(32767);
  });
});

describe("synthPng", () => {
  it("isAValidPngWhosePixelsInflateBack", async () => {
    const png = synthPng(3, 2, (x, y) => [x * 10, y * 100, 7]);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([3, 2]);
    const idatLength = view.getUint32(33);
    const raw = await inflate(png.subarray(41, 41 + idatLength));
    expect([...raw]).toEqual([0, 0, 0, 7, 10, 0, 7, 20, 0, 7, 0, 0, 100, 7, 10, 100, 7, 20, 100, 7]);
  });

  it("splitsLargeImagesAcrossStoredBlocks", async () => {
    const png = synthPng(200, 200, () => [1, 2, 3]);
    const length = new DataView(png.buffer).getUint32(33);
    expect((await inflate(png.subarray(41, 41 + length))).length).toBe(200 * (1 + 600));
  });
});
