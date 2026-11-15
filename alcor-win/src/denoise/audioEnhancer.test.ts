import { describe, expect, it } from "vitest";
import { makeClip, makeEffect, clipDenoiseEffectType } from "../model";
import { Editor, makeEditorDocument } from "../editor/editor";
import { Fixtures, makeAsset } from "../editor/mutations/testFixtures";
import { makeFakeIo } from "../media/fakeIo";
import { interleaveFloat32, parseWavHeader, wavHeader, wavHeaderBytes } from "../ml/wav";
import { createAudioEnhancer, EnhanceError, wetFileName, type AudioEnhancer, type WavWriter } from "./audioEnhancer";
import type { DenoiseEngine, EnhancedAudio } from "./denoiseEngine";
import { clearDenoiseFailure, denoiseBaked, denoiseFailed, denoiseInFlight, enhanceAudioIfNeeded, forgetDenoise, wetPathFor } from "./denoiseState";

const cache = "/cache/EnhancedAudio";

function fixture(opts: { audio?: EnhancedAudio; fail?: boolean } = {}) {
  const io = makeFakeIo();
  io.addFile("/media/a.wav", new Uint8Array(1234), 5_000_000);
  let calls = 0;
  const engine: DenoiseEngine = {
    dispose() {},
    async enhance() {
      calls += 1;
      if (opts.fail) throw new Error("model exploded");
      return opts.audio ?? { planes: [new Float32Array([0.5, -0.5, 0.25]), new Float32Array([1, 1, 1])], sampleRate: 48000 };
    },
  };
  const written: { path: string; audio: EnhancedAudio }[] = [];
  const writeWav: WavWriter = async (path, audio) => {
    written.push({ path, audio });
    await io.writeBytes(path, new Uint8Array(wavHeaderBytes));
  };
  const enhancer = createAudioEnhancer({ engine: () => engine, io: async () => io, cacheDirectory: async () => cache, writeWav });
  return { io, enhancer, written, calls: () => calls };
}

describe("AudioEnhancer cache", () => {
  it("fileNameIsMediaRefSizeMtimeWet", () => {
    expect(wetFileName("ref", "1234_5")).toBe("ref_1234_5_wet.wav");
  });

  it("bakesOnceThenServesTheCachedFile", async () => {
    const { enhancer, written, calls, io } = fixture();
    expect(await enhancer.cachedDenoisedPath("/media/a.wav", "ref")).toBeUndefined();
    const path = await enhancer.denoisedAudio("/media/a.wav", "ref");
    expect(path).toBe(`${cache}/ref_1234_5000_wet.wav`);
    expect(io.has(path)).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toContain(".writing-");
    expect(io.has(written[0]?.path ?? "")).toBe(false);
    expect(await enhancer.cachedDenoisedPath("/media/a.wav", "ref")).toBe(path);
    expect(await enhancer.denoisedAudio("/media/a.wav", "ref")).toBe(path);
    expect(calls()).toBe(1);
  });

  it("replacingTheSourceBustsTheCacheAndRemovesStaleFiles", async () => {
    const { enhancer, io, calls } = fixture();
    const first = await enhancer.denoisedAudio("/media/a.wav", "ref");
    io.addFile("/other/untouched_1_1_wet.wav", "x");
    io.addFile(`${cache}/other_9_9_wet.wav`, "x");
    io.addFile("/media/a.wav", new Uint8Array(999), 7_000_000);
    expect(await enhancer.cachedDenoisedPath("/media/a.wav", "ref")).toBeUndefined();
    const second = await enhancer.denoisedAudio("/media/a.wav", "ref");
    expect(second).toBe(`${cache}/ref_999_7000_wet.wav`);
    expect(io.has(first)).toBe(false);
    expect(io.has(`${cache}/other_9_9_wet.wav`)).toBe(true);
    expect(calls()).toBe(2);
  });

  it("emptyOrRaggedAudioIsAnError", async () => {
    const empty = fixture({ audio: { planes: [], sampleRate: 48000 } });
    await expect(empty.enhancer.denoisedAudio("/media/a.wav", "ref")).rejects.toThrow("Source has no audio track");
    const ragged = fixture({ audio: { planes: [new Float32Array(3), new Float32Array(2)], sampleRate: 48000 } });
    await expect(ragged.enhancer.denoisedAudio("/media/a.wav", "ref")).rejects.toBeInstanceOf(EnhanceError);
  });
});

describe("wav writer helpers", () => {
  it("headerRoundTripsAndInterleaves", () => {
    const h = wavHeader(100, 2, 48000);
    expect(h.length).toBe(wavHeaderBytes);
    expect(parseWavHeader(h)).toEqual({ frames: 100, channels: 2, sampleRate: 48000 });
    expect(parseWavHeader(new Uint8Array(10))).toBeUndefined();
    const bytes = interleaveFloat32([new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])], 1, 2);
    expect(Array.from(new Float32Array(bytes.buffer))).toEqual([2, 5, 3, 6]);
  });
});

describe("denoise bake state", () => {
  function editorWith(denoise: boolean): { editor: Editor; clip: ReturnType<typeof makeClip> } {
    const clip = Fixtures.clip({ id: "c1", start: 0, duration: 30, mediaType: "audio", mediaRef: "state-ref" });
    if (denoise) clip.effects = [makeEffect({ type: clipDenoiseEffectType })];
    const doc = makeEditorDocument();
    const timeline = Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] });
    doc.timelines = [timeline];
    doc.activeTimelineId = timeline.id;
    doc.openTimelineIds = [timeline.id];
    doc.mediaAssets = [{ ...makeAsset({ id: "state-ref", type: "audio", duration: 3 }), url: "/media/a.wav" }];
    return { editor: new Editor(doc), clip };
  }

  it("bakesInTheBackgroundTracksInFlightAndRegistersTheWetFile", async () => {
    forgetDenoise("state-ref");
    const { editor, clip } = editorWith(true);
    const f = fixture();
    const done = enhanceAudioIfNeeded(editor, clip, f.enhancer);
    await done;
    expect(denoiseInFlight().has("state-ref")).toBe(false);
    expect(denoiseBaked().has("state-ref")).toBe(true);
    expect(wetPathFor("denoise:state-ref")).toBe(`${cache}/state-ref_1234_5000_wet.wav`);
    await enhanceAudioIfNeeded(editor, clip, f.enhancer);
    expect(f.calls()).toBe(1);
    forgetDenoise("state-ref");
  });

  it("failureIsRememberedUntilReEnabled", async () => {
    forgetDenoise("state-ref");
    const { editor, clip } = editorWith(true);
    const f = fixture({ fail: true });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await enhanceAudioIfNeeded(editor, clip, f.enhancer);
      expect(denoiseFailed().has("state-ref")).toBe(true);
      expect(denoiseBaked().has("state-ref")).toBe(false);
      await enhanceAudioIfNeeded(editor, clip, f.enhancer);
      expect(f.calls()).toBe(1);
      clearDenoiseFailure("state-ref");
      await enhanceAudioIfNeeded(editor, clip, f.enhancer);
      expect(f.calls()).toBe(2);
    } finally {
      console.error = originalError;
      forgetDenoise("state-ref");
    }
  });

  it("clipsWithoutDenoiseNeverBake", async () => {
    forgetDenoise("state-ref");
    const { editor, clip } = editorWith(false);
    const f = fixture();
    await enhanceAudioIfNeeded(editor, clip, f.enhancer);
    expect(f.calls()).toBe(0);
  });

  it("adoptsAnExistingCacheFileWithoutRunningTheModel", async () => {
    forgetDenoise("state-ref");
    const { editor, clip } = editorWith(true);
    const f = fixture();
    f.io.addFile(`${cache}/state-ref_1234_5000_wet.wav`, "wet");
    const enhancer: AudioEnhancer = f.enhancer;
    await enhanceAudioIfNeeded(editor, clip, enhancer);
    expect(f.calls()).toBe(0);
    expect(denoiseBaked().has("state-ref")).toBe(true);
    forgetDenoise("state-ref");
  });
});
