import { describe, expect, it } from "vitest";
import {
  beatBorder, beatChunkFrames, beatHop, beatSampleRate, beatStrideFrames, decodeBeatAnalysis, estimateBPM, pickPeaks, planBeatChunks, predictLogits,
  type ChunkLogits,
} from "./beatInference";

const frameTime = (i: number): number => (i * beatHop) / beatSampleRate;

describe("BeatDetector post-processing", () => {
  it("pickPeaksFindsLocalMaximaAboveThreshold", () => {
    const logits = [-5, -1, 2, 1, -3, 0.2, 0.1, -9, -0.1, -0.2];
    expect(pickPeaks(logits)).toEqual([frameTime(2), frameTime(5)]);
  });

  it("pickPeaksIgnoresShortInputAndSubThreshold", () => {
    expect(pickPeaks([1, 2])).toEqual([]);
    expect(pickPeaks([-1, -0.5, -1])).toEqual([]);
  });

  it("plateauReportsLastFrameOnly", () => {
    expect(pickPeaks([-3, 4, 4, -3])).toEqual([frameTime(2)]);
  });

  it("estimateBPMIsMedianInterval", () => {
    expect(estimateBPM([0, 0.5, 1, 1.5, 2])).toBeCloseTo(120);
    expect(estimateBPM([0, 0.5, 1.2])).toBeCloseTo(60 / 0.7, 6);
    expect(estimateBPM([0, 1])).toBeUndefined();
    expect(estimateBPM([1, 1, 1])).toBeUndefined();
  });

  it("chunkPlanStartsBorderFramesEarlyAndCoversAllFrames", () => {
    expect(planBeatChunks(10)).toEqual([-beatBorder]);
    const starts = planBeatChunks(4000);
    expect(starts[0]).toBe(-6);
    expect(starts[1] as number - (starts[0] as number)).toBe(beatStrideFrames);
    const last = starts[starts.length - 1] as number;
    expect(last + beatChunkFrames - beatBorder).toBeGreaterThanOrEqual(4000);
    expect(last + beatBorder).toBeLessThan(4000);
  });

  it("longerThanOneChunkStitchesWithoutSeamDropouts", async () => {
    // 35 s of audio spans several 30 s model chunks; activations depend on the global frame, so the stitcher must place them exactly.
    const samples = new Float32Array(35 * beatSampleRate);
    const starts = planBeatChunks(Math.trunc(samples.length / beatHop) + 1);
    let n = 0;
    const calls: number[] = [];
    const run = async (): Promise<ChunkLogits> => {
      const chunkStart = starts[n++] as number;
      calls.push(chunkStart);
      const beat = new Float32Array(beatChunkFrames).fill(-8);
      const downbeat = new Float32Array(beatChunkFrames).fill(-8);
      for (let i = 0; i < beatChunkFrames; i++) {
        if ((chunkStart + i) % 25 === 0 && chunkStart + i >= 0) beat[i] = 8;
      }
      return { beat, downbeat };
    };
    const logits = await predictLogits(samples, run);
    expect(calls.length).toBe(starts.length);
    const beats = pickPeaks(logits.beat);
    expect(beats.length).toBeGreaterThanOrEqual(69);
    expect(estimateBPM(beats)).toBeCloseTo(120, 0);
    const seam = beats.filter((t) => t > 28.9 && t < 31.1);
    expect(seam.length).toBeGreaterThanOrEqual(3);
  });

  it("keepFirstWinsOnOverlap", async () => {
    const samples = new Float32Array(35 * beatSampleRate);
    let call = 0;
    const run = async (): Promise<ChunkLogits> => {
      call += 1;
      return { beat: new Float32Array(beatChunkFrames).fill(call), downbeat: new Float32Array(beatChunkFrames).fill(-call) };
    };
    const logits = await predictLogits(samples, run);
    expect(logits.beat[0]).toBe(1);
    expect(logits.beat[beatStrideFrames - beatBorder - 1 + 6]).toBe(1);
    expect(logits.beat[beatStrideFrames + 100]).toBe(2);
    expect(logits.downbeat[beatStrideFrames + 100]).toBe(-2);
  });

  it("badModelOutputThrows", async () => {
    await expect(predictLogits(new Float32Array(100), async () => ({ beat: new Float32Array(3), downbeat: new Float32Array(3) }))).rejects.toThrow();
  });

  it("decodeBeatAnalysisIsStrict", () => {
    expect(decodeBeatAnalysis('{"bpm":120,"beats":[0.5],"downbeats":[0.5]}')).toEqual({ bpm: 120, beats: [0.5], downbeats: [0.5] });
    expect(decodeBeatAnalysis('{"bpm":"x","beats":[],"downbeats":[]}')).toBeUndefined();
    expect(decodeBeatAnalysis("nope")).toBeUndefined();
  });
});
