// CostEstimatorLocalizationTests.swift ported to the USD estimate, plus the pricing maths.
import { describe, expect, it } from "vitest";
import { makeGenerationInput } from "../model";
import { audioCost, costForGenerationInput, formatUsd, imageCost, localizedEstimate, localizedGenerateLabel, upscaleCost, videoCost } from "./costEstimator";
import { audioEntry, imageEntry, upscaleEntry, videoEntry } from "./testFixtures";
import type { PriceHint } from "./providers/types";

const priced = <T extends { price?: PriceHint }>(e: T, price: PriceHint): T => ({ ...e, price });

describe("Cost estimator localization", () => {
  it("formats the estimate and generate label", () => {
    expect(localizedEstimate(1)).toBe("$1.00 estimated. Actual billing may differ.");
    expect(localizedGenerateLabel(0.5)).toBe("Generate · $0.50");
    expect(localizedGenerateLabel(undefined)).toBe("Generate");
  });
  it("tiny and missing amounts", () => {
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("Cost estimator", () => {
  it("video: per-second with resolution override; nothing without a price", () => {
    const m = priced(videoEntry("v"), { mode: "perSecond", usd: 0.1, byResolution: { "1080p": 0.2 } });
    expect(videoCost(m, { durationSeconds: 5, resolution: "1080p" })).toBeCloseTo(1);
    expect(videoCost(m, { durationSeconds: 5, resolution: "480p" })).toBeCloseTo(0.5);
    expect(videoCost(m, { durationSeconds: 0, resolution: undefined })).toBeUndefined();
    expect(videoCost(videoEntry("v"), { durationSeconds: 5, resolution: undefined })).toBeUndefined();
  });
  it("image: per image times count", () => {
    const m = priced(imageEntry("i"), { mode: "perImage", usd: 0.04 });
    expect(imageCost(m, { resolution: undefined, numImages: 3 })).toBeCloseTo(0.12);
  });
  it("audio: per thousand characters, per second and flat", () => {
    expect(audioCost(priced(audioEntry("a"), { mode: "perThousandChars", usd: 0.3 }), { prompt: "x".repeat(500), durationSeconds: undefined })).toBeCloseTo(0.15);
    expect(audioCost(priced(audioEntry("a"), { mode: "perThousandChars", usd: 0.3 }), { prompt: "", durationSeconds: undefined })).toBeUndefined();
    expect(audioCost(priced(audioEntry("a"), { mode: "perSecond", usd: 0.01 }), { prompt: "", durationSeconds: 30 })).toBeCloseTo(0.3);
    expect(audioCost(priced(audioEntry("a"), { mode: "flat", usd: 0.5 }), { prompt: "", durationSeconds: undefined })).toBe(0.5);
  });
  it("upscale: images are charged once regardless of duration", () => {
    const m = priced(upscaleEntry("u"), { mode: "perSecond", usd: 0.2 });
    expect(upscaleCost(m, { durationSeconds: 10 })).toBeCloseTo(2);
    expect(upscaleCost(m, { durationSeconds: 10, isImage: true })).toBeCloseTo(0.2);
  });
  it("recomputes from a stored input", () => {
    const m = priced(videoEntry("fal/v"), { mode: "perSecond", usd: 0.1 });
    const input = makeGenerationInput({ prompt: "p", model: "fal/v", duration: 4, aspectRatio: "16:9" });
    expect(costForGenerationInput(input, m)).toBeCloseTo(0.4);
    expect(costForGenerationInput(input, undefined)).toBeUndefined();
  });
});
