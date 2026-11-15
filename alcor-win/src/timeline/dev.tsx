// Browser-only preview of the timeline pane: `?dev=timeline`, stress mode `?dev=timeline&stress=1`. Not used by the app.
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  makeClip,
  makeKeyframe,
  makeKeyframeTrack,
  makeMediaAsset,
  makeRGBA,
  makeTimelineMarker,
  makeTrack,
  mediaAssetToManifestEntry,
  type Clip,
  type MediaAsset,
  type Track,
} from "../model";
import { Editor, makeEditorDocument } from "../editor/editor";
import type { ClipThumbnails, ImageTile, TimelineVisualSource } from "./view/visualSource";
import { TimelinePane } from "./view/TimelinePane";
import type { TimelineRenderStats } from "./view/TimelineCanvas";

const fps = 30;
const stress = new URLSearchParams(location.search).get("stress") === "1";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function tile(hue: number, label: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 120;
  c.height = 68;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 120, 68);
  g.addColorStop(0, `hsl(${hue} 45% 35%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 18%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 120, 68);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "12px sans-serif";
  ctx.fillText(label, 6, 60);
  return c;
}

/** Synthetic thumbnails and waveforms so the page renders without Tauri or real media. */
export function fakeVisuals(): TimelineVisualSource {
  const strips = new Map<string, ClipThumbnails>();
  const tiles = new Map<string, ImageTile>();
  const waves = new Map<string, Float32Array>();
  return {
    thumbnails(asset) {
      let s = strips.get(asset.id);
      if (!s) {
        const hue = (asset.id.charCodeAt(0) * 37) % 360;
        const count = Math.max(1, Math.ceil(asset.duration / 2));
        const frames = Array.from({ length: Math.min(count, 12) }, (_, i) => tile(hue + i * 6, `${i * 2}s`));
        s = { images: Array.from({ length: count }, (_, i) => frames[i % frames.length] ?? null), startTime: 0, spacing: 2, aspect: 120 / 68 };
        strips.set(asset.id, s);
      }
      return s;
    },
    imageTile(asset) {
      let t = tiles.get(asset.id);
      if (!t) {
        t = { image: tile(280, asset.name), aspect: 120 / 68 };
        tiles.set(asset.id, t);
      }
      return t;
    },
    waveform(asset) {
      let w = waves.get(asset.id);
      if (!w) {
        const rand = seeded(asset.id.length * 97 + asset.name.length);
        w = new Float32Array(Math.max(1, Math.round(asset.duration * 200)));
        let env = 0.5;
        for (let i = 0; i < w.length; i++) {
          env = Math.min(0.95, Math.max(0.05, env + (rand() - 0.5) * 0.08));
          w[i] = Math.min(1, Math.max(0, env + (rand() - 0.5) * 0.25));
        }
        waves.set(asset.id, w);
      }
      return w;
    },
  };
}

function asset(id: string, type: MediaAsset["type"], name: string, duration: number, hasAudio = type === "video"): MediaAsset {
  const a = makeMediaAsset({ id, url: `C:/Media/${name}`, type, name, duration });
  a.hasAudio = hasAudio;
  return a;
}

export function realisticDocument() {
  const doc = makeEditorDocument();
  const assets = [
    asset("V1", "video", "Interview A.mov", 90),
    asset("V2", "video", "B-roll Street.mp4", 40),
    asset("V3", "video", "Drone Coast.mov", 30),
    asset("A1", "audio", "Score Main Theme.wav", 120, false),
    asset("A2", "audio", "Room Tone.wav", 60, false),
    asset("I1", "image", "Logo.png", 5, false),
  ];
  const linked = (start: number, dur: number, media: string, trim = 0) => {
    const g = `link-${media}-${start}`;
    const v = makeClip({ mediaRef: media, mediaType: "video", sourceClipType: "video", startFrame: start, durationFrames: dur, trimStartFrame: trim, trimEndFrame: 600, linkGroupId: g });
    const a = makeClip({ mediaRef: media, mediaType: "audio", sourceClipType: "video", startFrame: start, durationFrames: dur, trimStartFrame: trim, trimEndFrame: 600, linkGroupId: g });
    return [v, a] as const;
  };
  const [v1, a1] = linked(0, 300, "V1");
  const [v2, a2] = linked(300, 240, "V2", 60);
  const [v3, a3] = linked(620, 260, "V1", 900);
  v1.fadeInFrames = 20;
  v3.fadeOutFrames = 45;
  v3.fadeOutInterpolation = "smooth";
  v2.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1), makeKeyframe(90, 0.4), makeKeyframe(200, 1)]);
  a3.startFrame += 3;
  const broll = makeClip({ mediaRef: "V3", mediaType: "video", sourceClipType: "video", startFrame: 150, durationFrames: 210, trimEndFrame: 690 });
  const logo = makeClip({ mediaRef: "I1", mediaType: "image", sourceClipType: "image", startFrame: 700, durationFrames: 150 });
  const title = makeClip({ mediaRef: "text-1", mediaType: "text", sourceClipType: "text", startFrame: 30, durationFrames: 120, textContent: "Palmier Pro\nA film by the coast" });
  const music = makeClip({ mediaRef: "A1", mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: 900, trimEndFrame: 2700, volume: 0.6, fadeInFrames: 30, fadeOutFrames: 90 });
  music.volumeTrack = makeKeyframeTrack([makeKeyframe(0, -12), makeKeyframe(300, -6, "linear"), makeKeyframe(600, -18), makeKeyframe(880, -6)]);
  const tone = makeClip({ mediaRef: "A2", mediaType: "audio", sourceClipType: "audio", startFrame: 240, durationFrames: 360, trimEndFrame: 1440 });

  const timeline = doc.timelines[0];
  if (!timeline) throw new Error("no timeline");
  timeline.name = "Main Edit";
  timeline.fps = fps;
  timeline.tracks = [
    makeTrack({ type: "text", clips: [title], name: "Titles" }),
    makeTrack({ type: "video", clips: [broll, logo] }),
    makeTrack({ type: "video", clips: [v1, v2, v3] }),
    makeTrack({ type: "audio", clips: [a1, a2, a3] }),
    makeTrack({ type: "audio", clips: [music], name: "Music" }),
    makeTrack({ type: "audio", clips: [tone] }),
  ];
  timeline.markers = [
    makeTimelineMarker({ name: "Intro", startFrame: 90 }),
    makeTimelineMarker({ name: "Review", startFrame: 420, durationFrames: 120, color: makeRGBA({ r: 0.95, g: 0.78, b: 0.18, a: 1 }) }),
  ];
  doc.mediaAssets = assets;
  doc.mediaManifest.entries = assets.map((a) => mediaAssetToManifestEntry(a, undefined));
  return doc;
}

function stressDocument() {
  const doc = makeEditorDocument();
  const rand = seeded(42);
  const assets = [asset("SV", "video", "Stress Video.mp4", 600), asset("SA", "audio", "Stress Audio.wav", 600, false), asset("SI", "image", "Still.png", 5, false)];
  const tracks: Track[] = [];
  let total = 0;
  for (let t = 0; t < 30; t++) {
    const audio = t >= 20;
    const clips: Clip[] = [];
    let frame = 0;
    for (let i = 0; i < 167 && total < 5000; i++, total++) {
      frame += Math.floor(rand() * 20);
      const dur = 30 + Math.floor(rand() * 90);
      const media = audio ? "SA" : rand() < 0.15 ? "SI" : "SV";
      const type = media === "SA" ? "audio" : media === "SI" ? "image" : "video";
      clips.push(makeClip({ mediaRef: media, mediaType: type, sourceClipType: type, startFrame: frame, durationFrames: dur, trimStartFrame: Math.floor(rand() * 600), trimEndFrame: 9000 }));
      frame += dur;
    }
    tracks.push(makeTrack({ type: audio ? "audio" : "video", clips }));
  }
  const timeline = doc.timelines[0];
  if (!timeline) throw new Error("no timeline");
  timeline.name = "Stress";
  timeline.tracks = tracks;
  doc.mediaAssets = assets;
  doc.mediaManifest.entries = assets.map((a) => mediaAssetToManifestEntry(a, undefined));
  return doc;
}

interface Stat {
  last: number;
  max: number;
  avg: number;
  n: number;
}
const emptyStat = (): Stat => ({ last: 0, max: 0, avg: 0, n: 0 });
function push(s: Stat, v: number): Stat {
  const n = s.n + 1;
  return { last: v, max: Math.max(s.max, v), avg: s.avg + (v - s.avg) / n, n };
}

export default function TimelineDev() {
  const editor = new Editor(stress ? stressDocument() : realisticDocument());
  editor.ui.currentFrame = 120;
  const [clips, setClips] = createSignal(emptyStat());
  const [overlay, setOverlay] = createSignal(emptyStat());
  const [latency, setLatency] = createSignal(emptyStat());
  let pendingInput: number | undefined;

  const onStats = (s: TimelineRenderStats) => {
    if (s.clipsMs > 0) setClips((p) => push(p, s.clipsMs));
    if (s.overlayMs > 0) setOverlay((p) => push(p, s.overlayMs));
    if (pendingInput !== undefined) {
      const ms = performance.now() - pendingInput;
      // Frames throttled while the page is hidden would skew the input-to-paint figure.
      if (ms < 250) setLatency((p) => push(p, ms));
      pendingInput = undefined;
    }
  };

  onMount(() => {
    const onInput = (e: Event) => {
      pendingInput ??= e.timeStamp;
    };
    window.addEventListener("pointermove", onInput, true);
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("wheel", onInput, true);
    // Stand-in for the preview engine: advance the playhead while "playing".
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      if (editor.ui.isPlaying && !editor.ui.isScrubbing) {
        const frames = Math.floor(((t - last) * fps) / 1000);
        if (frames > 0) {
          editor.ui.currentFrame += frames;
          last += (frames * 1000) / fps;
        }
      } else last = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onInput, true);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("wheel", onInput, true);
    });
  });

  const fmt = (s: Stat) => `${s.last.toFixed(2)} ms (avg ${s.avg.toFixed(2)}, max ${s.max.toFixed(2)}, n ${s.n})`;
  const reset = () => {
    setClips(emptyStat());
    setOverlay(emptyStat());
    setLatency(emptyStat());
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div style={{ flex: "1", "min-height": "0", background: "var(--bg-base)", display: "grid", "place-items": "center", color: "var(--text-muted)" }}>
        Preview (not part of this page) · Space plays · {stress ? "stress: 5,000 clips / 30 tracks" : "realistic sample"}
      </div>
      <div id="timeline-dev-stats" style={{ padding: "4px 10px", "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--text-tertiary)", display: "flex", gap: "16px" }}>
        <span>clips layer: {fmt(clips())}</span>
        <span>overlay: {fmt(overlay())}</span>
        <span>input→paint: {fmt(latency())}</span>
        <button type="button" onClick={reset} style={{ "text-decoration": "underline" }}>
          reset
        </button>
      </div>
      <div style={{ flex: "0 0 45%", "min-height": "0", "border-top": "1px solid var(--border-panel)" }}>
        <TimelinePane editor={editor} visuals={fakeVisuals()} timelineFocused={() => true} onRenderStats={onStats} />
      </div>
    </div>
  );
}
