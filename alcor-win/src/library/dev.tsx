// Browser-only page for the Library: `?dev=library` (add `&offline=1` to see the "catalog unavailable" state).
// In-memory editor + fake file system. The default catalog is served from `buildCatalog()`; the slay LUT files are
// fetched for real from raw.githubusercontent.com so sha256 verification runs against the publisher's bytes.
import { createEffect, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeMediaAsset, makeClip, makeTextStyle, makeTimeline, makeTrack, type Effect } from "../model";
import { fixtureClip, fixtureVideoTrack } from "../model/fixtures";
import { parseCubeLUT, type CubeLUT } from "../preview/effects/lutLoader";
import { MediaPanelView } from "../mediapanel/MediaPanelView";
import { defaultCatalogUrl } from "./catalog";
import { buildCatalog } from "./packs/buildCatalog";
import { libraryPanelTab } from "./LibraryTab";
import type { LibraryServices } from "./libraryServices";
import type { InstallerFs } from "./packInstaller";
import { lookRenderer, sampleImage } from "./previews";
import { sha256Hex } from "./sha256";

const enc = new TextEncoder();
const root = "/dev/library";

function makeFakeFs(files: Map<string, string>): InstallerFs {
  const dirs = new Set<string>();
  const under = (p: string): string[] => [...files.keys()].filter((k) => k.startsWith(`${p}/`));
  return {
    mkdir: (p) => { dirs.add(p); return Promise.resolve(); },
    exists: (p) => Promise.resolve(files.has(p) || dirs.has(p) || under(p).length > 0),
    readText: (p) => { const v = files.get(p); return v === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(v); },
    writeText: (p, c) => { files.set(p, c); return Promise.resolve(); },
    rename: (from, to) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${from}/`)) { files.set(to + k.slice(from.length), files.get(k) as string); files.delete(k); }
      for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
      dirs.add(to);
      return Promise.resolve();
    },
    remove: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
      return Promise.resolve();
    },
    list: (p) => {
      const names = new Map<string, boolean>();
      for (const k of [...files.keys(), ...dirs]) if (k.startsWith(`${p}/`)) {
        const rest = k.slice(p.length + 1);
        const slash = rest.indexOf("/");
        names.set(slash > 0 ? rest.slice(0, slash) : rest, slash > 0 || dirs.has(k));
      }
      return Promise.resolve([...names].map(([name, isDir]) => ({ name, isDir })));
    },
  };
}

const soundSample = {
  count: 3, next: null, previous: null,
  results: [
    { id: 1234, name: "Rain on roof", username: "someone", license: "Attribution", duration: 12.5, url: "https://freesound.org/people/someone/sounds/1234/", tags: ["rain"], previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/1/1234-hq.mp3" } },
    { id: 55, name: "Thunder roll", username: "zed", license: "Creative Commons 0", duration: 8, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/55-hq.mp3" } },
    { id: 77, name: "Noncommercial hum", username: "nc", license: "Attribution NonCommercial", duration: 2, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/77-hq.mp3" } },
  ],
};

function buildEditor(): Editor {
  const doc = makeEditorDocument();
  const sampleAsset = makeMediaAsset({ id: "sample", url: "sample", type: "image", name: "sample" });
  sampleAsset.sourceWidth = 320;
  sampleAsset.sourceHeight = 180;
  doc.mediaAssets = [sampleAsset];
  const video = fixtureClip({ id: "clip-a", mediaRef: "sample", mediaType: "image", start: 0, duration: 150 });
  const video2 = fixtureClip({ id: "clip-b", mediaRef: "sample", mediaType: "image", start: 150, duration: 150 });
  const text = makeClip({
    id: "text-a", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 150,
    textContent: "Hello world", textStyle: makeTextStyle({ fontSize: 120 }),
  });
  const timeline = makeTimeline({
    name: "Dev", tracks: [makeTrack({ type: "video", clips: [text] }), fixtureVideoTrack({ clips: [video, video2] })],
  });
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  const editor = new Editor(doc);
  editor.ui.selectedClipIds = new Set(["clip-a"]);
  return editor;
}

export default function LibraryDev() {
  const offline = new URLSearchParams(location.search).get("offline") === "1";
  const editor = buildEditor();
  const files = new Map<string, string>();
  const fs = makeFakeFs(files);
  const [catalogFiles, setCatalogFiles] = createSignal<Map<string, string>>(new Map());
  const lutCache = new Map<string, CubeLUT | null>();
  let sounds = 0;

  const services: LibraryServices = {
    storage: localStorage,
    libraryRoot: () => Promise.resolve(root),
    installer: (r) => ({
      root: r,
      fs,
      download: async (url, dest, onProgress) => {
        const base = defaultCatalogUrl.slice(0, defaultCatalogUrl.lastIndexOf("/") + 1);
        const own = url.startsWith(base) ? catalogFiles().get(url.slice(base.length)) : undefined;
        const text = own ?? (url.startsWith("https://raw.githubusercontent.com/") ? await (await fetch(url)).text() : "");
        files.set(dest, text);
        onProgress(enc.encode(text).byteLength);
      },
      readBytes: (p) => Promise.resolve(enc.encode(files.get(p) ?? "")),
      sha256Hex,
    }),
    fetchText: async (url) => {
      if (offline && url === defaultCatalogUrl) throw new Error("Failed to fetch");
      const text = url === defaultCatalogUrl ? catalogFiles().get("index.json") : undefined;
      if (text === undefined) throw new Error("HTTP 404");
      return text;
    },
    fetchSoundSearch: () => Promise.resolve(soundSample),
    hasSoundKey: () => Promise.resolve(true),
    importSound: (ed, path) => {
      const asset = makeMediaAsset({ id: `sound-${++sounds}`, url: path, type: "audio", name: path.split("/").pop() ?? path, duration: 10 });
      ed.withoutRegistration(() => ed.doc.mediaAssets.push(asset));
      return Promise.resolve(asset.id);
    },
    openUrl: (url) => { editor.showToast(`Open: ${url}`); return Promise.resolve(); },
    copyText: (text) => navigator.clipboard.writeText(text),
    lutLoader: (onLoaded) => {
      const load = (path: string): CubeLUT | undefined => {
      const hit = lutCache.get(path);
      if (hit !== undefined) return hit ?? undefined;
      const text = files.get(path);
      if (text !== undefined) {
        lutCache.set(path, parseCubeLUT(text) ?? null);
        queueMicrotask(onLoaded);
      }
      return undefined;
      };
      return load;
    },
  };
  const loadLut = services.lutLoader(() => undefined);

  void buildCatalog().then((built) => setCatalogFiles(built.files));
  const tab = libraryPanelTab(editor, () => editor.showToast("Open Settings > API Keys"), services);

  // Stand-in for the main preview: the selected clip's effect stack over the sample scene.
  let previewCanvas: HTMLCanvasElement | undefined;
  const [stack, setStack] = createSignal<readonly Effect[]>([]);
  const [info, setInfo] = createSignal("");
  const refresh = (): void => {
    const clips = editor.timeline.tracks.flatMap((t) => t.clips);
    setInfo(clips.map((c) => `${c.id}: ${(c.effects ?? []).map((e) => e.type.split(".")[1]).join(", ") || "-"}${c.textAnimation ? ` [${c.textAnimation.preset}]` : ""}${c.textStyle ? ` {${c.textStyle.fontName}}` : ""}`).join("\n"));
    const sel = [...editor.ui.selectedClipIds][0];
    setStack(sel === undefined ? [] : (editor.clipFor(sel)?.effects ?? []));
  };
  createEffect(() => {
    const effects = stack();
    if (!previewCanvas) return;
    const renderer = lookRenderer();
    if (!renderer?.render(effects, previewCanvas, loadLut)) previewCanvas.getContext("2d")?.drawImage(sampleImage(), 0, 0, previewCanvas.width, previewCanvas.height);
  });
  onMount(() => {
    const timer = setInterval(refresh, 100);
    refresh();
    return () => clearInterval(timer);
  });

  const select = (...ids: string[]): void => { editor.ui.selectedClipIds = new Set(ids); refresh(); };

  return (
    <div style={{ padding: "16px", display: "flex", gap: "16px", "align-items": "flex-start" }}>
      <div style={{ width: "460px", height: "680px", border: "1px solid var(--border-primary)", "border-radius": "6px", overflow: "hidden" }}>
        <MediaPanelView editor={editor} extraTabs={[tab]} />
      </div>
      <div style={{ "font-size": "12px", color: "var(--text-secondary)", display: "flex", "flex-direction": "column", gap: "8px", width: "340px" }}>
        <canvas ref={previewCanvas} id="dev-preview" width={192} height={108} style={{ width: "336px", height: "189px", "border-radius": "6px" }} />
        <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
          <button type="button" onClick={() => select("clip-a")}>Select clip A</button>
          <button type="button" onClick={() => select("clip-a", "clip-b")}>Select A+B</button>
          <button type="button" onClick={() => select("text-a")}>Select text</button>
          <button type="button" onClick={() => select()}>Select none</button>
          <button type="button" id="dev-undo" onClick={() => { editor.undo(); refresh(); }}>Undo</button>
        </div>
        <pre id="dev-state" style={{ margin: 0, "white-space": "pre-wrap" }}>{info()}</pre>
        <div id="dev-toast">{editor.ui.toast?.message ?? ""}</div>
      </div>
    </div>
  );
}
