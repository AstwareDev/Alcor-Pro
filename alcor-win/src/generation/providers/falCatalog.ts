import type { AudioCaps, CatalogEntry, ImageCaps, UpscaleCaps, VideoCaps } from "./types";

// Every endpoint, enum and range below was read from fal's machine-readable model schemas
// (https://api.fal.ai/v1/models?endpoint_id=...&expand=openapi-3.0), the data behind each https://fal.ai/models/<id>/api page.

const docs = (endpoint: string): string => `https://fal.ai/models/${endpoint}/api`;

function videoCaps(c: Partial<VideoCaps> & Pick<VideoCaps, "durations" | "aspectRatios">): VideoCaps {
  return {
    supportsFirstFrame: false,
    supportsLastFrame: false,
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    framesAndReferencesExclusive: false,
    referenceTagNoun: "Image",
    requiresSourceVideo: false,
    requiresReferenceImage: false,
    ...c,
  };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const video = (
  id: string, displayName: string, iconKey: string, providerName: string, endpoint: string, description: string, uiCapabilities: VideoCaps,
): CatalogEntry => ({
  id: `fal/${id}`, providerId: "fal", displayName, providerIconKey: iconKey, providerName, description,
  responseShape: "video", docsUrl: docs(endpoint), kind: "video", uiCapabilities,
});

const image = (
  id: string, displayName: string, iconKey: string, providerName: string, endpoint: string, description: string, uiCapabilities: ImageCaps,
): CatalogEntry => ({
  id: `fal/${id}`, providerId: "fal", displayName, providerIconKey: iconKey, providerName, description,
  responseShape: "images", docsUrl: docs(endpoint), kind: "image", uiCapabilities,
});

const upscale = (
  id: string, displayName: string, iconKey: string, providerName: string, type: "video" | "image", uiCapabilities: UpscaleCaps,
): CatalogEntry => ({
  id: `fal/${id}`, providerId: "fal", displayName, providerIconKey: iconKey, providerName,
  responseShape: type === "video" ? "video" : "upscaledImage", docsUrl: docs(id), kind: "upscale", uiCapabilities,
});

const audio = (
  id: string, displayName: string, iconKey: string, providerName: string, description: string, uiCapabilities: AudioCaps,
): CatalogEntry => ({
  id: `fal/${id}`, providerId: "fal", displayName, providerIconKey: iconKey, providerName, description,
  responseShape: "audio", docsUrl: docs(id), kind: "audio", uiCapabilities,
});

const noLyrics = { supportsLyrics: false, supportsInstrumental: false, supportsStyleInstructions: false };

export const falCatalog: readonly CatalogEntry[] = [
  video("bytedance/seedance-2.0", "Seedance 2.0", "bytedance", "ByteDance", "bytedance/seedance-2.0/text-to-video",
    "Text, first/last-frame and multi-reference video with native audio.",
    videoCaps({
      durations: range(4, 15), resolutions: ["480p", "720p", "1080p", "4k"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      supportsFirstFrame: true, supportsLastFrame: true, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      maxTotalReferences: 12, maxCombinedVideoRefSeconds: 15, maxCombinedAudioRefSeconds: 15, framesAndReferencesExclusive: true,
      supportsGenerateAudio: true,
    })),
  video("kling/v4", "Kling 4.0", "kling", "Kling", "kling/v4/text-to-video", "Text and first/last-frame video, 3 to 30 seconds.",
    videoCaps({
      durations: range(3, 30), resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16", "1:1", "21:9"],
      supportsFirstFrame: true, supportsLastFrame: true, framesAndReferencesExclusive: true,
    })),
  video("minimax/h3", "MiniMax H3", "minimax", "MiniMax", "minimax/h3/text-to-video", "Text and first/last-frame video, 5 to 15 seconds.",
    videoCaps({
      durations: range(5, 15), resolutions: ["480P", "768P", "2K", "4K"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      supportsFirstFrame: true, supportsLastFrame: true,
    })),
  video("xai/grok-imagine-video/v1.5", "Grok Imagine Video 1.5", "xai", "xAI", "xai/grok-imagine-video/v1.5/text-to-video",
    "Text and image-to-video, 1 to 15 seconds.",
    videoCaps({
      durations: range(1, 15), resolutions: ["480p", "720p", "1080p"], aspectRatios: ["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"],
      supportsFirstFrame: true,
    })),

  image("fal-ai/nano-banana-pro", "Nano Banana Pro", "google", "Google", "fal-ai/nano-banana-pro", "Gemini 3 Pro Image with editing from references.",
    {
      resolutions: ["1K", "2K", "4K"],
      aspectRatios: ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "4:1", "1:4", "8:1", "1:8"],
      supportsImageReference: true, maxImages: 4,
    }),
  image("blackforestlabs/flux-3", "FLUX.3", "blackforestlabs", "Black Forest Labs", "blackforestlabs/flux-3/text-to-image", "FLUX.3 text-to-image and multi-image editing.",
    {
      resolutions: ["768sq", "1k", "1.5k", "2k", "4k"],
      aspectRatios: ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2"],
      supportsImageReference: true, maxImages: 1,
    }),
  image("bytedance/seedream/v5/pro", "Seedream 5.0 Pro", "bytedance", "ByteDance", "bytedance/seedream/v5/pro/text-to-image", "Seedream 5.0 Pro generation and editing.",
    {
      resolutions: ["1K", "1.5K", "2K"], aspectRatios: ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
      supportsImageReference: true, maxImages: 6,
    }),
  image("ideogram/v4.5", "Ideogram 4.5", "ideogram", "Ideogram", "ideogram/v4.5", "Ideogram 4.5 text-to-image with strong typography.",
    { aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"], qualities: ["low", "medium", "high"], supportsImageReference: false, maxImages: 8 }),

  upscale("fal-ai/seedvr/upscale/video", "SeedVR2 Video", "bytedance", "ByteDance", "video", {
    speed: "Slow", p75DurationSeconds: 180, supportedTypes: ["video"],
    numericSettings: [{ key: "upscale_factor", label: "Upscale factor", minimum: 1, maximum: 10, step: 0.5, defaultValue: 2 }],
  }),
  upscale("fal-ai/seedvr/upscale/image", "SeedVR2 Image", "bytedance", "ByteDance", "image", {
    speed: "Fast", p75DurationSeconds: 30, supportedTypes: ["image"],
    numericSettings: [{ key: "upscale_factor", label: "Upscale factor", minimum: 1, maximum: 10, step: 0.5, defaultValue: 2 }],
  }),
  upscale("fal-ai/topaz/upscale/video", "Topaz Video Upscale", "topaz", "Topaz Labs", "video", {
    speed: "Slow", p75DurationSeconds: 300, maximumUpscaleFactor: 4, supportedTypes: ["video"],
    selectSettings: [{
      key: "model", label: "Model", defaultValue: "Proteus",
      options: ["Proteus", "Artemis HQ", "Artemis MQ", "Artemis LQ", "Gaia HQ", "Gaia CG", "Gaia 2", "Nyx", "Nyx Fast", "Nyx XL", "Nyx HF",
        "Starlight Precise 2.5", "Starlight HQ", "Starlight Mini", "Starlight Sharp", "Starlight Fast 2", "Starlight Precise 1", "Starlight Precise 2", "Starlight Fast 1"],
    }],
    numericSettings: [{ key: "upscale_factor", label: "Upscale factor", minimum: 1, maximum: 4, step: 0.5, defaultValue: 2 }],
  }),
  upscale("fal-ai/topaz/upscale/image", "Topaz Image Upscale", "topaz", "Topaz Labs", "image", {
    speed: "Medium", p75DurationSeconds: 60, maximumUpscaleFactor: 4, supportedTypes: ["image"],
    selectSettings: [{
      key: "model", label: "Model", defaultValue: "Standard V2",
      options: ["Standard V2", "High Fidelity V2", "Low Resolution V2", "CGI", "Text Refine", "Wonder 3", "Wonder", "Standard MAX", "Redefine", "Recovery V2", "Recovery"],
    }],
    numericSettings: [{ key: "upscale_factor", label: "Upscale factor", minimum: 1, maximum: 4, step: 0.5, defaultValue: 2 }],
  }),

  audio("mirelo-ai/sfx2.0/video-to-audio", "Mirelo SFX 2.0 (video to sound)", "mirelo", "Mirelo", "Sound effects that match a video.",
    { category: "sfx", ...noLyrics, minPromptLength: 0, inputs: ["video"], promptLabel: "Describe the sound (optional)", minSeconds: 1, maxSeconds: 600 }),
  audio("sonilo/v1.1/video-to-music", "Sonilo 1.1 (video to music)", "sonilo", "Sonilo", "Music that fits a video.",
    { category: "music", ...noLyrics, minPromptLength: 0, inputs: ["video"], promptLabel: "Describe the music (optional)", minSeconds: 1, maxSeconds: 600 }),
  audio("sonilo/v1.1/video-to-sound-effects", "Sonilo 1.1 (video to sound effects)", "sonilo", "Sonilo", "Sound effects that match a video.",
    { category: "sfx", ...noLyrics, minPromptLength: 0, inputs: ["video"], promptLabel: "Describe the sound (optional)", minSeconds: 1, maxSeconds: 600 }),
  audio("sonilo/v1.1/text-to-music", "Sonilo 1.1 Text to Music", "sonilo", "Sonilo", "Music from a text description.",
    { category: "music", ...noLyrics, minPromptLength: 3, durationRange: { minimum: 1, maximum: 600, defaultValue: 90 }, promptLabel: "Describe the music" }),
  audio("sonilo/v1.1/text-to-sound-effects", "Sonilo 1.1 Text to Sound Effects", "sonilo", "Sonilo", "Sound effects from a text description.",
    { category: "sfx", ...noLyrics, minPromptLength: 3, durationRange: { minimum: 1, maximum: 180, defaultValue: 8 }, promptLabel: "Describe the sound" }),
];
