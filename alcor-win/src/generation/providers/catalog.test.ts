import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/backend", () => ({ httpFetch: vi.fn(), httpCancel: vi.fn(), httpDownload: vi.fn(), fsStat: vi.fn() }));

import "./index";
import { buildGoogleRequest, googleCatalog, parseInteractionImages } from "./google";
import { buildReplicateRequest, parsePrediction, replicateCatalog } from "./replicate";
import { allProviders, fullCatalog } from "./registry";
import type { CatalogEntry } from "./types";

describe("catalog integrity", () => {
  const all = fullCatalog();

  it("registers the five providers", () => {
    expect(allProviders().map((p) => p.id).sort()).toEqual(["elevenlabs", "fal", "google", "openai", "replicate"]);
  });

  it("has unique ids of the form <providerId>/<vendor id>", () => {
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
    for (const m of all) expect(m.id.startsWith(`${m.providerId}/`) && m.id.length > m.providerId.length + 1).toBe(true);
  });

  it("every entry belongs to its registering provider and has docs", () => {
    for (const p of allProviders()) for (const m of p.catalog) expect(m.providerId).toBe(p.id);
    for (const m of all) expect(m.docsUrl).toMatch(/^https:\/\//);
  });

  it("has valid capabilities", () => {
    for (const m of all) {
      expect(m.displayName.length).toBeGreaterThan(0);
      const caps = m.uiCapabilities;
      if (m.kind === "video") {
        expect(m.uiCapabilities.durations.length).toBeGreaterThan(0);
        expect(m.uiCapabilities.aspectRatios.length).toBeGreaterThan(0);
        expect(m.responseShape).toBe("video");
      } else if (m.kind === "image") {
        expect(m.uiCapabilities.aspectRatios.length).toBeGreaterThan(0);
        expect(m.uiCapabilities.maxImages).toBeGreaterThanOrEqual(1);
        expect(m.responseShape).toBe("images");
      } else if (m.kind === "audio") {
        expect(m.uiCapabilities.category).toMatch(/^(general|tts|music|sfx|cleanup|dubbing)$/);
        const r = m.uiCapabilities.durationRange;
        if (r) expect(r.defaultValue >= r.minimum && r.defaultValue <= r.maximum).toBe(true);
        expect(m.responseShape).toBe("audio");
      } else {
        expect(m.uiCapabilities.supportedTypes.length).toBeGreaterThan(0);
        for (const n of m.uiCapabilities.numericSettings ?? []) expect(n.defaultValue >= n.minimum && n.defaultValue <= n.maximum).toBe(true);
        for (const s of m.uiCapabilities.selectSettings ?? []) expect(s.options).toContain(s.defaultValue);
      }
      expect(caps).toBeDefined();
    }
  });

  it("covers every kind", () => {
    const count = (k: CatalogEntry["kind"]): number => all.filter((m) => m.kind === k).length;
    expect(count("video")).toBeGreaterThanOrEqual(4);
    expect(count("image")).toBeGreaterThanOrEqual(4);
    expect(count("upscale")).toBeGreaterThanOrEqual(2);
  });
});

describe("google", () => {
  const model = googleCatalog[0] as CatalogEntry;
  it("maps text and reference input to the Interactions API", () => {
    const p = { kind: "image" as const, prompt: "a pear", aspectRatio: "16:9", resolution: "2K", images: [], numImages: 1 };
    expect(buildGoogleRequest(model, p, []).body).toEqual({
      model: "gemini-nano-banana-2.1", input: "a pear", response_format: { type: "image", mime_type: "image/png", aspect_ratio: "16:9", image_size: "2K" },
    });
    const withRef = buildGoogleRequest(model, p, [{ mimeType: "image/png", base64: "QQ==" }]);
    expect(withRef.body.input).toEqual([{ type: "text", text: "a pear" }, { type: "image", mime_type: "image/png", data: "QQ==" }]);
    expect(() => buildGoogleRequest(model, p, Array.from({ length: 15 }, () => ({ mimeType: "image/png", base64: "" })))).toThrow(/14/);
  });

  it("parses model_output image steps and rejects incomplete interactions", () => {
    expect(parseInteractionImages({
      id: "i", status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }, { type: "image", data: "QUJD", mime_type: "image/jpeg" }] }],
    })).toEqual([{ data: "QUJD", ext: "jpg" }]);
    expect(() => parseInteractionImages({ status: "failed", steps: [], errors: [{ message: "blocked" }] })).toThrow(/blocked/);
    expect(() => parseInteractionImages({ status: "completed", steps: [] })).toThrow(/no image/);
  });
});

describe("replicate", () => {
  it("maps flux-2-pro to a custom size and music to prompt+lyrics", () => {
    const flux = replicateCatalog[0] as CatalogEntry;
    const r = buildReplicateRequest(flux, { kind: "image", prompt: "x", aspectRatio: "16:9", images: [], numImages: 1 });
    expect(r.url).toBe("https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions");
    expect(r.input).toEqual({ prompt: "x", aspect_ratio: "custom", width: 1360, height: 768, output_format: "png" });
    const music = replicateCatalog[1] as CatalogEntry;
    expect(() => buildReplicateRequest(music, { kind: "audio", prompt: "pop", instrumental: false })).toThrow(/lyrics/);
    expect(buildReplicateRequest(music, { kind: "audio", prompt: "pop", lyrics: "la", instrumental: false }).input).toEqual({ prompt: "pop", lyrics: "la" });
  });

  it("parses prediction payloads", () => {
    const body = { id: "abc", status: "succeeded", output: "https://replicate.delivery/x.webp", error: null, urls: { get: "https://api.replicate.com/v1/predictions/abc", cancel: "https://api.replicate.com/v1/predictions/abc/cancel" } };
    expect(parsePrediction(body)).toMatchObject({ status: "succeeded", output: ["https://replicate.delivery/x.webp"] });
    expect(parsePrediction({ status: "failed", error: "NSFW" })).toMatchObject({ status: "failed", error: "NSFW", output: [] });
    expect(() => parsePrediction({ status: "weird" })).toThrow();
  });
});
