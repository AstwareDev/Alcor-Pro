import { describe, expect, it } from "vitest";
import { makeMediaAsset } from "../model";
import {
  aspectRatioDisplayLabel, billingDurationSeconds, nearestSupportedDurationIn, parseWxH, resolutionDisplayLabel,
  snappedUpscaleValue, upscaleAvailableOptions, upscaleDefaultSettings, upscaleNormalizedSettings, upscaleSupports,
  validateAudioParams, validateImage, validateVideo,
} from "./modelConfig";
import { audioEntry, imageEntry, minimaxH3, upscaleEntry, videoEntry } from "./testFixtures";

describe("video model rules", () => {
  it("validates duration, aspect ratio and resolution", () => {
    const m = minimaxH3();
    expect(validateVideo(m, 5, "16:9", "2K")).toBeUndefined();
    expect(validateVideo(m, 4, "16:9", "2K")).toContain("duration '4s'");
    expect(validateVideo(m, 5, "4:3", "2K")).toContain("aspect ratio '4:3'");
    expect(validateVideo(m, 5, "16:9", "4K")).toContain("resolution '4K'");
  });
  it("nearest supported duration and billing seconds", () => {
    expect(nearestSupportedDurationIn(7.4, [5, 10])).toBe(5);
    expect(nearestSupportedDurationIn(3, [])).toBe(3);
    const lip = videoEntry("lip", { supportsPrompt: false, requiresSourceVideo: true, requiresReferenceAudio: true });
    expect(billingDurationSeconds(lip, 9, 4.4)).toBe(4);
    expect(billingDurationSeconds(lip, 9, undefined)).toBeUndefined();
    expect(billingDurationSeconds(minimaxH3(), 0.2, undefined)).toBe(1);
  });
});

describe("image labels and validation", () => {
  it("labels", () => {
    expect(parseWxH("1920x1080")).toEqual([1920, 1080]);
    expect(resolutionDisplayLabel("1024x1024")).toBe("Square");
    expect(resolutionDisplayLabel("1920x1080")).toBe("Landscape 1080p");
    expect(resolutionDisplayLabel("1024x1536")).toBe("Portrait");
    expect(aspectRatioDisplayLabel("landscape_16_9")).toBe("Landscape 16:9");
    expect(aspectRatioDisplayLabel("square_hd")).toBe("Square HD");
    expect(aspectRatioDisplayLabel("16:9")).toBe("16:9");
  });
  it("validate", () => {
    const m = imageEntry("i", { maxImages: 6, supportsImageReference: false });
    expect(validateImage(m, { aspectRatio: "1:1", resolution: undefined, quality: undefined, imageRefCount: 1, numImages: 1 })).toContain("does not accept reference images");
    expect(validateImage(m, { aspectRatio: "1:1", resolution: undefined, quality: undefined, imageRefCount: 0, numImages: 5 })).toContain("1…4 images");
  });
});

describe("audio validation", () => {
  it("prompt length, voice and language", () => {
    const m = audioEntry("tts", { minPromptLength: 3, voices: ["a", "b"], targetLanguages: ["en", "fr"] });
    expect(validateAudioParams(m, { prompt: "hi", targetLanguage: "en" })).toContain("requires prompt ≥ 3");
    expect(validateAudioParams(m, { prompt: "hello", voice: "z", targetLanguage: "en" })).toContain("voice 'z'");
    expect(validateAudioParams(m, { prompt: "hello" })).toBe("Choose a target language.");
    expect(validateAudioParams(m, { prompt: "hello", voice: "a", targetLanguage: "fr" })).toBeUndefined();
  });
});

describe("upscale rules", () => {
  const m = upscaleEntry("up", {
    maximumUpscaleFactor: 2,
    selectSettings: [
      { key: "targetResolution", label: "Resolution", options: ["1080p", "4k"], defaultValue: "4k" },
      { key: "targetFPS", label: "FPS", options: ["source", "30", "60"], defaultValue: "source" },
    ],
  });
  const source = (w: number, h: number, fps: number) => {
    const a = makeMediaAsset({ url: "/x.mp4", type: "video", name: "x", duration: 4 });
    a.sourceWidth = w;
    a.sourceHeight = h;
    a.sourceFPS = fps;
    return a;
  };
  it("limits resolution options by the maximum factor and fps by the source", () => {
    const sel = m.uiCapabilities.selectSettings ?? [];
    expect(upscaleAvailableOptions(m, sel[0], source(1920, 1080, 24))).toEqual(["1080p", "4k"]);
    expect(upscaleAvailableOptions(m, sel[0], source(1280, 720, 24))).toEqual(["1080p"]);
    expect(upscaleAvailableOptions(m, sel[1], source(1920, 1080, 30))).toEqual(["source", "60"]);
    expect(upscaleAvailableOptions(m, sel[1], source(1920, 1080, 90))).toEqual(["60"]);
  });
  it("normalizes a selection that is no longer available", () => {
    const settings = upscaleNormalizedSettings(m, upscaleDefaultSettings(m), source(1280, 720, 24));
    expect(settings.selections["targetResolution"]).toBe("1080p");
  });
  it("supports() rejects unsupported types", () => {
    expect(upscaleSupports(m, source(1920, 1080, 24))).toBe(true);
    expect(upscaleSupports(m, makeMediaAsset({ url: "/a.wav", type: "audio", name: "a" }))).toBe(false);
  });
  it("snaps numeric values", () => {
    expect(snappedUpscaleValue(0.37, 0, 1, 0.25)).toBe(0.25);
    expect(snappedUpscaleValue(5, 0, 1, 0.25)).toBe(1);
  });
});
