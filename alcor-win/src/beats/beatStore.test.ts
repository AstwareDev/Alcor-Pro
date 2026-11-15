import { describe, expect, it } from "vitest";
import { makeClip } from "../model";
import { BeatStore, beatSnapFrames } from "./beatStore";
import type { BeatAnalysis, BeatAnalysisCacheEntry } from "./beatInference";

/** Port of the Swift ControlledBeatCacheLoader / ControlledFileTagLoader. */
class Controlled<T> {
  count = 0;
  urls: string[] = [];
  private waiters: { n: number; resolve: () => void }[] = [];
  private results: ((v: T) => void)[] = [];
  load = (url: string): Promise<T> => {
    this.count += 1;
    this.urls.push(url);
    for (const w of this.waiters.filter((x) => this.count >= x.n)) w.resolve();
    this.waiters = this.waiters.filter((x) => this.count < x.n);
    return new Promise<T>((resolve) => this.results.push(resolve));
  };
  waitForCount(n: number): Promise<void> {
    return this.count >= n ? Promise.resolve() : new Promise((resolve) => this.waiters.push({ n, resolve }));
  }
  finishNext(v: T): boolean {
    const r = this.results.shift();
    if (!r) return false;
    r(v);
    return true;
  }
}

const makeAsset = (url = `/tmp/beat-store-${Math.random()}.wav`): { id: string; url: string } => ({ id: crypto.randomUUID(), url });
const noRun = async (): Promise<BeatAnalysis> => {
  throw new Error("detection must not run");
};

type Entry = BeatAnalysisCacheEntry | undefined;

function makeStore(loader: Controlled<Entry>): BeatStore {
  return new BeatStore({ cachedAnalysisLoader: (u) => loader.load(u), analysisRunner: noRun });
}

describe("BeatStore", () => {
  it("hydrationReturnsWhileCacheLoadIsPending", async () => {
    const loader = new Controlled<Entry>();
    const store = makeStore(loader);
    const asset = makeAsset();
    const task = store.hydrate(asset);
    expect(task).toBeDefined();
    await loader.waitForCount(1);
    expect(store.analysis(asset.id)).toBeUndefined();
    expect(loader.count).toBe(1);
    expect(loader.finishNext(undefined)).toBe(true);
    await task;
  });

  it("repeatedHydrationStartsOneCacheLoad", async () => {
    const loader = new Controlled<Entry>();
    const store = makeStore(loader);
    const asset = makeAsset();
    const first = store.hydrate(asset);
    const second = store.hydrate(asset);
    await loader.waitForCount(1);
    expect(loader.count).toBe(1);
    loader.finishNext(undefined);
    await first;
    await second;
  });

  it("invalidationRejectsLateHydrationResult", async () => {
    const loader = new Controlled<Entry>();
    const store = makeStore(loader);
    const asset = makeAsset();
    const analysis: BeatAnalysis = { bpm: 120, beats: [0.5], downbeats: [0.5] };
    const task = store.hydrate(asset);
    await loader.waitForCount(1);
    store.invalidate(asset.id);
    loader.finishNext({ analysis, fileTag: "tag" });
    await task;
    expect(store.analysis(asset.id)).toBeUndefined();
  });

  it("urlChangeRestartsHydrationWithCurrentURL", async () => {
    const loader = new Controlled<Entry>();
    const store = makeStore(loader);
    const asset = makeAsset("/tmp/original.palmier/Media/audio.wav");
    const stale: BeatAnalysis = { bpm: 90, beats: [0.5], downbeats: [] };
    const current: BeatAnalysis = { bpm: 120, beats: [1], downbeats: [1] };
    const first = store.hydrate(asset);
    await loader.waitForCount(1);
    asset.url = "/tmp/rebased.palmier/Media/audio.wav";
    loader.finishNext({ analysis: stale, fileTag: "old" });
    await first;
    await loader.waitForCount(2);
    expect(loader.urls).toEqual(["/tmp/original.palmier/Media/audio.wav", "/tmp/rebased.palmier/Media/audio.wav"]);
    expect(store.analysis(asset.id)).toBeUndefined();
    loader.finishNext({ analysis: current, fileTag: "new" });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.analysis(asset.id)).toEqual(current);
  });

  it("detectionReturnsWhileFileTagLoadIsPending", async () => {
    const cache = new Controlled<Entry>();
    const tags = new Controlled<string>();
    const store = new BeatStore({ cachedAnalysisLoader: (u) => cache.load(u), fileTagLoader: (u) => tags.load(u), analysisRunner: noRun });
    const asset = makeAsset();
    const analysis: BeatAnalysis = { bpm: 120, beats: [0.5], downbeats: [0.5] };
    const hydration = store.hydrate(asset);
    await cache.waitForCount(1);
    cache.finishNext({ analysis, fileTag: "tag" });
    await hydration;
    const detection = store.detect(asset);
    await tags.waitForCount(1);
    expect(store.analysis(asset.id)).toEqual(analysis);
    expect(tags.count).toBe(1);
    tags.finishNext("tag");
    expect(await detection).toEqual(analysis);
  });

  it("urlChangeDuringDetectionRestartsWithCurrentURL", async () => {
    const cache = new Controlled<Entry>();
    const tags = new Controlled<string>();
    const store = new BeatStore({ cachedAnalysisLoader: (u) => cache.load(u), fileTagLoader: (u) => tags.load(u), analysisRunner: noRun });
    const asset = makeAsset("/tmp/original.palmier/Media/audio.wav");
    const analysis: BeatAnalysis = { bpm: 120, beats: [0.5], downbeats: [0.5] };
    const hydration = store.hydrate(asset);
    await cache.waitForCount(1);
    cache.finishNext({ analysis, fileTag: "tag" });
    await hydration;
    const detection = store.detect(asset);
    await tags.waitForCount(1);
    asset.url = "/tmp/rebased.palmier/Media/audio.wav";
    tags.finishNext("tag");
    await tags.waitForCount(2);
    expect(tags.urls).toEqual(["/tmp/original.palmier/Media/audio.wav", "/tmp/rebased.palmier/Media/audio.wav"]);
    tags.finishNext("tag");
    expect(await detection).toEqual(analysis);
    expect(store.analysis(asset.id)).toEqual(analysis);
  });

  it("detectRunsAnalysisOnceAndSharesTheTask", async () => {
    let runs = 0;
    const store = new BeatStore({
      fileTagLoader: async () => "t",
      analysisRunner: async () => {
        runs += 1;
        return { bpm: 100, beats: [1, 2, 3], downbeats: [] };
      },
    });
    let ready = 0;
    store.onBeatsReady = () => ready++;
    const asset = makeAsset();
    const [a, b] = await Promise.all([store.detect(asset), store.detect(asset)]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect(ready).toBe(1);
    await store.detect(asset);
    expect(runs).toBe(1);
    await store.detect(asset, true);
    expect(runs).toBe(2);
  });
});

describe("beatSnapFrames", () => {
  const analysis: BeatAnalysis = { bpm: 120, beats: [0.5, 1, 1.5, 2], downbeats: [1, 2] };
  const clip = makeClip({ mediaRef: "m", mediaType: "audio", startFrame: 100, durationFrames: 60 });
  it("mapsBeatsAndDownbeatsThroughPlacementDeduplicated", () => {
    const frames = beatSnapFrames(clip, 30, true, () => analysis).sort((a, b) => a - b);
    expect(frames).toEqual([115, 130, 145, 160].filter((f) => f < 160));
  });
  it("emptyWhenDisabledSequenceOrUnanalyzed", () => {
    expect(beatSnapFrames(clip, 30, false, () => analysis)).toEqual([]);
    expect(beatSnapFrames({ ...clip, sourceClipType: "sequence" }, 30, true, () => analysis)).toEqual([]);
    expect(beatSnapFrames(clip, 30, true, () => undefined)).toEqual([]);
  });
});
