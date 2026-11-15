import { describe, expect, it } from "vitest";
import { audioEntry, imageEntry, videoEntry } from "../generation/testFixtures";
import type { CatalogEntry } from "../generation/providers/types";
import {
  availableModes, defaultOptions, entryInMode, estimateCost, historyLimit, historyStorageKey, loadHistory, modelsForMode,
  normalizeOptions, optionDefs, pickModel, pushHistory, saveHistory, splitDetail, stepHistory, validateOptions,
  type PromptEntry,
} from "./promptModel";

const veo = videoEntry("fal/veo", { durations: [4, 8], aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"] }, {
  price: { mode: "perSecond", usd: 0.1, byResolution: { "1080p": 0.2 } },
});
const edit = videoEntry("fal/edit", { requiresSourceVideo: true });
const img = imageEntry("openai/img", { qualities: ["low", "high"], maxImages: 3, resolutions: ["1k", "2k"] });
const tts = audioEntry("elevenlabs/tts", { category: "tts", voices: ["Rachel", "Adam"], defaultVoice: "Adam" });
const sfx = audioEntry("elevenlabs/sfx", { category: "sfx", durationRange: { minimum: 1, maximum: 22, defaultValue: 5 } });
const clean = audioEntry("elevenlabs/clean", { category: "cleanup", inputs: ["audio"] });
const catalog: CatalogEntry[] = [veo, edit, img, tts, sfx, clean];

describe("prompt modes", () => {
  it("classifiesEntriesAndSkipsSourceOnlyModels", () => {
    expect(entryInMode(veo, "video")).toBe(true);
    expect(entryInMode(edit, "video")).toBe(false);
    expect(entryInMode(tts, "speech")).toBe(true);
    expect(entryInMode(tts, "sfx")).toBe(false);
    expect(entryInMode(clean, "speech")).toBe(false);
  });
  it("listsOnlyModesTheCatalogServes", () => {
    expect(availableModes(catalog, () => true)).toEqual(["video", "image", "speech", "sfx"]);
    expect(availableModes(catalog, (id) => id !== "fal/veo")).toEqual(["image", "speech", "sfx"]);
  });
  it("putsModelsWithKeysFirstAndKeepsDimmedOnes", () => {
    const a = videoEntry("a"); const b = videoEntry("b"); const c = videoEntry("c");
    const list = modelsForMode("video", [a, b, c], () => true, (e) => e.id === "c");
    expect(list.map((m) => [m.entry.id, m.usable])).toEqual([["c", true], ["a", false], ["b", false]]);
    expect(modelsForMode("video", [a, b], (id) => id === "b", () => true).map((m) => m.entry.id)).toEqual(["b"]);
  });
  it("picksTheRememberedModelElseFirstUsable", () => {
    const list = modelsForMode("video", [videoEntry("a"), videoEntry("b")], () => true, (e) => e.id === "b");
    expect(pickModel(list, "a")?.entry.id).toBe("a");
    expect(pickModel(list, "zzz")?.entry.id).toBe("b");
    expect(pickModel([], undefined)).toBeUndefined();
  });
});

describe("options", () => {
  it("derivesControlsFromCapabilities", () => {
    expect(optionDefs(veo).map((d) => d.key)).toEqual(["duration", "aspectRatio", "resolution"]);
    expect(optionDefs(img).map((d) => d.key)).toEqual(["aspectRatio", "resolution", "quality", "numImages"]);
    expect(optionDefs(tts).map((d) => d.key)).toEqual(["voice"]);
    expect(optionDefs(sfx).find((d) => d.key === "duration")?.choices.map((c) => c.value)).toEqual(["1", "5", "10", "15", "22"]);
  });
  it("picksDefaults", () => {
    expect(defaultOptions(veo)).toMatchObject({ duration: 4, aspectRatio: "16:9", resolution: "1080p" });
    expect(defaultOptions(img)).toMatchObject({ aspectRatio: "1:1", quality: "high", numImages: 1 });
    expect(defaultOptions(tts).voice).toBe("Adam");
    expect(defaultOptions(sfx).duration).toBe(5);
  });
  it("normalizeKeepsValidChoicesAndResetsTheRest", () => {
    const o = normalizeOptions(veo, { duration: 8, aspectRatio: "1:1", resolution: "720p" });
    expect(o).toMatchObject({ duration: 8, aspectRatio: "16:9", resolution: "720p" });
  });
  it("validatesAgainstTheModel", () => {
    const entry: PromptEntry = veo;
    expect(validateOptions(entry, defaultOptions(entry))).toBeUndefined();
    expect(validateOptions(entry, { ...defaultOptions(entry), duration: 7 })).toContain("duration");
  });
  it("estimatesCostOnlyWithPriceHint", () => {
    expect(estimateCost(veo, "x", defaultOptions(veo))).toBeCloseTo(0.8);
    expect(estimateCost(img, "x", defaultOptions(img))).toBeUndefined();
  });
});

describe("history", () => {
  it("keepsMostRecentFirstWithoutDuplicates", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
  });
  it("capsAtFifty", () => {
    let h: string[] = [];
    for (let i = 0; i < 60; i++) h = pushHistory(h, `p${i}`);
    expect(h).toHaveLength(historyLimit);
    expect(h[0]).toBe("p59");
  });
  it("stepsAndClamps", () => {
    expect(stepHistory(0, -1, "older")).toBe(-1);
    expect(stepHistory(3, -1, "older")).toBe(0);
    expect(stepHistory(3, 2, "older")).toBe(2);
    expect(stepHistory(3, 0, "newer")).toBe(-1);
    expect(stepHistory(3, -1, "newer")).toBe(-1);
  });
  it("roundTripsThroughStorage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    saveHistory(storage, ["x", "y"]);
    expect(data.has(historyStorageKey)).toBe(true);
    expect(loadHistory(storage)).toEqual(["x", "y"]);
    data.set(historyStorageKey, "not json");
    expect(loadHistory(storage)).toEqual([]);
    expect(loadHistory(undefined)).toEqual([]);
  });
});

describe("splitDetail", () => {
  it("moves a trailing provider detail out of the message", () => {
    expect(splitDetail("ElevenLabs only allows music on paid plans. (ElevenLabs rejected the key: 401)")).toEqual({
      message: "ElevenLabs only allows music on paid plans.",
      detail: "ElevenLabs rejected the key: 401",
    });
  });
  it("leaves messages without a trailing detail alone", () => {
    expect(splitDetail("The provider didn't return a result.")).toEqual({ message: "The provider didn't return a result." });
    expect(splitDetail("(only a detail)")).toEqual({ message: "(only a detail)" });
  });
});
