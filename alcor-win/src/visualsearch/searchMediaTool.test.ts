import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolHarness } from "../agent/tools/testHarness";
import { mcpServerTools } from "../agent/tools/toolRegistry";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { SearchIndexCoordinator } from "./searchIndex";
import { setSearchIndexFor } from "./searchService";
import { FakeEmbedder, FakeModel, frame } from "./searchTestSupport";

type Json = Record<string, unknown>;

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

interface Setup {
  h: ToolHarness;
  model: FakeModel;
  fake: FakeEmbedder;
  index: SearchIndexCoordinator;
}

async function setup(installed = true): Promise<Setup> {
  const h = new ToolHarness();
  h.addAsset({ id: "clip", type: "video", duration: 20 });
  h.addAsset({ id: "still", type: "image", duration: 0 });
  h.addAsset({ id: "song", type: "audio", duration: 30 });
  for (const a of h.editor.mediaAssets) io.addFile(a.url, a.id, 1000);
  const fake = new FakeEmbedder();
  const model = new FakeModel(fake, installed);
  const index = new SearchIndexCoordinator({
    model,
    assets: () => h.editor.mediaAssets,
    deps: {
      frames: async function* () {
        yield frame(2, [255, 0, 0], true);
        yield frame(10.123456, [0, 255, 0], true);
      },
      still: async () => frame(0, [0, 0, 255], true).pixels,
    },
  });
  setSearchIndexFor(h.editor, index);
  if (installed) {
    await index.projectOpened();
    await index.idle();
  }
  return { h, model, fake, index };
}

describe("search_media", () => {
  it("isListedWithTheVerbatimSchema", () => {
    const tool = mcpServerTools().find((r) => r.definition.name === "search_media");
    expect(tool).toBeDefined();
    const schema = tool?.definition.inputSchema as Json;
    expect(schema.required).toEqual(["query"]);
    expect(Object.keys(schema.properties as Json).sort()).toEqual(["limit", "mediaRef", "query", "scope"]);
  });

  it("returnsVisualMomentsWithSourceSecondRangesAndTheTimelineFps", async () => {
    const { h } = await setup();
    const out = await h.runOK("search_media", { query: "a green field", scope: "visual" });
    expect(out.timelineFps).toBe(h.editor.timeline.fps);
    expect(out.index).toBeUndefined();
    expect(out.spoken).toBeUndefined();
    const moments = out.moments as Json[];
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ mediaRef: "clip", name: "clip", startSeconds: 10.123, endSeconds: 20 });
    expect(typeof moments[0]?.score).toBe("number");
  });

  it("reportsStillsAsImagesWithoutATimeRange", async () => {
    const { h } = await setup();
    const out = await h.runOK("search_media", { query: "blue", scope: "visual" });
    const moment = (out.moments as Json[])[0] as Json;
    expect(moment).toMatchObject({ mediaRef: "still", type: "image" });
    expect(moment.startSeconds).toBeUndefined();
    expect(moment.endSeconds).toBeUndefined();
  });

  it("restrictsToOneAssetAndBothScopesReturnBothGroups", async () => {
    const { h } = await setup();
    const out = await h.runOK("search_media", { query: "blue", mediaRef: "clip" });
    expect(out.moments).toEqual([]);
    expect(out.spoken).toEqual([]);
  });

  it("spokenScopeNeverTouchesTheVisualModel", async () => {
    const { h, fake, model } = await setup(false);
    const out = await h.runOK("search_media", { query: "budget", scope: "spoken" });
    expect(out.moments).toBeUndefined();
    expect(out.index).toBeUndefined();
    expect(out.spoken).toEqual([]);
    expect(fake.textCalls).toBe(0);
    expect(model.downloads).toBe(0);
  });

  it("startsTheModelDownloadAndExplainsMissingResultsWhileItIsNotInstalled", async () => {
    const { h, model } = await setup(false);
    const out = await h.runOK("search_media", { query: "dog", scope: "visual" });
    expect(model.downloads).toBe(1);
    expect(out.moments).toEqual([]);
    expect(out.index).toEqual({ status: "downloadingModel", indexableAssets: 2, modelDownloadProgress: 0.5 });
  });

  it("reportsPartialIndexesAndFailures", async () => {
    const { h, model, index } = await setup();
    io.addFile("/tmp/still", "changed", 5000);
    const partial = await h.runOK("search_media", { query: "red", scope: "visual" });
    expect(partial.index).toEqual({ status: "ready", indexableAssets: 2, indexedAssets: 1 });
    void index;

    model.setState({ kind: "failed", reason: "offline" });
    const failed = await h.runOK("search_media", { query: "red", scope: "visual" });
    expect(failed.index).toMatchObject({ status: "failed", modelDownloadError: "offline" });

    model.isEnabled = false;
    expect(((await h.runOK("search_media", { query: "red", scope: "visual" })).index as Json).status).toBe("disabled");
  });

  it("clampsLimitAndRejectsBadArguments", async () => {
    const { h } = await setup();
    const many = await h.runOK("search_media", { query: "blue", limit: 0 });
    expect((many.moments as Json[]).length).toBeLessThanOrEqual(1);
    for (const args of [{ query: "  " }, { query: "x", scope: "audio" }, { query: "x", mediaRef: "nope" }, { query: "x", colour: 1 }, {}]) {
      expect((await h.runRaw("search_media", args)).isError).toBe(true);
    }
    expect(ToolHarness.textOf(await h.runRaw("search_media", { query: "x", scope: "audio" }))).toBe(
      "search_media: scope must be visual, spoken, or both (got 'audio')",
    );
    expect(ToolHarness.textOf(await h.runRaw("search_media", { query: "   " }))).toBe("search_media: query is empty");
  });
});
