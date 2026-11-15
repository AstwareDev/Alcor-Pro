import { Show, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { addMask, setMaskKeyframe, updateMask } from "../editor/mutations/masks";
import { MasksSection } from "../inspector/MasksSection";
import { makeEllipsePath, makeRectanglePath } from "../model/mask";
import { makeMediaAsset } from "../model/mediaAsset";
import { makeRGBA, makeTextStyle } from "../model/textStyle";
import { makeClip, makeTimeline, makeTrack, makeTransform } from "../model/timeline";
import { PreviewOverlays } from "../preview/overlays/PreviewOverlays";
import { PreviewView } from "../preview/PreviewView";
import "../inspector/inspector.css";

const fps = 30;
const frames = fps * 4;

async function imagePng(): Promise<Blob> {
  const c = new OffscreenCanvas(1280, 720);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 1280, 720);
  g.addColorStop(0, "#1f4e79");
  g.addColorStop(1, "#59a14f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= 1280; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke(); }
  for (let y = 0; y <= 720; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke(); }
  ctx.fillStyle = "white";
  ctx.font = "bold 160px sans-serif";
  ctx.fillText("MASK", 380, 420);
  return c.convertToBlob({ type: "image/png" });
}

async function buildDemo(): Promise<Editor> {
  const png = await imagePng();
  const asset = makeMediaAsset({ id: "img", url: URL.createObjectURL(png), type: "image", name: "img", duration: 0 });
  asset.sourceWidth = 1280;
  asset.sourceHeight = 720;
  const image = makeClip({
    id: "image", mediaRef: "img", mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: frames,
    transform: makeTransform({ centerX: 0.5, centerY: 0.45, width: 0.7, height: 0.7 }),
  });
  const text = makeClip({
    id: "text", mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: frames,
    textContent: "Masked text",
    textStyle: makeTextStyle({ fontSize: 120, isBold: true, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }) }),
    transform: makeTransform({ centerY: 0.88, width: 0.5, height: 0.18 }),
  });
  const timeline = makeTimeline({
    name: "Masks", fps, width: 1920, height: 1080,
    tracks: [makeTrack({ type: "video", clips: [text] }), makeTrack({ type: "video", clips: [image] })],
  });
  const doc = makeEditorDocument();
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  doc.mediaAssets = [asset];
  const editor = new Editor(doc);
  // A feathered ellipse plus a rectangle that slides across the clip, and a half-width text mask.
  const ellipse = addMask(editor, "image", "ellipse", { path: makeEllipsePath(0.5, 0.5, 0.3, 0.38), name: "Vignette", feather: 40 });
  if (ellipse) updateMask(editor, "image", ellipse, { feather: 40 });
  const rect = addMask(editor, "image", "rectangle", { path: makeRectanglePath(0.05, 0.2, 0.35, 0.8), name: "Slider", mode: "subtract" });
  if (rect) {
    editor.ui.currentFrame = 0;
    setMaskKeyframe(editor, "image", rect, "path");
    editor.ui.currentFrame = frames - 1;
    setMaskKeyframe(editor, "image", rect, "path", { value: makeRectanglePath(0.6, 0.2, 0.95, 0.8) });
    editor.ui.currentFrame = 0;
  }
  addMask(editor, "text", "rectangle", { path: makeRectanglePath(0, 0, 0.5, 1) });
  editor.ui.selectedClipIds = new Set(["image"]);
  editor.ui.selectedMaskId = ellipse ?? null;
  return editor;
}

export default function MasksDevPage() {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  onMount(async () => {
    const e = await buildDemo();
    (window as unknown as { maskEditor?: Editor }).maskEditor = e;
    setEditor(e);
  });
  return (
    <div style={{ display: "flex", height: "100%", gap: "var(--panel-gap)", padding: "var(--panel-gap)" }}>
      <div style={{ flex: "1", "min-width": "0" }}>
        <Show when={editor()} fallback={<div class="panel"><div class="panel-header">Building test media…</div></div>}>
          {(ed) => <PreviewView editor={ed()} overlay={(canvas, size) => <PreviewOverlays editor={ed()} canvas={canvas} size={size} />} />}
        </Show>
      </div>
      <Show when={editor()}>{(ed) => <SidePanel editor={ed()} />}</Show>
    </div>
  );
}

function SidePanel(props: { editor: Editor }) {
  const e = props.editor;
  const select = (id: string): void => {
    e.ui.selectedClipIds = new Set([id]);
    e.ui.selectedMaskId = null;
    e.ui.maskTool = null;
  };
  return (
    <div class="panel" style={{ width: "300px" }}>
      <div class="panel-header">Masks dev</div>
      <div class="panel-body" style={{ display: "flex", "flex-direction": "column", gap: "var(--sp-sm)", padding: "var(--sp-md)", overflow: "auto" }}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--sp-xs)" }}>
          <button onClick={() => e.undo()} disabled={!e.store.canUndo}>Undo</button>
          <button onClick={() => e.redo()} disabled={!e.store.canRedo}>Redo</button>
          <button onClick={() => select("image")}>Select image</button>
          <button onClick={() => select("text")}>Select text</button>
          <button onClick={() => (e.ui.currentFrame = Math.min(frames - 1, e.ui.currentFrame + 15))}>Playhead +15</button>
          <button onClick={() => (e.ui.currentFrame = 0)}>Playhead 0</button>
        </div>
        <div>Playhead {e.ui.currentFrame}</div>
        <MasksSection editor={e} ids={() => [...e.ui.selectedClipIds]} />
      </div>
    </div>
  );
}
