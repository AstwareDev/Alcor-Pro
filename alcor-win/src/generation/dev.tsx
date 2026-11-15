// Browser-only preview of the generation flow: `?dev=generation`. Media panel + generation panel against an in-memory
// editor and a fake provider whose jobs complete after a few seconds with procedurally generated media
// (gradient PNG stand-ins for image/video, a sine WAV for audio). Not used by the app.
import { createSignal } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeMediaAsset, makeTimeline, type MediaAsset } from "../model";
import { fixtureAudioTrack, fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { MediaPanelView } from "../mediapanel/MediaPanelView";
import type { MediaPanelServices } from "../mediapanel/services";
import type { ThumbnailProvider, ThumbnailSource } from "../mediapanel/thumbnailProvider";
import { AIEditTab } from "./AIEditTab";
import { audioPanelTab } from "./AudioPanelTabs";
import { GenerationPanel } from "./GenerationPanel";
import { createGenerationService, type GenerationDeps } from "./generationService";
import { aiEditAssetMenuItems } from "./aiEditMenu";
import { makePollingJobRunner } from "./jobRunner";
import { registerProvider, setProvidersWithKeys } from "./providers/registry";
import type { AudioCaps, CatalogEntry, JobHandle, JobState, Provider, VideoCaps } from "./providers/types";
import { ContextMenu } from "../ui/ContextMenu";

const videoCaps: VideoCaps = {
  durations: [5, 10], resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16", "1:1"],
  supportsFirstFrame: true, supportsLastFrame: true, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
  maxTotalReferences: 12, framesAndReferencesExclusive: true, referenceTagNoun: "Image", requiresSourceVideo: false,
  requiresReferenceImage: false, supportsGenerateAudio: true,
};
const audioBase: AudioCaps = { category: "tts", supportsLyrics: false, supportsInstrumental: false, supportsStyleInstructions: false, minPromptLength: 1 };

const catalog: CatalogEntry[] = [
  { id: "fal/seedance-2", providerId: "fal", providerName: "ByteDance", displayName: "Seedance 2", responseShape: "video", docsUrl: "https://example.com", kind: "video", uiCapabilities: videoCaps, price: { mode: "perSecond", usd: 0.12, byResolution: { "720p": 0.08 } } },
  { id: "fal/edit", providerId: "fal", providerName: "ByteDance", displayName: "Video Edit", responseShape: "video", docsUrl: "https://example.com", kind: "video", uiCapabilities: { ...videoCaps, requiresSourceVideo: true, maxSourceVideoSeconds: 10, supportsFirstFrame: false, supportsLastFrame: false, maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0, maxTotalReferences: undefined, framesAndReferencesExclusive: false }, price: { mode: "perSecond", usd: 0.2 } },
  { id: "fal/nano-banana", providerId: "fal", providerName: "Google", displayName: "Nano Banana", responseShape: "images", docsUrl: "https://example.com", kind: "image", uiCapabilities: { aspectRatios: ["1:1", "16:9", "9:16"], supportsImageReference: true, maxImages: 4, resolutions: ["1K", "2K"] }, price: { mode: "perImage", usd: 0.04 } },
  { id: "fal/music", providerId: "fal", displayName: "Music Gen", responseShape: "audio", docsUrl: "https://example.com", kind: "audio", uiCapabilities: { ...audioBase, category: "music", inputs: ["text", "video"], supportsInstrumental: true, durationRange: { minimum: 10, maximum: 120, defaultValue: 30 } }, price: { mode: "perSecond", usd: 0.01 } },
  { id: "elevenlabs/tts", providerId: "elevenlabs", displayName: "Eleven Speech", responseShape: "audio", docsUrl: "https://example.com", kind: "audio", uiCapabilities: { ...audioBase, voices: ["Rachel", "Adam"], defaultVoice: "Rachel" }, price: { mode: "perThousandChars", usd: 0.3 } },
  { id: "fal/upscale", providerId: "fal", displayName: "Topaz Upscale", responseShape: "upscaledImage", docsUrl: "https://example.com", kind: "upscale", uiCapabilities: { speed: "Fast", p75DurationSeconds: 30, supportedTypes: ["image", "video"], selectSettings: [{ key: "targetResolution", label: "Resolution", options: ["1080p", "4k"], defaultValue: "4k" }] }, price: { mode: "perSecond", usd: 0.1 } },
];

const startedAt = new Map<string, number>();
const fake: Provider = {
  id: "fal", displayName: "Fake fal", secretName: "FAL_KEY", keyUrl: "https://example.com", catalog: catalog.filter((c) => c.providerId === "fal"),
  checkKey: () => Promise.resolve({ ok: true }),
  submit: (model) => {
    const ref = String(startedAt.size + 1);
    startedAt.set(ref, performance.now());
    return Promise.resolve({ providerId: "fal", modelId: model.id, ref } satisfies JobHandle);
  },
  status: (job): Promise<JobState> => {
    const t = (performance.now() - (startedAt.get(job.ref) ?? 0)) / 4000;
    const url = job.modelId.includes("music") || job.modelId.includes("tts") ? wavUrl() : pngUrl(job.ref);
    return Promise.resolve(t >= 1 ? { status: "succeeded", outputs: [{ url }, { url }, { url }, { url }] } : { status: "running", progress: t });
  },
};
const fakeEleven: Provider = { ...fake, id: "elevenlabs", displayName: "Fake ElevenLabs", secretName: "ELEVENLABS_KEY", catalog: catalog.filter((c) => c.providerId === "elevenlabs") };

function pngUrl(seed: string): string {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 180;
  const ctx = c.getContext("2d");
  const h = (Number(seed) * 67) % 360;
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 320, 180);
    g.addColorStop(0, `hsl(${h} 60% 45%)`); g.addColorStop(1, `hsl(${(h + 80) % 360} 60% 25%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 180);
  }
  const bin = atob(c.toDataURL("image/png").split(",")[1]);
  return URL.createObjectURL(new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: "image/png" }));
}

function wavUrl(): string {
  const rate = 8000, n = rate * 2;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => [...s].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); buf.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true); buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  w(36, "data"); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 8000, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

const posterProvider: ThumbnailProvider = {
  peek: () => undefined,
  isLive: () => true,
  load: ({ path }) => {
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    const ctx = c.getContext("2d");
    const h = [...path].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % 360;
    if (ctx) { ctx.fillStyle = `hsl(${h} 55% 35%)`; ctx.fillRect(0, 0, 160, 90); }
    return Promise.resolve<ThumbnailSource>(c);
  },
};

export default function GenerationDev() {
  registerProvider(fake);
  registerProvider(fakeEleven);
  setProvidersWithKeys(["fal"]);

  const doc = makeEditorDocument();
  const mk = (name: string, type: "image" | "video" | "audio", w = 1920, h = 1080): MediaAsset => {
    const a = makeMediaAsset({ url: `C:/fake/${name}`, type, name, duration: type === "image" ? 5 : 8 });
    a.sourceWidth = w; a.sourceHeight = h; a.sourceFPS = 30;
    return a;
  };
  const seeds = [mk("beach.png", "image"), mk("city.png", "image", 1080, 1920), mk("interview.mp4", "video"), mk("theme.wav", "audio")];
  doc.mediaAssets = seeds;
  const v = seeds[2];
  const main = makeTimeline({ name: "Main", tracks: [fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: v.id, start: 0, duration: 240 })] }), fixtureAudioTrack()] });
  doc.timelines = [main]; doc.activeTimelineId = main.id; doc.openTimelineIds = [main.id];
  const editor = new Editor(doc);
  editor.ui.showGenerationPanel = true;

  const deps: GenerationDeps = {
    jobs: () => makePollingJobRunner(() => 500),
    ops: { extractTrim: (t) => Promise.resolve(t.sourceURL), convertImageToJPEG: (p) => Promise.resolve(p), removeTempFiles: () => Promise.resolve() },
    fetchOutput: (source) => Promise.resolve(source),
    commitStaged: (_e, staged) => Promise.resolve(staged),
    finalize: (ed, id) => {
      ed.withoutRegistration(() => {
        const a = ed.doc.mediaAssets.find((x) => x.id === id);
        if (!a) return;
        a.generationStatus = { kind: "none" };
        a.duration = a.type === "image" ? 5 : a.generationInput?.duration || 5;
        a.sourceWidth = 320; a.sourceHeight = 180; a.sourceFPS = 30;
      });
      return Promise.resolve(true);
    },
    tempDirHint: () => "C:/fake/tmp",
  };
  const service = createGenerationService(deps);
  const [menu, setMenu] = createSignal<{ x: number; y: number; asset: MediaAsset }>();
  const services: MediaPanelServices = {
    pickMediaFiles: () => Promise.resolve(null), pickFolder: () => Promise.resolve(null), pickRelinkFile: () => Promise.resolve(null),
    revealInExplorer: () => Promise.resolve(), copyText: () => Promise.resolve(), importPaths: () => Promise.resolve(),
  };
  const openSettings = () => editor.showToast("Open Settings → API keys (dev)");
  const toggleKey = () => setProvidersWithKeys(["fal", "elevenlabs"]);

  return (
    <div style={{ padding: "16px", display: "flex", gap: "16px", "align-items": "flex-start", color: "var(--text-primary)" }}>
      <div style={{ width: "460px", height: "720px", border: "1px solid var(--border-primary)", "border-radius": "6px", overflow: "hidden" }}>
        <MediaPanelView
          editor={editor}
          thumbnailProvider={posterProvider}
          services={services}
          onGenerate={() => { editor.ui.showGenerationPanel = !editor.ui.showGenerationPanel; }}
          generationPanel={() => <GenerationPanel editor={editor} onOpenSettings={openSettings} thumbnailProvider={posterProvider} service={service} />}
          extraTabs={[audioPanelTab(editor, openSettings)]}
        />
      </div>
      <div style={{ width: "280px", display: "flex", "flex-direction": "column", gap: "8px", "font-size": "12px" }}>
        <button type="button" onClick={toggleKey}>Pretend ElevenLabs key was added</button>
        <button type="button" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, asset: seeds[2] })}>AI Edit menu for interview.mp4</button>
        <div style={{ border: "1px solid var(--border-primary)", "border-radius": "6px" }}>
          <AIEditTab editor={editor} asset={seeds[2]} />
        </div>
      </div>
      {menu() && <ContextMenu x={menu()?.x ?? 0} y={menu()?.y ?? 0} items={aiEditAssetMenuItems(editor, seeds[2])} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
