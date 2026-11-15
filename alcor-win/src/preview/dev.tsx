import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } from "mediabunny";
import { Show, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeStaticEffect } from "../model/effect";
import { makeMediaAsset, type MediaAsset } from "../model/mediaAsset";
import { makeTextAnimation } from "../model/textAnimation";
import { makeRGBA, makeTextShadow, makeTextStyle } from "../model/textStyle";
import { makeClip, makeTimeline, makeTrack, makeTransform, type Timeline } from "../model/timeline";
import { runGpuSelfTest, type SelfTestResult } from "./devSelfTest";
import { buildFrameGraph } from "./frameGraph";
import type { PlaybackEngine } from "./playback";
import { PreviewView } from "./PreviewView";
import type { SourceFrame, TextureProvider } from "./renderer";

const fps = 30;
const seconds = 4;

async function encodeTestVideo(width: number, height: number, hue: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const make = async (codec: "avc" | "vp9"): Promise<Blob> => {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 0.5 });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let i = 0; i < fps * seconds; i++) {
      const t = i / fps;
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, `hsl(${hue + t * 40}, 70%, 35%)`);
      g.addColorStop(1, `hsl(${hue + 120 + t * 40}, 70%, 60%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(width * (0.1 + 0.8 * (t / seconds)), height / 2 + Math.sin(t * 3) * height * 0.3, height * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold ${Math.round(height / 8)}px sans-serif`;
      ctx.fillText(`${hue}° frame ${i}`, width * 0.05, height * 0.15);
      await source.add(t, 1 / fps);
    }
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("no output");
    return new Blob([buffer], { type: "video/mp4" });
  };
  try {
    return await make("avc");
  } catch {
    return make("vp9");
  }
}

function toneWav(durationSec: number): Blob {
  const rate = 48000, n = Math.round(rate * durationSec);
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); data.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true);
  str(36, "data"); data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    data.setInt16(44 + i * 4, Math.sin(2 * Math.PI * 440 * t) * 0.25 * 32767, true);
    data.setInt16(46 + i * 4, Math.sin(2 * Math.PI * 660 * t) * 0.15 * 32767, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

async function imagePng(): Promise<Blob> {
  const c = new OffscreenCanvas(800, 800);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#f2c94c";
  ctx.beginPath();
  ctx.arc(400, 400, 380, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.font = "bold 120px sans-serif";
  ctx.fillText("PNG", 270, 440);
  return c.convertToBlob({ type: "image/png" });
}

async function buildDemo(): Promise<Editor> {
  const [videoA, videoB, png] = await Promise.all([encodeTestVideo(1920, 1080, 200), encodeTestVideo(1920, 1080, 20), imagePng()]);
  const asset = (id: string, blob: Blob, type: MediaAsset["type"], w?: number, h?: number): MediaAsset => {
    const a = makeMediaAsset({ id, url: URL.createObjectURL(blob), type, name: id, duration: type === "image" ? 0 : seconds });
    if (w && h) {
      a.sourceWidth = w;
      a.sourceHeight = h;
    }
    return a;
  };
  const assets = [
    asset("videoA", videoA, "video", 1920, 1080),
    asset("videoB", videoB, "video", 1920, 1080),
    asset("image", png, "image", 800, 800),
    asset("tone", toneWav(seconds), "audio"),
  ];
  const dur = fps * seconds * 2;
  const v = (p: Parameters<typeof makeClip>[0]) => makeClip({ sourceClipType: p.mediaType ?? "video", ...p });
  const text = makeClip({
    mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: dur,
    textContent: "Palmier preview on WebGL2",
    textStyle: makeTextStyle({ fontSize: 110, isBold: true, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }), shadow: makeTextShadow({ enabled: true }) }),
    textAnimation: makeTextAnimation({ preset: "wordReveal", perWordFrames: 8 }),
    transform: makeTransform({ centerY: 0.85, width: 0.9, height: 0.2 }),
  });
  const timeline: Timeline = makeTimeline({
    name: "Timeline 1", fps, width: 1920, height: 1080,
    tracks: [
      makeTrack({ type: "video", clips: [text] }),
      makeTrack({ type: "video", clips: [v({ mediaRef: "image", mediaType: "image", startFrame: 30, durationFrames: 120, transform: makeTransform({ centerX: 0.85, centerY: 0.2, width: 0.2, height: 0.3555 }), fadeInFrames: 15 })] }),
      makeTrack({ type: "video", clips: [v({ mediaRef: "videoB", startFrame: 0, durationFrames: fps * seconds, transform: makeTransform({ centerX: 0.3, centerY: 0.35, width: 0.4, height: 0.4, rotation: 8 }), edgeRounding: 0.2, effects: [makeStaticEffect("color.exposure", { ev: 0.5 }), makeStaticEffect("color.saturation", { amount: 1.4 })] }), v({ mediaRef: "videoB", startFrame: fps * seconds, durationFrames: fps * seconds, speed: 1, transform: makeTransform({ centerX: 0.3, centerY: 0.35, width: 0.4, height: 0.4 }) })] }),
      makeTrack({ type: "video", clips: [v({ mediaRef: "videoA", startFrame: 0, durationFrames: dur / 2, transform: makeTransform({ centerX: 0.72, centerY: 0.6, width: 0.45, height: 0.45 }), blendMode: "screen" })] }),
      makeTrack({ type: "video", clips: [v({ mediaRef: "videoA", startFrame: 0, durationFrames: dur, speed: 0.5, effects: [makeStaticEffect("color.contrast", { amount: 1.2 }), makeStaticEffect("color.temperature", { temperature: 5200, tint: 10 })] })] }),
      makeTrack({ type: "audio", clips: [makeClip({ mediaRef: "tone", mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: fps * seconds, fadeInFrames: 15, fadeOutFrames: 30 })] }),
    ],
  });
  const doc = makeEditorDocument();
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  doc.mediaAssets = assets;
  return new Editor(doc);
}

// Hidden panes throttle rAF; the timeout keeps the measurement loop moving.
const nextFrame = (): Promise<void> => new Promise((r) => {
  requestAnimationFrame(() => r());
  setTimeout(r, 50);
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Render cost of the demo graph: CPU submit, and submit + 1px readback (forces the GPU to finish). */
async function measurePerformance(editor: Editor, engine: PlaybackEngine): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  engine.seek(45);
  // Drive the engine directly so this also works while the page is hidden (rAF paused).
  for (let i = 0; i < 100 && engine.compositor.stats.layers < 5; i++) {
    engine.seek(45);
    engine.pump();
    await sleep(100);
  }
  const doc = editor.store.committed;
  const graph = buildFrameGraph(doc, doc.activeTimelineId, 45);
  // Wrap the engine's provider so every render re-uploads the decoded frames (as in playback).
  const engineProvider = (engine as unknown as { provider: TextureProvider }).provider;
  let bump = 0;
  const provider: TextureProvider = {
    media: (layer) => {
      const f = engineProvider.media(layer);
      if (!f || !f.source) return f;
      const copy: SourceFrame = { ...f, version: `${String(f.version)}#${bump}` };
      return copy;
    },
  };
  for (const quality of ["half", "full"] as const) {
    engine.setQuality(quality);
    const comp = engine.compositor;
    for (let i = 0; i < 10; i++) {
      bump += 1;
      comp.render(graph, provider);
      comp.readPixels(0, 0, 1, 1);
    }
    const n = 120;
    let submit = 0, synced = 0, syncedNoUpload = 0;
    for (let i = 0; i < n; i++) {
      bump += 1;
      const t0 = performance.now();
      comp.render(graph, provider);
      const t1 = performance.now();
      comp.readPixels(0, 0, 1, 1);
      const t2 = performance.now();
      submit += t1 - t0;
      synced += t2 - t0;
    }
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      comp.render(graph, engineProvider);
      comp.readPixels(0, 0, 1, 1);
      syncedNoUpload += performance.now() - t0;
    }
    out[quality] = {
      layers: comp.stats.layers, passes: comp.stats.passes,
      cpuSubmitMs: +(submit / n).toFixed(3), syncedFrameMs: +(synced / n).toFixed(3),
      syncedFrameNoUploadMs: +(syncedNoUpload / n).toFixed(3),
    };
  }
  engine.setQuality("half");

  // Steady playback: heap growth and frame pacing over 4 s.
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  engine.seek(0);
  await sleep(500);
  engine.play();
  await sleep(500);
  const heap0 = mem?.usedJSHeapSize ?? 0;
  const renders: number[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    await nextFrame();
    if (document.hidden || document.visibilityState !== "visible") engine.pump();
    renders.push(engine.lastRenderMs);
  }
  out["playbackDriver"] = document.visibilityState === "visible" ? "rAF" : "pump (page hidden)";
  out["playbackEndFrame"] = engine.frame();
  const heap1 = mem?.usedJSHeapSize ?? 0;
  engine.pause();
  const sorted = [...renders].sort((a, b) => a - b);
  out["playback"] = {
    rafCallbacks: renders.length,
    renderMsMedian: +(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(3),
    renderMsP95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(3),
    heapDeltaKB: mem ? Math.round((heap1 - heap0) / 1024) : "unavailable",
  };
  await sleep(300);
  const ticks0 = engine.ticks;
  await sleep(1000);
  out["idleTicksPerSecondPaused"] = engine.ticks - ticks0;
  return out;
}

export default function PreviewDevPage() {
  const params = new URLSearchParams(location.search);
  const testMode = params.get("test") === "1";
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const [status, setStatus] = createSignal("Building test media…");
  let resultsEl: HTMLPreElement | undefined;
  let engineRef: PlaybackEngine | null = null;
  let engineReady: (() => void) | null = null;
  const engineReadyPromise = new Promise<void>((r) => (engineReady = r));

  onMount(async () => {
    const summary: Record<string, unknown> = {};
    if (testMode) {
      setStatus("Running GPU self-test…");
      const results: SelfTestResult[] = runGpuSelfTest();
      summary["selfTest"] = {
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    }
    const e = await buildDemo();
    setEditor(e);
    setStatus("Ready");
    if (testMode) {
      await engineReadyPromise;
      setStatus("Measuring performance…");
      summary["performance"] = await measurePerformance(e, engineRef as PlaybackEngine);
      setStatus("Done");
      const text = JSON.stringify(summary, null, 1);
      if (resultsEl) resultsEl.textContent = text;
      console.log("PREVIEW_SELFTEST", text);
    }
  });

  return (
    <div style={{ display: "flex", height: "100%", gap: "var(--panel-gap)", padding: "var(--panel-gap)" }}>
      <div style={{ flex: "1", "min-width": "0" }}>
        <Show when={editor()} fallback={<div class="panel"><div class="panel-header">{status()}</div></div>}>
          {(ed) => (
            <PreviewView
              editor={ed()}
              onEngine={(en) => {
                engineRef = en;
                (window as unknown as { previewEngine?: PlaybackEngine }).previewEngine = en;
                engineReady?.();
              }}
              onCaptureFrame={(png) => console.log("captured frame", png.size, "bytes")}
            />
          )}
        </Show>
      </div>
      <Show when={testMode}>
        <div class="panel" style={{ width: "420px" }}>
          <div class="panel-header">{status()}</div>
          <pre id="results" ref={resultsEl} class="panel-body" style={{ margin: "0", "font-size": "var(--fs-xs)", "user-select": "text" }} />
        </div>
      </Show>
    </div>
  );
}
