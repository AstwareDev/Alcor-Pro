import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/backend", () => ({
  fsStat: vi.fn(), httpFetch: vi.fn(), httpCancel: vi.fn(), httpDownload: vi.fn(), httpFetchBytes: vi.fn(),
  fsWriteBytes: vi.fn(), appPaths: vi.fn(),
}));

import { buildFalRequest, extractFalOutputs, parseFalStatus } from "./fal";
import { falCatalog } from "./falCatalog";
import type { CatalogEntry, ImageParams, LocalReference, VideoParams } from "./types";

const entry = (id: string): CatalogEntry => {
  const found = falCatalog.find((e) => e.id === `fal/${id}`);
  if (!found) throw new Error(id);
  return found;
};
const ref = (path: string, type: LocalReference["type"] = "image"): LocalReference => ({ path, type });
const url = (r: LocalReference): string => `https://v3.fal.media/${r.path}`;

const video = (over: Partial<VideoParams> = {}): VideoParams => ({
  kind: "video", prompt: "a cat", duration: 5, aspectRatio: "16:9", resolution: "720p",
  referenceImages: [], referenceVideos: [], referenceAudios: [], generateAudio: true, ...over,
});
const image = (over: Partial<ImageParams> = {}): ImageParams => ({
  kind: "image", prompt: "a dog", aspectRatio: "1:1", images: [], numImages: 1, ...over,
});

describe("fal request mapping", () => {
  it("seedance text-to-video sends duration as a string enum", () => {
    expect(buildFalRequest(entry("bytedance/seedance-2.0"), video({ duration: 8 }), url)).toEqual({
      endpoint: "bytedance/seedance-2.0/text-to-video",
      input: { prompt: "a cat", resolution: "720p", duration: "8", aspect_ratio: "16:9", generate_audio: true },
    });
  });

  it("seedance routes first/last frame to image-to-video", () => {
    const r = buildFalRequest(entry("bytedance/seedance-2.0"), video({ startFrame: ref("a.png"), endFrame: ref("b.png") }), url);
    expect(r.endpoint).toBe("bytedance/seedance-2.0/image-to-video");
    expect(r.input.image_url).toBe("https://v3.fal.media/a.png");
    expect(r.input.end_image_url).toBe("https://v3.fal.media/b.png");
  });

  it("seedance routes references to reference-to-video and omits empty lists", () => {
    const r = buildFalRequest(entry("bytedance/seedance-2.0"), video({ referenceImages: [ref("a.png")], referenceAudios: [ref("a.wav", "audio")] }), url);
    expect(r.endpoint).toBe("bytedance/seedance-2.0/reference-to-video");
    expect(r.input.image_urls).toEqual(["https://v3.fal.media/a.png"]);
    expect(r.input.audio_urls).toEqual(["https://v3.fal.media/a.wav"]);
    expect(r.input).not.toHaveProperty("video_urls");
  });

  it("kling v4 uses integer duration and start_image_url", () => {
    expect(buildFalRequest(entry("kling/v4"), video({ duration: 10, resolution: "1080p" }), url).input).toEqual({
      prompt: "a cat", duration: 10, resolution: "1080p", aspect_ratio: "16:9",
    });
    const i2v = buildFalRequest(entry("kling/v4"), video({ startFrame: ref("a.png") }), url);
    expect(i2v.endpoint).toBe("kling/v4/image-to-video");
    expect(i2v.input.start_image_url).toBe("https://v3.fal.media/a.png");
  });

  it("minimax h3 and grok map frames", () => {
    expect(buildFalRequest(entry("minimax/h3"), video({ startFrame: ref("a.png"), endFrame: ref("b.png") }), url).endpoint).toBe("minimax/h3/image-to-video");
    expect(buildFalRequest(entry("xai/grok-imagine-video/v1.5"), video({ startFrame: ref("a.png") }), url).endpoint).toBe("xai/grok-imagine-video/v1.5/image-to-video");
  });

  it("nano banana pro switches to /edit with references", () => {
    expect(buildFalRequest(entry("fal-ai/nano-banana-pro"), image({ resolution: "2K", numImages: 2 }), url)).toEqual({
      endpoint: "fal-ai/nano-banana-pro",
      input: { prompt: "a dog", aspect_ratio: "1:1", resolution: "2K", num_images: 2 },
    });
    const edit = buildFalRequest(entry("fal-ai/nano-banana-pro"), image({ images: [ref("a.png")] }), url);
    expect(edit.endpoint).toBe("fal-ai/nano-banana-pro/edit");
    expect(edit.input.image_urls).toEqual(["https://v3.fal.media/a.png"]);
  });

  it("seedream computes explicit multiple-of-16 sizes inside the documented pixel range", () => {
    const r = buildFalRequest(entry("bytedance/seedream/v5/pro"), image({ aspectRatio: "16:9", resolution: "2K" }), url);
    const size = r.input.image_size as { width: number; height: number };
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width * size.height).toBeGreaterThanOrEqual(921600);
    expect(size.width * size.height).toBeLessThanOrEqual(4624220);
  });

  it("ideogram maps aspect to preset and rejects others", () => {
    expect(buildFalRequest(entry("ideogram/v4.5"), image({ aspectRatio: "9:16", quality: "high" }), url).input).toEqual({
      prompt: "a dog", image_size: "portrait_16_9", quality: "high", num_images: 1,
    });
    expect(() => buildFalRequest(entry("ideogram/v4.5"), image({ aspectRatio: "21:9" }), url)).toThrow(/aspect ratio/);
  });

  it("upscalers use their own source key and settings", () => {
    const up = { kind: "upscale" as const, source: ref("v.mp4", "video"), durationSeconds: 3, settings: { upscale_factor: 2, model: "Proteus" } };
    expect(buildFalRequest(entry("fal-ai/topaz/upscale/video"), up, url).input).toEqual({
      video_url: "https://v3.fal.media/v.mp4", upscale_factor: 2, model: "Proteus",
    });
    expect(buildFalRequest(entry("fal-ai/seedvr/upscale/video"), up, url).input).toEqual({
      video_url: "https://v3.fal.media/v.mp4", upscale_mode: "factor", upscale_factor: 2,
    });
  });

  it("video-to-audio requires a video", () => {
    const a = { kind: "audio" as const, prompt: "", instrumental: false };
    expect(() => buildFalRequest(entry("sonilo/v1.1/video-to-music"), a, url)).toThrow(/source video/);
    expect(buildFalRequest(entry("sonilo/v1.1/video-to-music"), { ...a, video: ref("v.mp4", "video") }, url).input).toEqual({
      video_url: "https://v3.fal.media/v.mp4", num_samples: 1,
    });
  });
});

describe("fal response parsing", () => {
  it("parses documented status payloads", () => {
    expect(parseFalStatus({ status: "IN_QUEUE", request_id: "x", queue_position: 2 })).toEqual({ state: "queued", queuePosition: 2 });
    expect(parseFalStatus({ status: "IN_PROGRESS", logs: [] })).toEqual({ state: "running" });
    expect(parseFalStatus({ status: "COMPLETED", metrics: { inference_time: 3.4 } })).toEqual({ state: "completed" });
    expect(parseFalStatus({ status: "COMPLETED", error: "boom", error_type: "x" })).toEqual({ state: "completed", error: "boom", errorType: "x" });
    expect(() => parseFalStatus({ status: "WAT" })).toThrow();
  });

  it("extracts outputs from each result shape", () => {
    expect(extractFalOutputs({ video: { url: "https://v3.fal.media/f.mp4" }, seed: 1 })).toEqual([{ url: "https://v3.fal.media/f.mp4" }]);
    expect(extractFalOutputs({ images: [{ url: "https://a/1.png" }, { url: "https://a/2.png" }] })).toHaveLength(2);
    expect(extractFalOutputs({ image: { url: "https://a/u.png" }, seed: 1 })).toEqual([{ url: "https://a/u.png" }]);
    expect(extractFalOutputs({ audio: [{ url: "https://a/1.wav" }], model: "m" })).toEqual([{ url: "https://a/1.wav" }]);
    expect(extractFalOutputs({ audio: { url: "https://a/m.mp3" }, audios: [{ url: "https://a/m.mp3" }] })).toEqual([{ url: "https://a/m.mp3" }]);
    expect(extractFalOutputs({})).toEqual([]);
  });
});
