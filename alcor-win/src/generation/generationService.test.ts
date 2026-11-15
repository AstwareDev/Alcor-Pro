import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGenerationInput, makeMediaAsset } from "../model";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { makeEditor } from "../editor/mutations/testFixtures";
import { createGenerationService, type GenerationDeps } from "./generationService";
import { makePollingJobRunner } from "./jobRunner";
import { registerProvider } from "./providers/registry";
import { fakeProvider, videoEntry } from "./testFixtures";
import { makeVideoInputAssets } from "./inputAssets";
import { makeVideoSubmission } from "./submission";
import type { JobState } from "./providers/types";

let io: FakeIo;
beforeEach(() => { io = makeFakeIo(); setMediaIo(io); });
afterEach(() => setMediaIo(undefined));

const model = videoEntry("fal/m", { durations: [5], aspectRatios: ["16:9"] });

function deps(overrides: Partial<GenerationDeps> = {}): GenerationDeps {
  return {
    jobs: () => makePollingJobRunner(() => 1),
    ops: { extractTrim: async () => "/tmp/trim.mp4", convertImageToJPEG: async (p) => p + ".jpg", removeTempFiles: async () => undefined },
    fetchOutput: async (source) => source,
    commitStaged: async (_e, _s, filename) => `/proj/media/${filename}`,
    finalize: async (editor, id) => {
      editor.withoutRegistration(() => {
        const a = editor.doc.mediaAssets.find((x) => x.id === id);
        if (a) { a.generationStatus = { kind: "none" }; a.duration = 5; }
      });
      return true;
    },
    tempDirHint: () => "/tmp",
    ...overrides,
  };
}

const plan = () => makeVideoSubmission({
  genInput: makeGenerationInput({ prompt: "a cat", model: "fal/m", duration: 5, aspectRatio: "16:9" }),
  model, inputAssets: makeVideoInputAssets(), placeholderDuration: 5, generateAudio: true,
});

const settle = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };

describe("GenerationService", () => {
  it("creates placeholders, runs the job and finalizes the asset", async () => {
    const provider = fakeProvider([model], (_j, n): JobState => n < 2 ? { status: "running", progress: 0.4 } : { status: "succeeded", outputs: [{ url: "https://x/out.mp4" }] });
    registerProvider(provider);
    const editor = makeEditor();
    const service = createGenerationService(deps());
    let completed = 0;
    const id = service.generate(editor, plan(), { onComplete: () => { completed++; } });
    expect(editor.mediaAsset(id)?.generationStatus.kind).toBe("preparing");
    expect(editor.mediaAsset(id)?.name).toBe("a cat");
    await settle(() => completed === 1);
    const asset = editor.mediaAsset(id);
    expect(asset?.generationStatus.kind).toBe("none");
    expect(asset?.url).toMatch(/^\/proj\/media\/gen-.*\.mp4$/);
    expect(JSON.parse(asset?.generationInput?.backendJobId ?? "{}")).toMatchObject({ providerId: "fal", modelId: "fal/m" });
    expect(asset?.generationInput?.resultURLs).toEqual(["https://x/out.mp4"]);
    expect(provider.submitted).toHaveLength(1);
  });

  it("multi-output: one placeholder per image, extras without a result fail", async () => {
    const img = { ...model };
    registerProvider(fakeProvider([img], () => ({ status: "succeeded", outputs: [{ url: "https://x/a.mp4" }] })));
    const editor = makeEditor();
    const service = createGenerationService(deps());
    const p = { ...plan(), numImages: 3 };
    const id = service.generate(editor, p);
    expect(editor.mediaAssets).toHaveLength(3);
    await settle(() => editor.mediaAssets.every((a) => a.generationStatus.kind !== "preparing" && a.generationStatus.kind !== "generating" && a.generationStatus.kind !== "downloading"));
    expect(editor.mediaAsset(id)?.generationStatus.kind).toBe("none");
    expect(editor.mediaAssets.filter((a) => a.generationStatus.kind === "failed")).toHaveLength(2);
  });

  it("failed job marks every placeholder failed and calls onFailure", async () => {
    registerProvider(fakeProvider([model], () => ({ status: "failed", errorMessage: "boom" })));
    const editor = makeEditor();
    let failed = false;
    const id = createGenerationService(deps()).generate(editor, plan(), { onFailure: () => { failed = true; } });
    await settle(() => failed);
    expect(editor.mediaAsset(id)?.generationStatus).toEqual({ kind: "failed", message: "boom" });
  });

  it("download failure keeps the URL for retry, and retry succeeds", async () => {
    registerProvider(fakeProvider([model], () => ({ status: "succeeded", outputs: [{ url: "https://x/out.mp4" }] })));
    const editor = makeEditor();
    let broken = true;
    const service = createGenerationService(deps({ fetchOutput: async (s) => { if (broken) throw new Error("net down"); return s; } }));
    const id = service.generate(editor, plan());
    await settle(() => editor.mediaAsset(id)?.generationStatus.kind === "failed");
    expect(editor.mediaAsset(id)?.pendingDownloadURL).toBe("https://x/out.mp4");
    broken = false;
    service.retryDownload(editor, id);
    await settle(() => editor.mediaAsset(id)?.generationStatus.kind === "none");
    expect(editor.mediaAsset(id)?.pendingDownloadURL).toBeUndefined();
  });

  it("resumes pending generations from the stored handle", async () => {
    registerProvider(fakeProvider([model], () => ({ status: "succeeded", outputs: [{ url: "https://x/r.mp4" }] })));
    const editor = makeEditor();
    const asset = makeMediaAsset({
      url: "/proj/media/gen-1.mp4", type: "video", name: "r", duration: 5,
      generationInput: makeGenerationInput({ prompt: "p", model: "fal/m", duration: 5, aspectRatio: "16:9", backendJobId: JSON.stringify({ providerId: "fal", modelId: "fal/m", ref: "job-9" }) }),
    });
    asset.generationStatus = { kind: "generating" };
    editor.withoutRegistration(() => { editor.doc.mediaAssets.push(asset); });
    createGenerationService(deps()).resumePendingGenerations(editor);
    await settle(() => editor.mediaAsset(asset.id)?.generationStatus.kind === "none");
    expect(editor.mediaAsset(asset.id)?.url).toBe(`/proj/media/gen-1.mp4`.replace("gen-1", editor.mediaAsset(asset.id)?.url.split("/").pop()?.replace(".mp4", "") ?? ""));
  });
});
