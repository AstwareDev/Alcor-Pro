// Catalog fixtures shared by the generation tests (only imported by *.test.ts and dev code).
import type {
  AudioCaps, CatalogEntry, ImageCaps, JobHandle, JobState, Provider, UpscaleCaps, VideoCaps,
} from "./providers/types";
import type { AudioEntry, ImageEntry, UpscaleEntry, VideoEntry } from "./modelConfig";

export const baseVideoCaps: VideoCaps = {
  durations: [5, 10],
  resolutions: ["1080p"],
  aspectRatios: ["16:9", "9:16"],
  supportsFirstFrame: false,
  supportsLastFrame: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0,
  framesAndReferencesExclusive: false,
  referenceTagNoun: "Video",
  requiresSourceVideo: false,
  requiresReferenceImage: false,
};

export function videoEntry(id: string, caps: Partial<VideoCaps> = {}, extra: Partial<CatalogEntry> = {}): VideoEntry {
  return {
    id, providerId: "fal", displayName: id, responseShape: "video", docsUrl: "https://example.com",
    kind: "video", uiCapabilities: { ...baseVideoCaps, ...caps }, ...extra,
  } as VideoEntry;
}

export const minimaxH3 = (): VideoEntry =>
  videoEntry("minimax-h3", {
    supportsPrompt: true,
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ["768P", "2K"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    maxTotalReferences: 12,
    maxCombinedVideoRefSeconds: 15,
    maxCombinedAudioRefSeconds: 15,
  }, { displayName: "MiniMax H3" });

export const sourceEditModel = (): VideoEntry =>
  videoEntry("kling-reframe", { requiresSourceVideo: true, maxSourceVideoSeconds: 10 }, { displayName: "Legacy Reframe" });

export function imageEntry(id: string, caps: Partial<ImageCaps> = {}): ImageEntry {
  return {
    id, providerId: "openai", displayName: id, responseShape: "images", docsUrl: "https://example.com", kind: "image",
    uiCapabilities: { aspectRatios: ["1:1", "16:9"], supportsImageReference: true, maxImages: 2, ...caps },
  };
}

export function audioEntry(id: string, caps: Partial<AudioCaps> = {}): AudioEntry {
  return {
    id, providerId: "elevenlabs", displayName: id, responseShape: "audio", docsUrl: "https://example.com", kind: "audio",
    uiCapabilities: { category: "tts", supportsLyrics: false, supportsInstrumental: false, supportsStyleInstructions: false, minPromptLength: 1, ...caps },
  };
}

export function upscaleEntry(id: string, caps: Partial<UpscaleCaps> = {}): UpscaleEntry {
  return {
    id, providerId: "fal", displayName: id, responseShape: "video", docsUrl: "https://example.com", kind: "upscale",
    uiCapabilities: { speed: "Fast", p75DurationSeconds: 30, supportedTypes: ["video", "image"], ...caps },
  };
}

/** A provider whose jobs are scripted by the test. */
export function fakeProvider(catalog: CatalogEntry[], script: (job: JobHandle, call: number) => JobState): Provider & { submitted: unknown[] } {
  const calls = new Map<string, number>();
  const submitted: unknown[] = [];
  return {
    id: "fal",
    displayName: "Fake",
    secretName: "FAKE",
    keyUrl: "https://example.com",
    catalog,
    submitted,
    checkKey: () => Promise.resolve({ ok: true }),
    submit: (model, params) => {
      submitted.push(params);
      return Promise.resolve({ providerId: "fal", modelId: model.id, ref: `job-${submitted.length}` });
    },
    status: (job) => {
      const n = (calls.get(job.ref) ?? 0) + 1;
      calls.set(job.ref, n);
      return Promise.resolve(script(job, n));
    },
  };
}
