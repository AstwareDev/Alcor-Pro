import { describe, expect, it, vi } from "vitest";
import { makeMediaAsset } from "../model";
import { Editor } from "../editor/editor";
import type { GenerationService } from "./generationService";
import {
  buildAudioParams, buildGenerationInput, classifyReferences, submitQuickGeneration, validateQuickGeneration,
} from "./quickGeneration";
import { audioEntry, imageEntry, videoEntry } from "./testFixtures";

const asset = (id: string, type: "image" | "video" | "audio") => makeMediaAsset({ id, url: `/${id}`, type, name: id, duration: 1 });

describe("quick generation", () => {
  const veo = videoEntry("v", { supportsFirstFrame: true, supportsLastFrame: true, maxReferenceVideos: 1 });

  it("buildsInputWithOnlyFieldsTheModelUses", () => {
    const input = buildGenerationInput(veo, { prompt: "p", duration: 5, aspectRatio: "16:9", resolution: "1080p", voice: "x", lyrics: "l" });
    expect(input).toMatchObject({ prompt: "p", model: "v", duration: 5, aspectRatio: "16:9", resolution: "1080p" });
    expect(input.voice).toBeUndefined();
    expect(input.lyrics).toBeUndefined();
  });

  it("buildsAudioParamsFromCapabilities", () => {
    const tts = audioEntry("t", { voices: ["a"], durations: [5] });
    const params = buildAudioParams(tts, { prompt: "hi", duration: 5, aspectRatio: "", voice: "a" }, 5);
    expect(params).toMatchObject({ kind: "audio", prompt: "hi", voice: "a", durationSeconds: 5, instrumental: false });
  });

  it("classifiesReferencesIntoFrameAndRefSlots", () => {
    const out = classifyReferences(veo, [asset("a", "image"), asset("b", "image"), asset("c", "video")]);
    expect(out.video.frames.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out.video.videoRefs.map((f) => f.id)).toEqual(["c"]);
    expect(out.rejected).toEqual([]);
    const img = classifyReferences(imageEntry("i", { supportsImageReference: false }), [asset("a", "image")]);
    expect(img.rejected).toHaveLength(1);
  });

  it("rejectsEmptyPromptsAndSourceOnlyModels", () => {
    expect(validateQuickGeneration({ entry: veo, settings: { prompt: " ", duration: 5, aspectRatio: "16:9", resolution: "1080p" }, references: [] })).toBe("Enter a prompt.");
    const edit = videoEntry("e", { requiresSourceVideo: true });
    expect(validateQuickGeneration({ entry: edit, settings: { prompt: "x", duration: 5, aspectRatio: "16:9" }, references: [] })).toContain("source video");
  });

  it("submitsThroughServiceGenerate", () => {
    const generate = vi.fn(() => "new-id");
    const service = { generate } as unknown as GenerationService;
    const editor = new Editor();
    const result = submitQuickGeneration(editor, service, {
      entry: imageEntry("i"), settings: { prompt: "a cat", duration: 0, aspectRatio: "1:1" }, references: [],
    });
    expect(result).toEqual({ id: "new-id" });
    expect(generate).toHaveBeenCalledTimes(1);
    const plan = (generate.mock.calls[0] as unknown[])[1] as { assetType: string; genInput: { prompt: string } };
    expect(plan.assetType).toBe("image");
    expect(plan.genInput.prompt).toBe("a cat");
  });
});
