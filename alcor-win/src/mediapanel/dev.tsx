// Browser-only preview of MediaPanelView: `?dev=mediapanel` (add `&stress=1` for 5,000 assets). Not used by the app.
import { createSignal, onCleanup, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import {
  makeGenerationInput, makeMediaAsset, makeMediaFolder, makeTimeline, type ClipType, type MediaAsset, type MediaFolder,
} from "../model";
import { fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { MediaPanelView } from "./MediaPanelView";
import type { MediaPanelServices } from "./services";
import type { ThumbnailProvider, ThumbnailSource } from "./thumbnailProvider";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic gradient poster per path, produced after a short delay to exercise lazy loading and abort. */
export const fakeProvider: ThumbnailProvider = {
  peek: () => undefined,
  isLive: () => true,
  load: ({ path }, signal) =>
    new Promise<ThumbnailSource | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const h = hash(path);
        const canvas = document.createElement("canvas");
        const portrait = h % 7 === 0;
        canvas.width = portrait ? 90 : 160;
        canvas.height = portrait ? 160 : 90;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          g.addColorStop(0, `hsl(${h % 360} 55% 38%)`);
          g.addColorStop(1, `hsl(${(h >> 8) % 360} 60% 22%)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "rgb(255 255 255 / 0.18)";
          ctx.beginPath();
          ctx.arc(canvas.width * ((h >> 4) % 100) / 100, canvas.height / 2, canvas.height / 3, 0, Math.PI * 2);
          ctx.fill();
        }
        resolve(canvas);
      }, 30 + (hash(path) % 120));
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    }),
};

const names = ["juicymarbles", "sunset", "city", "interview", "broll", "wave", "forest", "macro", "drone", "market"];

function buildDocument(count: number) {
  const doc = makeEditorDocument();
  const folders: MediaFolder[] = [];
  const top = ["Animals", "Locations", "Music", "Interviews"].map((name) => makeMediaFolder({ name }));
  folders.push(...top);
  folders.push(makeMediaFolder({ name: "Birds", parentFolderId: top[0].id }));
  folders.push(makeMediaFolder({ name: "Insects", parentFolderId: top[0].id }));
  folders.push(makeMediaFolder({ name: "Tokyo", parentFolderId: top[1].id }));
  folders.push(makeMediaFolder({ name: "Day 1", parentFolderId: folders[6].id }));
  const assets: MediaAsset[] = [];
  const types: ClipType[] = ["video", "video", "image", "audio", "video", "image"];
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    const ext = type === "video" ? "mp4" : type === "image" ? "png" : "wav";
    const name = `${names[i % names.length]}_${(i * 7919).toString(16).slice(0, 4)}_${i}`;
    const asset = makeMediaAsset({
      url: `C:/fake/${name}.${ext}`, type, name, duration: type === "image" ? 0 : 2 + ((i * 13) % 140),
    });
    if (i % 5 !== 0) asset.folderId = folders[i % folders.length].id;
    if (i % 11 === 0) asset.generationInput = makeGenerationInput({ prompt: "p", model: "m", duration: 5, aspectRatio: "16:9" });
    assets.push(asset);
  }
  doc.mediaAssets = assets;
  doc.mediaManifest.folders = folders;
  const clips = assets.filter((a) => a.type === "video").slice(0, 4).map((a, i) =>
    fixtureClip({ mediaRef: a.id, start: i * 90, duration: 90 }));
  const main = makeTimeline({ name: "Aesthetic video", tracks: [fixtureVideoTrack({ clips })] });
  const second = makeTimeline({ name: "Interview Cut", folderId: top[3].id, tracks: [] });
  doc.timelines = [main, second];
  doc.activeTimelineId = main.id;
  doc.openTimelineIds = [main.id];
  return { doc, assets };
}

export default function MediaPanelDev() {
  const stress = new URLSearchParams(location.search).get("stress") === "1";
  const { doc, assets } = buildDocument(stress ? 5000 : 40);
  const editor = new Editor(doc);
  // One missing asset shows the offline overlay.
  editor.ui.missingMediaRefs = new Set([assets[3].id]);
  const [frames, setFrames] = createSignal("scroll the grid to measure");
  let counter = 0;
  const services: MediaPanelServices = {
    pickMediaFiles: () => Promise.resolve([`C:/fake/imported_${++counter}.mp4`]),
    pickFolder: () => Promise.resolve(null),
    pickRelinkFile: () => Promise.resolve(null),
    revealInExplorer: (paths) => {
      editor.showToast(`Show in Explorer: ${paths.length} file(s)`);
      return Promise.resolve();
    },
    copyText: () => Promise.resolve(),
    importPaths: (ed, paths, folderId) => {
      for (const path of paths) {
        const asset = makeMediaAsset({ url: path, type: "video", name: path.split("/").pop() ?? path, duration: 12 });
        if (folderId !== undefined) asset.folderId = folderId;
        ed.withoutRegistration(() => ed.doc.mediaAssets.push(asset));
      }
      return Promise.resolve();
    },
  };

  onMount(() => {
    if (!stress) return;
    let last = performance.now();
    let worst = 0;
    let over16 = 0;
    let total = 0;
    let running = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const tick = (now: number) => {
      if (!running) return;
      const dt = now - last;
      last = now;
      total += 1;
      worst = Math.max(worst, dt);
      if (dt > 20) over16 += 1;
      requestAnimationFrame(tick);
    };
    const onScroll = () => {
      if (!running) {
        running = true;
        last = performance.now();
        worst = 0;
        over16 = 0;
        total = 0;
        requestAnimationFrame(tick);
      }
      clearTimeout(idle);
      idle = setTimeout(() => {
        running = false;
        setFrames(`last scroll: ${total} frames, worst ${worst.toFixed(1)} ms, ${over16} frames > 20 ms`);
      }, 250);
    };
    document.addEventListener("scroll", onScroll, true);
    onCleanup(() => document.removeEventListener("scroll", onScroll, true));
  });

  return (
    <div style={{ padding: "16px", display: "flex", gap: "16px", "align-items": "flex-start" }}>
      <div style={{ width: "500px", height: "560px", border: "1px solid var(--border-primary)", "border-radius": "6px", overflow: "hidden" }}>
        <MediaPanelView
          editor={editor}
          thumbnailProvider={fakeProvider}
          services={services}
          onGenerate={() => editor.showToast("Generate panel is not built yet")}
        />
      </div>
      <div style={{ "font-size": "12px", color: "var(--text-tertiary)", "max-width": "240px" }}>
        <div>{stress ? "stress: 5,000 assets" : "40 assets, 2 timelines"}</div>
        <div id="frame-report">{frames()}</div>
      </div>
    </div>
  );
}
