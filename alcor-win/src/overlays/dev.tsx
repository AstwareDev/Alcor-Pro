import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } from "mediabunny";
import { Show, createMemo, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { toggleChromaKeySampling } from "../editor/mutations/chromaKey";
import { stampKeyframe } from "../editor/mutations/keyframes";
import { makeMediaAsset, type MediaAsset } from "../model/mediaAsset";
import { makeRGBA, makeTextStyle } from "../model/textStyle";
import { clipTransformAt, makeClip, makeTimeline, makeTrack, makeTransform } from "../model/timeline";
import type { PlaybackEngine } from "../preview/playback";
import { PreviewOverlays } from "../preview/overlays/PreviewOverlays";
import { PreviewView } from "../preview/PreviewView";

const fps = 30;
const seconds = 4;

async function encodeTestVideo(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const make = async (codec: "avc" | "vp9"): Promise<Blob> => {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 0.5 });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let i = 0; i < fps * seconds; i++) {
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, "#1f4e79");
      g.addColorStop(1, "#59a14f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, width - 4, height - 4);
      ctx.fillStyle = "white";
      ctx.font = `bold ${Math.round(height / 6)}px sans-serif`;
      ctx.fillText("VIDEO", width * 0.08, height * 0.25);
      await source.add(i / fps, 1 / fps);
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

async function imagePng(): Promise<Blob> {
  const c = new OffscreenCanvas(800, 800);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#f2c94c";
  ctx.beginPath();
  ctx.arc(400, 400, 380, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.font = "bold 160px sans-serif";
  ctx.fillText("IMAGE", 160, 440);
  return c.convertToBlob({ type: "image/png" });
}

async function buildDemo(): Promise<Editor> {
  const [video, png] = await Promise.all([encodeTestVideo(640, 360), imagePng()]);
  const asset = (id: string, blob: Blob, type: MediaAsset["type"], w: number, h: number): MediaAsset => {
    const a = makeMediaAsset({ id, url: URL.createObjectURL(blob), type, name: id, duration: type === "image" ? 0 : seconds });
    a.sourceWidth = w;
    a.sourceHeight = h;
    return a;
  };
  const dur = fps * seconds;
  const text = makeClip({
    id: "text", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: dur,
    textContent: "Drag me",
    textStyle: makeTextStyle({ fontSize: 110, isBold: true, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }) }),
    transform: makeTransform({ centerY: 0.85, width: 0.5, height: 0.18 }),
  });
  const image = makeClip({
    id: "image", mediaRef: "image", mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: dur,
    transform: makeTransform({ centerX: 0.78, centerY: 0.3, width: 0.2, height: 0.2 * (1920 / 1080) }),
  });
  const clip = makeClip({
    id: "video", mediaRef: "video", mediaType: "video", sourceClipType: "video", startFrame: 0, durationFrames: dur,
    transform: makeTransform({ centerX: 0.3, centerY: 0.4, width: 0.45, height: 0.45 }),
  });
  const timeline = makeTimeline({
    name: "Overlays", fps, width: 1920, height: 1080,
    tracks: [makeTrack({ type: "video", clips: [text] }), makeTrack({ type: "video", clips: [image] }), makeTrack({ type: "video", clips: [clip] })],
  });
  const doc = makeEditorDocument();
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  doc.mediaAssets = [asset("video", video, "video", 640, 360), asset("image", png, "image", 800, 800)];
  return new Editor(doc);
}

export default function OverlaysDevPage() {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  let engine: PlaybackEngine | null = null;
  onMount(async () => {
    const e = await buildDemo();
    (window as unknown as { overlayEditor?: Editor }).overlayEditor = e;
    setEditor(e);
  });

  return (
    <div style={{ display: "flex", height: "100%", gap: "var(--panel-gap)", padding: "var(--panel-gap)" }}>
      <div style={{ flex: "1", "min-width": "0" }}>
        <Show when={editor()} fallback={<div class="panel"><div class="panel-header">Building test media…</div></div>}>
          {(ed) => (
            <PreviewView
              editor={ed()}
              onEngine={(en) => {
                engine = en;
                (window as unknown as { overlayEngine?: PlaybackEngine }).overlayEngine = en;
              }}
              overlay={(canvas, size) => <PreviewOverlays editor={ed()} canvas={canvas} size={size} engine={() => engine} />}
            />
          )}
        </Show>
      </div>
      <Show when={editor()}>{(ed) => <SidePanel editor={ed()} />}</Show>
    </div>
  );
}

function SidePanel(props: { editor: Editor }) {
  const e = props.editor;
  const selected = createMemo(() => {
    const id = [...e.ui.selectedClipIds][0];
    return id === undefined ? undefined : e.clipFor(id) ?? undefined;
  });
  const info = () => {
    const c = selected();
    if (!c) return "No selection. Click a clip in the preview.";
    const t = clipTransformAt(c, e.ui.currentFrame);
    return JSON.stringify(
      { id: c.id, centerX: +t.centerX.toFixed(4), centerY: +t.centerY.toFixed(4), width: +t.width.toFixed(4), height: +t.height.toFixed(4), rotation: +t.rotation.toFixed(2), crop: c.crop, positionKeyframes: c.positionTrack?.keyframes.map((k) => k.frame) ?? [], fontScale: c.textStyle?.fontScale },
      null,
      1,
    );
  };
  const id = () => selected()?.id;
  return (
    <div class="panel" style={{ width: "300px" }}>
      <div class="panel-header">Overlay dev</div>
      <div class="panel-body" style={{ display: "flex", "flex-direction": "column", gap: "var(--sp-sm)", padding: "var(--sp-md)" }}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--sp-xs)" }}>
          <button onClick={() => e.undo()} disabled={!e.store.canUndo}>Undo</button>
          <button onClick={() => e.redo()} disabled={!e.store.canRedo}>Redo</button>
          <button onClick={() => (e.ui.cropEditingActive = !e.ui.cropEditingActive)}>{e.ui.cropEditingActive ? "Exit crop" : "Crop"}</button>
          <button onClick={() => { const i = id(); if (i) stampKeyframe(e, i, "position"); }}>Keyframe position</button>
          <button onClick={() => { const i = id(); if (i) toggleChromaKeySampling(e, i); }}>Eyedropper</button>
          <button onClick={() => (e.ui.currentFrame = e.ui.currentFrame + 15)}>Playhead +15</button>
        </div>
        <div>Playhead {e.ui.currentFrame} / undo: {e.store.canUndo ? "yes" : "no"}</div>
        <pre style={{ margin: "0", "font-size": "var(--fs-xs)", "user-select": "text" }}>{info()}</pre>
      </div>
    </div>
  );
}
