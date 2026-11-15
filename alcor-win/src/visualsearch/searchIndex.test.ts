import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { makeMediaAsset, type MediaAsset } from "../model";
import { SearchIndexCoordinator } from "./searchIndex";
import { FakeEmbedder, FakeModel, frame } from "./searchTestSupport";
import type { SampledFrame } from "./frameSampler";

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

const video = (id: string, duration = 20): MediaAsset => makeMediaAsset({ id, url: `/m/${id}.mp4`, type: "video", name: id, duration });
const image = (id: string): MediaAsset => makeMediaAsset({ id, url: `/m/${id}.png`, type: "image", name: id });

interface Setup {
  index: SearchIndexCoordinator;
  model: FakeModel;
  fake: FakeEmbedder;
  assets: MediaAsset[];
  idleCalls: () => number;
}

/** `frames` maps a video path to its sampled frames; stills are one red pixel. */
function setup(assets: MediaAsset[], frames: Record<string, SampledFrame[]>, idle?: () => Promise<void>): Setup {
  for (const a of assets) io.addFile(a.url, a.id, 1000);
  const fake = new FakeEmbedder();
  const model = new FakeModel(fake);
  let idleCalls = 0;
  const index = new SearchIndexCoordinator({
    model,
    assets: () => assets,
    deps: {
      frames: async function* (path) {
        const list = frames[path];
        if (!list) throw new Error(`no frames for ${path}`);
        yield* list;
      },
      still: async () => frame(0, [0, 0, 255], true).pixels,
      idle: async () => {
        idleCalls++;
        await idle?.();
      },
    },
  });
  return { index, model, fake, assets, idleCalls: () => idleCalls };
}

const twoShots = [frame(2, [255, 0, 0], true), frame(10, [0, 255, 0], true), frame(14, [0, 250, 0], false)];

describe("SearchIndexCoordinator indexing", () => {
  it("indexesVideosAndStillsInTheBackgroundThenRanksThemBySimilarity", async () => {
    const s = setup([video("v1"), image("i1")], { "/m/v1.mp4": twoShots });
    await s.index.projectOpened();
    await s.index.idle();
    expect(s.index.indexingActive).toBe(false);

    const red = await s.index.search("a red car");
    expect(red.map((h) => [h.assetID, h.shotStart, h.shotEnd])).toEqual([["v1", 0, 10]]);
    const blue = await s.index.search("blue sky");
    expect(blue.map((h) => [h.assetID, h.shotStart, h.shotEnd])).toEqual([["i1", 0, 0]]);
    const green = await s.index.search("green");
    expect(green[0]?.assetID).toBe("v1");
    expect([green[0]?.time, green[0]?.shotStart, green[0]?.shotEnd]).toEqual([10, 10, 20]);
  });

  it("doesNotReindexUnchangedFilesButReindexesAReplacedOne", async () => {
    const s = setup([video("v1")], { "/m/v1.mp4": twoShots });
    await s.index.projectOpened();
    await s.index.idle();
    const first = s.fake.imageCalls;
    expect(first).toBe(3);

    s.index.sweep();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(first);

    io.addFile("/m/v1.mp4", "new bytes", 9000);
    s.index.sweep();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(first * 2);
  });

  it("rebuildsWhenTheModelVersionChanges", async () => {
    const s = setup([image("i1")], {});
    await s.index.projectOpened();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(1);
    const next = new FakeEmbedder({ ...s.fake.spec, version: 2 });
    s.model.fake = next;
    s.index.sweep();
    await s.index.idle();
    expect(next.imageCalls).toBe(1);
  });

  it("waitsForTheEditorToBeIdleBeforeEmbeddingEachFrame", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup([video("v1")], { "/m/v1.mp4": twoShots }, () => gate);
    const opened = s.index.projectOpened();
    await opened;
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.imageCalls).toBe(0);
    expect(s.index.indexingActive).toBe(true);
    release();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(3);
    expect(s.idleCalls()).toBeGreaterThanOrEqual(3);
  });

  it("skipsGeneratingAssetsAudioAndADisabledModel", async () => {
    const generating = { ...image("g"), generationStatus: { kind: "generating" } } as MediaAsset;
    const audio = makeMediaAsset({ id: "a", url: "/m/a.wav", type: "audio", name: "a", duration: 5 });
    const s = setup([generating, audio, image("i1")], {});
    await s.index.projectOpened();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(1);

    s.model.isEnabled = false;
    io.addFile("/m/i1.png", "changed", 7000);
    s.index.sweep();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(1);
  });

  it("doesNothingUntilTheModelIsInstalled", async () => {
    const fake = new FakeEmbedder();
    const model = new FakeModel(fake, false);
    const a = image("i1");
    io.addFile(a.url, "x");
    const index = new SearchIndexCoordinator({ model, assets: () => [a] });
    await index.projectOpened();
    await index.idle();
    expect(model.state().kind).toBe("notInstalled");
    expect(index.indexingActive).toBe(false);
    expect(await index.search("red")).toEqual([]);
  });

  it("retriesAFailedAssetOnTheNextSweepOnly", async () => {
    const frames: Record<string, SampledFrame[]> = {};
    const s = setup([video("v1"), image("i1")], frames);
    await s.index.projectOpened();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(1); // the still; the video has no frames and fails without blocking it

    frames["/m/v1.mp4"] = twoShots;
    s.index.schedule(s.assets[0] as MediaAsset);
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(1);
    s.index.sweep();
    await s.index.idle();
    expect(s.fake.imageCalls).toBe(4);
  });

  it("cancelDropsQueuedWorkAndResetsProgress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup([video("v1"), video("v2")], { "/m/v1.mp4": twoShots, "/m/v2.mp4": twoShots }, () => gate);
    await s.index.projectOpened();
    expect(s.index.batchTotal).toBe(2);
    const cancelled = s.index.cancel();
    release();
    await cancelled;
    expect(s.index.batchTotal).toBe(0);
    expect(s.index.indexingActive).toBe(false);
    expect(s.fake.imageCalls).toBeLessThanOrEqual(1);
  });
});

describe("SearchIndexCoordinator search", () => {
  it("restrictsToTheGivenAssetsAndIgnoresBlankQueries", async () => {
    const s = setup([image("i1"), image("i2")], {});
    await s.index.projectOpened();
    await s.index.idle();
    expect((await s.index.search("blue")).map((h) => h.assetID).sort()).toEqual(["i1", "i2"]);
    expect((await s.index.search("blue", 20, new Set(["i2"]))).map((h) => h.assetID)).toEqual(["i2"]);
    expect(await s.index.search("   ")).toEqual([]);
  });

  it("reloadsAnAssetsIndexAfterItsFileChanges", async () => {
    const s = setup([image("i1")], {});
    await s.index.projectOpened();
    await s.index.idle();
    expect(await s.index.search("blue")).toHaveLength(1);
    io.addFile("/m/i1.png", "replaced", 9999);
    expect(await s.index.search("blue")).toEqual([]); // new key, no index yet
  });

  it("countsIndexedAssets", async () => {
    const s = setup([image("i1"), image("i2")], {});
    expect(await s.index.indexedCount(s.assets)).toBe(0);
    await s.index.projectOpened();
    await s.index.idle();
    expect(await s.index.indexedCount(s.assets)).toBe(2);
  });
});
