import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpCall, McpResourceRequest, McpTool, McpToolResult } from "../platform/backend";
import { makeAsset, makeEditor } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { makeFakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { createGenerationService, setGenerationService, type GenerationDeps } from "../generation/generationService";
import { makePollingJobRunner } from "../generation/jobRunner";
import { musicHooks } from "../generation/musicGeneration";
import { registerProvider, setProvidersWithKeys } from "../generation/providers/registry";
import type { JobState } from "../generation/providers/types";
import { audioEntry, fakeProvider, imageEntry, upscaleEntry, videoEntry } from "../generation/testFixtures";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import "./tools/generationGroup";
import { agentToolHooks } from "./tools/toolHooks";

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  responses = new Map<string, McpToolResult>();
  resources = new Map<string, string | null>();
  call: ((c: McpCall) => void) | null = null;
  resource: ((r: McpResourceRequest) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; }
  async setInstructions() {}
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient() { return () => undefined; }
  async onResource(h: (r: McpResourceRequest) => void) { this.resource = h; return () => { this.resource = null; }; }
  async respondResource(id: string, text: string | null) { this.resources.set(id, text); }
}

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    onCurrentEditorChange: () => () => undefined,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };
const placeholderOf = (editor: Editor, message: string) => {
  const short = /ID: ([0-9A-F-]{8,36})/.exec(message)?.[1] ?? "";
  return editor.mediaAssets.find((a) => a.id.startsWith(short));
};
const text = (r: McpToolResult | undefined): string => ((r?.content[0] ?? {}) as { text?: string }).text ?? "";

const video = videoEntry("fal/test-video", {
  durations: [5, 10], aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], supportsFirstFrame: true,
  maxReferenceImages: 2, referenceTagNoun: "Image",
}, { displayName: "Test Video" });
const image = imageEntry("openai/test-image", { aspectRatios: ["1:1", "16:9"], resolutions: ["1K"], qualities: ["low", "high"] });
const music = audioEntry("elevenlabs/test-tts", { category: "tts", voices: ["Ava", "Ben", "Cy", "Di"], defaultVoice: "Ava", minPromptLength: 3 });
const scoring = audioEntry("elevenlabs/test-score", {
  category: "general", inputs: ["video"], minSeconds: 1, maxSeconds: 60, minPromptLength: 0,
  durationRange: { minimum: 1, maximum: 60, defaultValue: 10 },
});
const upscaler = upscaleEntry("fal/test-upscale", {
  supportedTypes: ["video", "image"],
  selectSettings: [{ key: "targetResolution", label: "Target", options: ["1080p", "4k"], defaultValue: "1080p" }],
  numericSettings: [{ key: "noise", label: "Noise", minimum: 0, maximum: 1, step: 0.1, defaultValue: 0 }],
  toggleSettings: [{ key: "sharpen", label: "Sharpen", defaultValue: false }],
});

const script = (): JobState => ({ status: "succeeded", outputs: [{ path: "/out/result.bin" }] });
const provider = fakeProvider([video, upscaler], script);
// Each catalog entry's provider id must resolve in the registry; the extra providers share the submit log.
const openai = { ...fakeProvider([image], script), id: "openai" as const, submitted: provider.submitted, submit: provider.submit, status: provider.status };
const elevenlabs = { ...openai, id: "elevenlabs" as const, catalog: [music, scoring] };

function deps(): GenerationDeps {
  return {
    jobs: () => makePollingJobRunner(() => 1),
    ops: { extractTrim: async () => "/tmp/trim.mp4", convertImageToJPEG: async (p) => p, removeTempFiles: async () => undefined },
    fetchOutput: async (source) => source,
    commitStaged: async (_e, _s, filename) => `/proj/media/${filename}`,
    finalize: async (editor, id) => {
      editor.withoutRegistration(() => {
        const a = editor.doc.mediaAssets.find((x) => x.id === id);
        if (a) { a.generationStatus = { kind: "none" }; }
      });
      return true;
    },
    tempDirHint: () => "/tmp",
  };
}

async function setup(): Promise<{ backend: FakeBackend; editor: Editor; run: (name: string, args: unknown) => Promise<McpToolResult> }> {
  const editor = makeEditor([]);
  editor.withoutRegistration(() => {
    editor.doc.mediaAssets.push(
      makeAsset({ id: "IMG00001-0000-0000-0000-000000000001", type: "image", duration: 5, sourceWidth: 640, sourceHeight: 360 }),
      makeAsset({ id: "VID00001-0000-0000-0000-000000000002", type: "video", duration: 4, hasAudio: true, sourceWidth: 640, sourceHeight: 360 }),
    );
    const clip = editor.doc.mediaAssets[1];
    if (clip) clip.sourceFPS = 24;
  });
  const backend = new FakeBackend();
  await startAgentMcpBridge(fakeHost(editor), { backend });
  let n = 0;
  const run = async (name: string, args: unknown): Promise<McpToolResult> => {
    const id = `call-${++n}`;
    backend.call?.({ id, name, arguments: args });
    await settle();
    const res = backend.responses.get(id);
    if (!res) throw new Error(`no response for ${name}`);
    return res;
  };
  return { backend, editor, run };
}

beforeEach(() => {
  setMediaIo(makeFakeIo());
  registerProvider(provider);
  registerProvider(openai);
  registerProvider(elevenlabs);
  setProvidersWithKeys(["fal", "openai", "elevenlabs"]);
  setGenerationService(createGenerationService(deps()));
  provider.submitted.length = 0;
});
afterEach(() => {
  setMediaIo(undefined);
  setGenerationService(undefined);
  setProvidersWithKeys([]);
  musicHooks.renderTimelineSpan = undefined as never;
});

describe("MCP bridge: generation tools", () => {
  it("advertises the five generation tools and reports canGenerate from provider keys", async () => {
    const { backend } = await setup();
    const names = backend.tools.map((t) => t.name);
    for (const n of ["list_models", "generate_video", "generate_image", "generate_audio", "upscale_media"]) expect(names).toContain(n);
    const audioTool = backend.tools.find((t) => t.name === "generate_audio");
    const properties = (audioTool?.inputSchema as { properties: Record<string, unknown> }).properties;
    // GenerateAudioSchemaTests.mcpSchemaExposesSeedAudioOptions
    expect(properties["referenceImageMediaRefs"]).toBeDefined();
    expect(properties["referenceAudioMediaRefs"]).toBeDefined();
    expect(properties["multilingual"]).toBeDefined();
    expect(agentToolHooks.canGenerate?.()).toBe(true);
    setProvidersWithKeys([]);
    expect(agentToolHooks.canGenerate?.()).toBe(false);
  });

  it("list_models lists usable models by type and says so when no key is stored", async () => {
    const { run } = await setup();
    const all = JSON.parse(text(await run("list_models", {})));
    expect(all.loaded).toBe(true);
    const ids = (all.models as { id: string; type: string }[]).map((m) => `${m.type}:${m.id}`);
    expect(ids).toEqual([
      "video:fal/test-video", "image:openai/test-image", "audio:elevenlabs/test-tts", "audio:elevenlabs/test-score", "upscale:fal/test-upscale",
    ]);
    const v = all.models[0];
    expect(v).toMatchObject({ durations: [5, 10], supportsFirstFrame: true, supportsReferences: true, maxReferenceImages: 2, referenceTagNoun: "Image" });
    const tts = all.models[2];
    expect(tts).toMatchObject({ category: "tts", voicesSample: ["Ava", "Ben", "Cy"], voiceCount: 4, defaultVoice: "Ava", inputs: ["text"] });
    const up = JSON.parse(text(await run("list_models", { type: "upscale" }))).models[0];
    expect(up.settings.map((s: { id: string; type: string }) => `${s.id}:${s.type}`)).toEqual(["targetResolution:select", "noise:number", "sharpen:boolean"]);

    setProvidersWithKeys(["openai"]);
    const some = JSON.parse(text(await run("list_models", {})));
    expect(some.models.map((m: { id: string }) => m.id)).toEqual(["openai/test-image"]);
    setProvidersWithKeys([]);
    const none = JSON.parse(text(await run("list_models", {})));
    expect(none.models).toEqual([]);
    expect(none.note).toContain("API key");
  });

  it("generate_video validates, submits to the provider and creates a placeholder asset", async () => {
    const { run, editor } = await setup();
    const bad = await run("generate_video", { prompt: "a cat", duration: 7 });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("does not support duration '7s'");
    expect((await run("generate_video", { prompt: "", model: "fal/test-video" })).isError).toBe(true);
    expect(text(await run("generate_video", { prompt: "x", model: "nope" }))).toContain("Unknown model 'nope'. Available: fal/test-video");
    expect(text(await run("generate_video", { prompt: "x", draft: true }))).toContain("does not support draft generation");

    const res = await run("generate_video", { prompt: "a cat", duration: 10, aspectRatio: "9:16", startFrameMediaRef: "IMG00001" });
    expect(res.isError).toBeUndefined();
    const message = text(res);
    expect(message).toMatch(/^Generation started\. Placeholder asset ID: [0-9A-F]{8}\./);
    expect(message).toContain("Model: Test Video, duration: 10s, aspect: 9:16");
    const placeholder = placeholderOf(editor, message);
    expect(placeholder?.type).toBe("video");
    await until(() => provider.submitted.length > 0);
    expect(provider.submitted).toHaveLength(1);
    expect(provider.submitted[0]).toMatchObject({ kind: "video", prompt: "a cat", duration: 10, aspectRatio: "9:16", resolution: "720p" });
    await until(() => placeholder?.generationStatus.kind === "none");
    expect(editor.mediaAsset(placeholder?.id ?? "")?.generationStatus.kind).toBe("none");
  });

  it("generate_image checks references and applies defaults", async () => {
    const { run } = await setup();
    const notImage = await run("generate_image", { prompt: "a dog", referenceMediaRefs: ["VID00001"] });
    expect(text(notImage)).toBe("referenceMediaRefs entry 'VID00001-0000-0000-0000-000000000002' must be an image asset (got video)");
    const res = await run("generate_image", { prompt: "a dog", referenceMediaRefs: ["IMG00001"] });
    expect(text(res)).toContain("Model: openai/test-image, aspect: 1:1");
    await until(() => provider.submitted.length > 0);
    expect(provider.submitted[0]).toMatchObject({ kind: "image", prompt: "a dog", aspectRatio: "1:1", quality: "high", numImages: 1 });
  });

  it("generate_audio runs text models and refuses short prompts and unknown voices", async () => {
    const { run } = await setup();
    expect(text(await run("generate_audio", { model: "elevenlabs/test-tts", prompt: "hi" }))).toContain("requires prompt");
    expect(text(await run("generate_audio", { model: "elevenlabs/test-tts", prompt: "hello", voice: "Zed" }))).toContain("does not support voice 'Zed'");
    const res = await run("generate_audio", { model: "elevenlabs/test-tts", prompt: "hello there" });
    expect(text(res)).toMatch(/^Generation started\. Placeholder asset ID: [0-9A-F]{8}\. Model: elevenlabs\/test-tts, Speech\. Place it with add_clips\.$/);
    await until(() => provider.submitted.length > 0);
    expect(provider.submitted[0]).toMatchObject({ kind: "audio", prompt: "hello there", voice: "Ava" });
  });

  it("generate_audio scores a timeline span and places the placeholder on a new audio track", async () => {
    const { run, editor } = await setup();
    const noSource = await run("generate_audio", { model: "elevenlabs/test-score", prompt: "tense" });
    expect(text(noSource)).toBe("Model 'elevenlabs/test-score' needs source media. Provide sourceMediaRef.");
    const noRender = await run("generate_audio", { model: "elevenlabs/test-score", videoSourceStartFrame: 0, videoSourceEndFrame: 90 });
    expect(noRender.isError).toBe(true);

    let renderedSpan: unknown;
    musicHooks.renderTimelineSpan = async (_e, span) => { renderedSpan = span; return "/tmp/span.mp4"; };
    musicHooks.removeTempFile = async () => undefined;
    const res = await run("generate_audio", { model: "elevenlabs/test-score", prompt: "tense", videoSourceStartFrame: 30, videoSourceEndFrame: 150 });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("Generation started and placed on the timeline at frame 30.");
    expect(renderedSpan).toEqual({ startFrame: 30, frameCount: 120 });
    const audioTrack = editor.timeline.tracks.find((t) => t.type === "audio");
    expect(audioTrack?.clips[0]).toMatchObject({ startFrame: 30, durationFrames: 120 });
    expect(editor.store.undoActionName).toBe("Add General (Agent)");
    await until(() => provider.submitted.length > 0);
    expect(provider.submitted[0]).toMatchObject({ kind: "audio", video: { path: "/tmp/span.mp4", type: "video" } });
  });

  it("upscale_media resolves settings and submits an upscale job", async () => {
    const { run, editor } = await setup();
    expect(text(await run("upscale_media", { mediaRef: "IMG00001", settings: { targetResolution: "8k" } }))).toBe("Unsupported targetResolution. Available: 1080p, 4k");
    expect(text(await run("upscale_media", { mediaRef: "IMG00001", settings: { noise: 2 } }))).toBe("noise must be between 0.0 and 1.0");
    expect(text(await run("upscale_media", { mediaRef: "IMG00001", settings: { sharpen: "yes" } }))).toBe("sharpen must be true or false");
    expect(text(await run("upscale_media", { mediaRef: "IMG00001", settings: { bogus: 1 } }))).toBe("Unknown upscale setting 'bogus'. Available: targetResolution, noise, sharpen");

    const res = await run("upscale_media", { mediaRef: "IMG00001", settings: { targetResolution: "4k", noise: 0.5, sharpen: true } });
    expect(text(res)).toMatch(/^Upscale started\. Placeholder asset ID: .*Model: fal\/test-upscale, source: IMG00001-/);
    expect(placeholderOf(editor, text(res))?.name).toBe("Upscaled IMG00001-0000-0000-0000-000000000001");
    await until(() => provider.submitted.length > 0);
    expect(provider.submitted[0]).toMatchObject({
      kind: "upscale", settings: { targetResolution: "4k", noise: 0.5, sharpen: true }, sourceWidth: 640, sourceHeight: 360,
    });
  });

  it("refuses a model whose provider has no API key", async () => {
    const { run } = await setup();
    setProvidersWithKeys(["openai", "elevenlabs"]);
    const res = await run("generate_video", { prompt: "a cat", model: "fal/test-video" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Model 'fal/test-video' needs a Fake API key");
    expect(text(await run("generate_video", { prompt: "a cat" }))).toContain("no provider API key");
  });

  it("serves the model catalog as MCP resources", async () => {
    const { backend } = await setup();
    backend.resource?.({ id: "r1", uri: "palmier://models/video" });
    backend.resource?.({ id: "r2", uri: "palmier://models/image" });
    backend.resource?.({ id: "r3", uri: "palmier://models/other" });
    await settle();
    const videoList = JSON.parse(backend.resources.get("r1") ?? "null");
    expect(videoList.map((m: { id: string }) => m.id)).toEqual(["fal/test-video"]);
    expect(videoList[0].type).toBeUndefined();
    expect(JSON.parse(backend.resources.get("r2") ?? "null")[0]).toMatchObject({ id: "openai/test-image", supportsImageReference: true });
    expect(backend.resources.get("r3")).toBeNull();
  });
});
