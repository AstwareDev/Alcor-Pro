import { describe, expect, it } from "vitest";
import { makeFakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import type { ProviderId } from "../generation/providers/types";
import type { Transcript, TranscribeOptions } from "../generation/providers/transcription";
import {
  chooseBackend, languageIdentifier, planChunks, transcribeCached, transcribeMedia, type TranscriptionDeps,
} from "./transcriptionBackend";
import { clearTranscriptMemory } from "./transcriptCache";

const keys = (...ids: ProviderId[]): ReadonlySet<ProviderId> => new Set(ids);

describe("chooseBackend", () => {
  it("prefersElevenLabsThenOpenAI", () => {
    expect(chooseBackend("auto", keys("elevenlabs", "openai"))).toBe("elevenlabs");
    expect(chooseBackend("auto", keys("openai"))).toBe("openai");
    expect(chooseBackend("auto", keys("openai", "elevenlabs"))).toBe("elevenlabs");
  });

  it("fallsBackToThisPcWhenNoCloudKeyIsSet", () => {
    expect(chooseBackend("auto", keys())).toBe("local");
    expect(chooseBackend("auto", keys("fal", "google"))).toBe("local");
  });

  it("usesThisPcWhenChosenEvenWithKeys", () => {
    expect(chooseBackend("local", keys("elevenlabs", "openai"))).toBe("local");
  });

  it("honoursAnExplicitPreferenceOnlyWhenItsKeyExists", () => {
    expect(chooseBackend("openai", keys("elevenlabs", "openai"))).toBe("openai");
    expect(chooseBackend("openai", keys("elevenlabs"))).toBe("elevenlabs");
    expect(chooseBackend("elevenlabs", keys())).toBe("local");
  });
});

describe("planChunks", () => {
  it("returnsOneChunkForShortAudioAndEvenPiecesForLongAudio", () => {
    expect(planChunks({ start: 5, end: 65 })).toEqual([{ start: 5, end: 65 }]);
    const chunks = planChunks({ start: 0, end: 1500 }, 600);
    expect(chunks).toEqual([{ start: 0, end: 500 }, { start: 500, end: 1000 }, { start: 1000, end: 1500 }]);
    expect(planChunks({ start: 3, end: 3 })).toEqual([]);
  });
});

describe("languageIdentifier", () => {
  it("usesThePrimarySubtag", () => {
    expect(languageIdentifier("en-US")).toBe("en");
    expect(languageIdentifier("pt_BR")).toBe("pt");
    expect(languageIdentifier(undefined)).toBeUndefined();
  });
});

function fakeDeps(log: string[]): TranscriptionDeps {
  return {
    async extractAudio(_path, range) {
      log.push(`extract ${range ? `${range.start}-${range.end}` : "all"}`);
      return `/tmp/${log.length}.m4a`;
    },
    async removeTemp(paths) {
      log.push(`remove ${paths.length}`);
    },
    async transcribe(backend, path): Promise<Transcript> {
      log.push(`transcribe ${backend} ${path}`);
      // Each chunk hears "hi" at 0.5s of its own timeline.
      return { text: "hi.", language: "en", words: [{ text: "hi.", start: 0.5, end: 0.9 }] };
    },
  };
}

describe("transcribeMedia", () => {
  it("chunksLongRangesAndShiftsWordsIntoSourceTime", async () => {
    const log: string[] = [];
    const progress: number[] = [];
    const result = await transcribeMedia(
      { path: "/m/a.mp4", range: { start: 100, end: 1300 }, backend: "elevenlabs", onProgress: (f) => progress.push(f) },
      fakeDeps(log),
    );
    expect(log.filter((l) => l.startsWith("extract"))).toEqual(["extract 100-700", "extract 700-1300"]);
    expect(result.words.map((w) => w.start)).toEqual([100.5, 700.5]);
    expect(result.language).toBe("en");
    expect(progress).toEqual([0.5, 1]);
    expect(log.filter((l) => l.startsWith("remove"))).toHaveLength(2);
  });

  it("sendsALongRangeToThisPcInOnePieceAndForwardsProgress", async () => {
    const log: string[] = [];
    const progress: number[] = [];
    const seen: { durationSeconds?: number }[] = [];
    const deps: TranscriptionDeps = {
      ...fakeDeps(log),
      async transcribe(_backend, _path, options) {
        seen.push(options);
        options.onProgress?.(0.5);
        return { text: "hi.", words: [{ text: "hi.", start: 1, end: 1.4 }] };
      },
    };
    const result = await transcribeMedia(
      { path: "/m/a.mp4", range: { start: 100, end: 4000 }, backend: "local", onProgress: (f) => progress.push(f) },
      deps,
    );
    expect(log.filter((l) => l.startsWith("extract"))).toEqual(["extract 100-4000"]);
    expect(seen[0]?.durationSeconds).toBe(3900);
    expect(progress).toEqual([0.5, 1]);
    expect(result.words[0]?.start).toBe(101);
  });

  it("keepsCloudOptionsFreeOfLocalOnlyFields", async () => {
    const seen: object[] = [];
    const deps: TranscriptionDeps = {
      ...fakeDeps([]),
      async transcribe(_backend, _path, options) {
        seen.push(options);
        return { text: "", words: [] };
      },
    };
    await transcribeMedia({ path: "/m/a.mp4", range: { start: 0, end: 30 }, language: "de", backend: "openai", onProgress: () => undefined }, deps);
    expect(seen).toEqual([{ language: "de" }]);
  });

  it("sendsALongRangeToThisPcInOnePieceAndForwardsProgress", async () => {
    const log: string[] = [];
    const progress: number[] = [];
    const seen: TranscribeOptions[] = [];
    const deps: TranscriptionDeps = {
      ...fakeDeps(log),
      async transcribe(_backend, _path, options) {
        seen.push(options);
        options.onProgress?.(0.5);
        return { text: "hi.", words: [{ text: "hi.", start: 1, end: 1.4 }] };
      },
    };
    const result = await transcribeMedia(
      { path: "/m/a.mp4", range: { start: 100, end: 4000 }, backend: "local", onProgress: (f) => progress.push(f) },
      deps,
    );
    expect(log.filter((l) => l.startsWith("extract"))).toEqual(["extract 100-4000"]);
    expect(seen[0]?.durationSeconds).toBe(3900);
    expect(progress).toEqual([0.5, 1]);
    expect(result.words[0]?.start).toBe(101);
  });

  it("keepsCloudOptionsFreeOfLocalOnlyFields", async () => {
    const seen: TranscribeOptions[] = [];
    const deps: TranscriptionDeps = {
      ...fakeDeps([]),
      async transcribe(_backend, _path, options) {
        seen.push(options);
        return { text: "", words: [] };
      },
    };
    await transcribeMedia({ path: "/m/a.mp4", range: { start: 0, end: 30 }, language: "de", backend: "openai", onProgress: () => undefined }, deps);
    expect(seen).toEqual([{ language: "de" }]);
  });

  it("transcribesTheWholeFileWhenNoRangeAndNoDurationAreKnown", async () => {
    const log: string[] = [];
    const result = await transcribeMedia({ path: "/m/a.wav", backend: "openai" }, fakeDeps(log));
    expect(log[0]).toBe("extract all");
    expect(result.words[0].start).toBe(0.5);
  });

  it("rejectsWhenAlreadyAborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribeMedia({ path: "/m/a.wav", backend: "openai", signal: controller.signal }, fakeDeps([]))).rejects.toBeDefined();
  });
});

describe("transcribeCached", () => {
  it("callsTheProviderOnceThenServesFromCache", async () => {
    const io = makeFakeIo();
    io.addFile("/m/a.wav", "abc", 1000);
    setMediaIo(io);
    clearTranscriptMemory();
    const log: string[] = [];
    const req = { path: "/m/a.wav", range: { start: 0, end: 30 }, backend: "elevenlabs" as const };
    const first = await transcribeCached(req, fakeDeps(log));
    const calls = log.filter((l) => l.startsWith("transcribe")).length;
    clearTranscriptMemory();
    const second = await transcribeCached(req, fakeDeps(log));
    expect(calls).toBe(1);
    expect(log.filter((l) => l.startsWith("transcribe"))).toHaveLength(1);
    expect(second.words).toEqual(first.words);
    setMediaIo(undefined);
  });
});
