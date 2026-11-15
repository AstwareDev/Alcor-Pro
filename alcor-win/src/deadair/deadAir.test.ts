// Ports of the dead-air tests in Tests/PalmierProTests/Timeline/MulticamEngineTests.swift (the four multicam silence
// tests) and Audio/VoiceActivityTests.swift, plus speech-mask and VAD binarisation checks on synthetic masks.
import { afterEach, describe, expect, it } from "vitest";
import { makeMulticamMember, makeMulticamSource, makeMulticamSyncMap } from "../model";
import { makeEditor, Fixtures } from "../editor/mutations/testFixtures";
import { makeFakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import {
  DeadAirMaskCache, DeadAirMaskResolver, allDeadAir, deadAirMaskKey, deadAirSourceRanges, removeAllDeadAir, removeDeadAirInClips,
  DeadAirSelectionError, type DeadAirServices,
} from "./deadAir";
import { SpeechMaskStore, buildQuietNonSpeechMask } from "./speechMaskStore";
import { defaultSilenceRemovalSettings, makeSilenceRemovalSettings, removableMask, vadChunkDuration } from "./silenceRemovalSettings";
import { analysisMask, binarizeSpeech, cacheNoAudioAnalysis, cachedAnalysis, chunkCountForSamples } from "./voiceActivity";

const falses = (n: number): boolean[] => new Array<boolean>(n).fill(false);
const trues = (n: number): boolean[] => new Array<boolean>(n).fill(true);
function settings(minimumPause: number, padding: number) {
  const s = makeSilenceRemovalSettings(minimumPause, padding);
  if (!s) throw new Error("invalid settings");
  return s;
}

describe("Multicam engine — dead air", () => {
  it("silenceMaskRequiresEveryMicToBeSilent", () => {
    const group = makeMulticamSource({
      name: "Podcast",
      members: [
        makeMulticamMember({ mediaRef: "host", kind: "mic", angleLabel: "host", sync: makeMulticamSyncMap({ offsetSeconds: vadChunkDuration, confidence: 1 }) }),
        makeMulticamMember({ mediaRef: "guest", kind: "mic", angleLabel: "guest", sync: makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }) }),
      ],
    });
    group.masterMemberId = group.members[0].id;
    const clip = Fixtures.clip({ mediaRef: "host", mediaType: "audio", start: 0, duration: 10 });
    clip.multicamGroupId = group.id;
    const masks: Record<string, boolean[]> = { host: trues(40), guest: [...falses(10), ...trues(30)] };

    const mask = DeadAirMaskResolver.mask(clip, group, settings(0.25, 0), (ref) => masks[ref]);

    expect(mask).toEqual([...falses(9), ...trues(31)]);
  });

  it("silenceMaskAppliesMinimumPauseAfterMicIntersection", () => {
    const s = settings(1, 0);
    const group = makeMulticamSource({
      name: "Podcast",
      members: [
        makeMulticamMember({ mediaRef: "host", kind: "mic", angleLabel: "host", sync: makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }) }),
        makeMulticamMember({ mediaRef: "guest", kind: "mic", angleLabel: "guest", sync: makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }) }),
      ],
    });
    group.masterMemberId = group.members[0].id;
    const clip = Fixtures.clip({ mediaRef: "host", mediaType: "audio", start: 0, duration: 10 });
    clip.multicamGroupId = group.id;
    const masks: Record<string, boolean[]> = {
      host: [...trues(41), ...falses(39)],
      guest: [...falses(30), ...trues(41), ...falses(9)],
    };

    expect(removableMask(masks.host, s)).toContain(true);
    expect(removableMask(masks.guest, s)).toContain(true);

    const mask = DeadAirMaskResolver.mask(clip, group, s, (ref) => masks[ref]);

    expect(mask?.includes(true)).toBe(false);
  });

  it("deadAirMaskCacheBuildsEachKeyOnce", () => {
    const cache = new DeadAirMaskCache();
    const group = makeMulticamSource({
      name: "Podcast",
      members: [makeMulticamMember({ mediaRef: "audio", kind: "mic", angleLabel: "mic", sync: makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }) })],
    });
    const key = deadAirMaskKey(group, group.members[0], defaultSilenceRemovalSettings);
    let builds = 0;
    const build = (): boolean[] => {
      builds += 1;
      return trues(82_416);
    };

    for (let i = 0; i < 1_000; i++) cache.value(key, build);
    expect(builds).toBe(1);
    cache.reset();
    expect(cache.value(key, build)?.length).toBe(82_416);
    expect(builds).toBe(2);
  });

  it("orphanedMulticamClipDoesNotFallBackToSingleMediaMask", () => {
    const group = makeMulticamSource({
      name: "Podcast",
      members: [makeMulticamMember({ mediaRef: "member", kind: "mic", angleLabel: "member", sync: makeMulticamSyncMap({ offsetSeconds: 0, confidence: 1 }) })],
    });
    const clip = Fixtures.clip({ mediaRef: "orphan", mediaType: "audio", start: 0, duration: 30 });
    clip.multicamGroupId = group.id;
    const e = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
    e.withoutRegistration(() => {
      e.doc.multicamGroups = [group];
    });
    const store = new SpeechMaskStore(() => Promise.reject(new Error("unused")));
    store.installQuietNonSpeechMask(trues(40), clip.mediaRef);

    expect(deadAirSourceRanges(e, clip, defaultSilenceRemovalSettings, servicesFor(store))).toEqual([]);
  });
});

function servicesFor(store: SpeechMaskStore, samples?: Float32Array): DeadAirServices {
  return {
    quietNonSpeechMask: (_e, ref) => store.quietNonSpeechMask(ref, samples),
    deadAirMask: (_e, ref, s) => store.deadAirMask(ref, samples, s),
    maskCache: new DeadAirMaskCache(),
  };
}

describe("dead air removal on a single clip", () => {
  // fps 30 -> one 32 ms cell is 0.96 frames; use a mask long enough that a 2 s pause maps to whole frames.
  function setup() {
    const clip = Fixtures.clip({ id: "a", mediaRef: "m", mediaType: "audio", start: 0, duration: 300 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
    const store = new SpeechMaskStore(() => Promise.reject(new Error("unused")));
    // 10 s of cells: speech 0-2 s, quiet 2-7 s, speech 7-10 s.
    const cells = Math.round(10 / vadChunkDuration);
    const mask = Array.from({ length: cells }, (_, i) => i * vadChunkDuration >= 2 && i * vadChunkDuration < 7);
    store.installQuietNonSpeechMask(mask, "m");
    return { e, store, clip };
  }

  it("removeAllDeadAirRipplesTheQuietSpanAsOneUndoableAction", () => {
    const { e, store } = setup();
    const result = removeAllDeadAir(e, settings(0.5, 0.15), servicesFor(store));
    expect(result?.sections).toBe(1);
    expect(result?.removedFrames).toBeGreaterThan(100);
    expect(result?.refusal).toBeUndefined();
    expect(e.undo()).toBe("Remove Dead Air");
    expect(e.timeline.tracks[0].clips).toHaveLength(1);
    expect(e.timeline.tracks[0].clips[0].durationFrames).toBe(300);
  });

  it("allDeadAirReportsPerAudioTrackRanges", () => {
    const { e, store } = setup();
    const found = allDeadAir(e, settings(0.5, 0.15), servicesFor(store));
    expect(found).toHaveLength(1);
    expect(found[0].trackIndex).toBe(0);
  });

  it("noDeadAirIsANoOpWithoutUndoEntry", () => {
    const { e } = setup();
    const empty = new SpeechMaskStore(() => Promise.reject(new Error("unused")));
    expect(removeAllDeadAir(e, defaultSilenceRemovalSettings, servicesFor(empty))).toBeUndefined();
    expect(e.undo()).toBeNull();
  });

  it("selectionValidation", () => {
    const { e, store } = setup();
    const services = servicesFor(store);
    expect(() => removeDeadAirInClips(e, ["missing"], defaultSilenceRemovalSettings, services)).toThrow(DeadAirSelectionError);
    expect(removeDeadAirInClips(e, ["a"], settings(0.5, 0.15), services)?.sections).toBe(1);
  });
});

describe("Speech masks", () => {
  it("quietNonSpeechMaskUsesTheSpeechLevelFloor", () => {
    // 5 cells x 10 samples; samples are dB-normalised (0 = loud, 1 = silence). Speech median 0.1 -> floor 0.44 + ... = 0.44.
    const speech = [true, false, true, false, true];
    const samples = new Float32Array(50).fill(0.1);
    samples.fill(0.9, 10, 20); // quiet gap
    samples.fill(0.3, 30, 40); // loud non-speech (music bed): below the floor, not dead air
    expect(buildQuietNonSpeechMask(speech, samples)).toEqual([false, true, false, false, false]);
  });

  it("noSpeechUsesAbsoluteFloor", () => {
    const quiet = new Float32Array(20).fill(0.7);
    expect(buildQuietNonSpeechMask([false, false], quiet)).toEqual([true, true]);
    expect(buildQuietNonSpeechMask([false, false], new Float32Array(20).fill(0.5))).toEqual([false, false]);
  });

  it("storeGeneratesOncePerAssetAndReportsReady", async () => {
    let calls = 0;
    const store = new SpeechMaskStore(() => {
      calls += 1;
      return Promise.resolve({ chunkCount: 10, segments: [{ start: 0, end: 0.1 }] });
    });
    const ready: string[] = [];
    store.onMaskReady = (ref) => ready.push(ref);
    store.generate({ id: "m", url: "/m.wav" });
    store.generate({ id: "m", url: "/m.wav" });
    expect(store.analyzingCount).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(ready).toEqual(["m"]);
    expect(store.hasSpeechMask("m")).toBe(true);
    store.generate({ id: "m", url: "/m.wav" });
    expect(calls).toBe(1);
  });

  it("failedAnalysisIsNotRetriedUntilInvalidated", async () => {
    let calls = 0;
    const store = new SpeechMaskStore(() => {
      calls += 1;
      return Promise.reject(new Error("no model"));
    });
    store.generate({ id: "m", url: "/m" });
    await Promise.resolve();
    await Promise.resolve();
    store.generate({ id: "m", url: "/m" });
    expect(calls).toBe(1);
    store.invalidate("m");
    store.generate({ id: "m", url: "/m" });
    expect(calls).toBe(2);
  });
});

describe("VoiceActivity", () => {
  afterEach(() => setMediaIo(undefined));

  it("cachesNoAudioAsEmptyAnalysis", async () => {
    const io = makeFakeIo();
    setMediaIo(io);
    io.addFile("/media/clip.mov", new Uint8Array(0), 1000);
    const analysis = await cacheNoAudioAnalysis("/media/clip.mov", "vad-no-audio");
    expect(analysis.chunkCount).toBe(0);
    expect(analysis.segments).toEqual([]);
    expect((await cachedAnalysis("/media/clip.mov", "vad-no-audio"))?.chunkCount).toBe(0);
  });

  it("maskExpandsSegmentsToCells", () => {
    const cell = vadChunkDuration;
    const mask = analysisMask({ chunkCount: 10, segments: [{ start: cell * 2, end: cell * 4 - 0.001 }, { start: cell * 8, end: 99 }] });
    expect(mask).toEqual([false, false, true, true, false, false, false, false, true, true]);
  });

  it("chunkCountRoundsUp", () => {
    expect(chunkCountForSamples(0)).toBe(0);
    expect(chunkCountForSamples(512)).toBe(1);
    expect(chunkCountForSamples(513)).toBe(2);
  });

  it("binarizeAppliesHysteresisAndDurationFilters", () => {
    const cell = vadChunkDuration;
    const probs = (spans: [number, number][], total: number): number[] =>
      Array.from({ length: total }, (_, i) => (spans.some(([a, b]) => i >= a && i < b) ? 0.9 : 0.1));
    // 0.25 s minimum speech = 8 cells; shorter bursts are dropped.
    expect(binarizeSpeech(probs([[0, 5]], 40))).toEqual([]);
    const kept = binarizeSpeech(probs([[4, 20]], 40));
    expect(kept).toHaveLength(1);
    expect(kept[0].start).toBeCloseTo(4 * cell, 5);
    expect(kept[0].end).toBeCloseTo(20 * cell, 5);
    // A gap under 0.1 s (3 cells) merges neighbours; a longer gap splits them.
    expect(binarizeSpeech(probs([[0, 10], [12, 24]], 40))).toHaveLength(1);
    expect(binarizeSpeech(probs([[0, 10], [14, 24]], 40))).toHaveLength(2);
    // Hysteresis: speech holds until probability drops below 0.35.
    const held = [...new Array<number>(10).fill(0.9), ...new Array<number>(10).fill(0.4), ...new Array<number>(10).fill(0.1)];
    expect(binarizeSpeech(held)[0].end).toBeCloseTo(20 * cell, 5);
    // A trailing open segment closes at the end.
    expect(binarizeSpeech(new Array<number>(20).fill(0.9))[0].end).toBeCloseTo(20 * cell, 5);
    expect(binarizeSpeech([])).toEqual([]);
  });
});
