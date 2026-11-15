import { describe, expect, it } from "vitest";
import { makeEffect, makeEffectParam, clipDenoiseEffectType, type Clip } from "../model";
import { Fixtures, makeAsset } from "../editor/mutations/testFixtures";
import { buildAudioGraph, type FrameGraphDocument } from "../preview/frameGraph";
import { blendGains, denoiseStrength, dryMediaRef, hasWetTwin, isWetMediaRef, splitDenoiseSource, wetMediaRef } from "./denoiseMix";

function denoised(amount: number | undefined, enabled = true): Clip {
  const clip = Fixtures.clip({ id: "c", start: 0, duration: 90, mediaType: "audio", mediaRef: "m" });
  clip.effects = [makeEffect({ type: clipDenoiseEffectType, enabled, params: amount === undefined ? {} : { amount: makeEffectParam({ value: amount }) } })];
  return clip;
}

function doc(clip: Clip): FrameGraphDocument {
  const timeline = Fixtures.timeline({ tracks: [Fixtures.audioTrack({ clips: [clip] })] });
  return { timelines: [timeline], mediaAssets: [makeAsset({ id: "m", type: "audio", duration: 10 })] };
}

const wet = new Set(["m"]);

describe("denoise dry/wet mixing", () => {
  it("strengthIsClampedAmountOnlyWhenEnabled", () => {
    expect(denoiseStrength(denoised(0.25))).toBeCloseTo(0.25);
    expect(denoiseStrength(denoised(undefined))).toBeCloseTo(0.6);
    expect(denoiseStrength(denoised(1.7))).toBe(1);
    expect(denoiseStrength(denoised(-3))).toBe(0);
    expect(denoiseStrength(denoised(0.9, false))).toBe(0);
  });

  it("gainsAreComplementary", () => {
    const { dry, wet: w } = blendGains(0.8, 0.25);
    expect(dry).toBeCloseTo(0.6);
    expect(w).toBeCloseTo(0.2);
    expect(dry + w).toBeCloseTo(0.8);
    expect(blendGains(1, 0)).toEqual({ dry: 1, wet: 0 });
    expect(blendGains(1, 1)).toEqual({ dry: 0, wet: 1 });
  });

  it("wetRefsRoundTrip", () => {
    expect(isWetMediaRef(wetMediaRef("abc"))).toBe(true);
    expect(isWetMediaRef("abc")).toBe(false);
    expect(dryMediaRef(wetMediaRef("abc"))).toBe("abc");
    expect(dryMediaRef("abc")).toBe("abc");
  });

  it("noTwinWithoutABakedFileOrWithZeroAmount", () => {
    expect(hasWetTwin(denoised(0.5), undefined)).toBe(false);
    expect(hasWetTwin(denoised(0.5), new Set())).toBe(false);
    expect(hasWetTwin(denoised(0), wet)).toBe(false);
    expect(hasWetTwin(denoised(0.5, false), wet)).toBe(false);
    expect(hasWetTwin(denoised(0.5), wet)).toBe(true);
  });

  it("frameGraphEmitsDryAndWetSourcesWithBlendedGains", () => {
    const d = doc(denoised(0.25));
    const plain = buildAudioGraph(d, d.timelines[0]?.id as string, 10, {});
    expect(plain.sources).toHaveLength(1);
    expect(plain.sources[0]?.gain).toBe(1);

    const graph = buildAudioGraph(d, d.timelines[0]?.id as string, 10, { wetMediaRefs: wet });
    expect(graph.sources.map((s) => [s.key, s.mediaRef])).toEqual([["c", "m"], ["c~wet", "denoise:m"]]);
    expect(graph.sources[0]?.gain).toBeCloseTo(0.75);
    expect(graph.sources[1]?.gain).toBeCloseTo(0.25);
    expect(graph.sources[1]?.sourceTime).toBe(graph.sources[0]?.sourceTime);
  });

  it("volumeEnvelopeScalesBothHalves", () => {
    const clip = denoised(0.5);
    clip.volume = 0.5;
    const d = doc(clip);
    const graph = buildAudioGraph(d, d.timelines[0]?.id as string, 0, { wetMediaRefs: wet });
    expect(graph.sources[0]?.gain).toBeCloseTo(0.25);
    expect(graph.sources[1]?.gain).toBeCloseTo(0.25);
  });

  it("splitLeavesNestedSourcesAlone", () => {
    const d = doc(denoised(0.5));
    const source = buildAudioGraph(d, d.timelines[0]?.id as string, 0, {}).sources[0];
    if (!source) throw new Error("no source");
    expect(splitDenoiseSource({ ...source, key: "carrier/c" }, wet)).toHaveLength(1);
  });
});
