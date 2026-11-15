import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/backend", () => ({ httpFetch: vi.fn(), httpCancel: vi.fn(), httpDownload: vi.fn() }));

import { buildOpenAIRequest, imageSize, openAICatalog, parseImageResponse, parseWhisper } from "./openai";
import type { AudioParams, CatalogEntry, ImageParams } from "./types";

const entry = (id: string): CatalogEntry => {
  const e = openAICatalog.find((c) => c.id === `openai/${id}`);
  if (!e) throw new Error(id);
  return e;
};
const image = (over: Partial<ImageParams> = {}): ImageParams => ({ kind: "image", prompt: "a fox", aspectRatio: "1:1", images: [], numImages: 1, ...over });

describe("openai request mapping", () => {
  it("generates with explicit model, size, quality and n", () => {
    const r = buildOpenAIRequest(entry("gpt-image-2"), image({ aspectRatio: "16:9", resolution: "1K", quality: "high", numImages: 2 }));
    expect(r.url).toBe("https://api.openai.com/v1/images/generations");
    expect(r.body).toEqual({
      kind: "json", value: { model: "gpt-image-2", prompt: "a fox", size: "1360x768", n: 2, output_format: "png", quality: "high" },
    });
  });

  it("gpt-image-2 sizes are multiples of 16 within 3840x2160 and 3:1", () => {
    for (const a of ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"]) {
      for (const res of ["1K", "2K"]) {
        const [w, h] = imageSize("gpt-image-2", a, res).split("x").map(Number) as [number, number];
        expect(w % 16).toBe(0);
        expect(h % 16).toBe(0);
        expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
        expect(Math.min(w, h)).toBeLessThanOrEqual(2160);
      }
    }
  });

  it("gpt-image-1.5 uses the three fixed sizes only", () => {
    expect(imageSize("gpt-image-1.5", "3:2")).toBe("1536x1024");
    expect(() => imageSize("gpt-image-1.5", "16:9")).toThrow();
  });

  it("edits with references use multipart image[]", () => {
    const r = buildOpenAIRequest(entry("gpt-image-2"), image({ images: [{ path: "C:\\a.png", type: "image" }] }));
    expect(r.url).toBe("https://api.openai.com/v1/images/edits");
    if (r.body.kind !== "multipart") throw new Error("expected multipart");
    expect(r.body.parts).toContainEqual({ name: "image[]", filename: "a.png", contentType: "image/png", value: { kind: "file", path: "C:\\a.png" } });
  });

  it("speech sends instructions only for gpt-4o-mini-tts", () => {
    const p: AudioParams = { kind: "audio", prompt: "hi", voice: "cedar", styleInstructions: "warm", instrumental: false };
    expect(buildOpenAIRequest(entry("gpt-4o-mini-tts"), p).body).toEqual({
      kind: "json", value: { model: "gpt-4o-mini-tts", input: "hi", voice: "cedar", response_format: "mp3", instructions: "warm" },
    });
    expect(buildOpenAIRequest(entry("tts-1"), p).body).toEqual({
      kind: "json", value: { model: "tts-1", input: "hi", voice: "cedar", response_format: "mp3" },
    });
    expect(() => buildOpenAIRequest(entry("tts-1"), { ...p, prompt: "x".repeat(4097) })).toThrow(/4096/);
  });
});

describe("openai response parsing", () => {
  it("reads b64_json images", () => {
    expect(parseImageResponse({ created: 1, data: [{ b64_json: "AAAA" }, { b64_json: "BBBB" }], usage: {} })).toEqual(["AAAA", "BBBB"]);
    expect(() => parseImageResponse({ data: [] })).toThrow();
  });

  it("reads whisper verbose_json words", () => {
    expect(parseWhisper({ task: "transcribe", language: "english", duration: 1, text: "Hi there", words: [{ word: "Hi", start: 0, end: 0.4 }, { word: "there", start: 0.4, end: 0.9 }] })).toEqual({
      text: "Hi there", language: "english", words: [{ text: "Hi", start: 0, end: 0.4 }, { text: "there", start: 0.4, end: 0.9 }],
    });
  });
});
