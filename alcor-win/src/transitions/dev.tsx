import { For, Show, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { addAdjustmentLayer } from "../editor/mutations/adjustmentLayer";
import { addMask } from "../editor/mutations/masks";
import { addTransition, findTransition, updateTransition } from "../editor/mutations/transitions";
import { TransitionSection } from "../inspector/TransitionSection";
import { makeEffect, makeEffectParam } from "../model/effect";
import { makeEllipsePath } from "../model/mask";
import { makeMediaAsset } from "../model/mediaAsset";
import { makeClip, makeTimeline, makeTrack, makeTransform } from "../model/timeline";
import { transitionKindLabels, transitionKinds } from "../model/transition";
import { PreviewView } from "../preview/PreviewView";
import "../inspector/inspector.css";

const fps = 30;
const clipFrames = 90;

async function gradientPng(from: string, to: string, label: string): Promise<Blob> {
  const c = new OffscreenCanvas(1280, 720);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 1280, 720);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = "white";
  ctx.font = "bold 320px sans-serif";
  ctx.fillText(label, 470, 480);
  return c.convertToBlob({ type: "image/png" });
}

async function buildDemo(): Promise<Editor> {
  const assets = [];
  for (const [id, from, to, label] of [["a", "#1f4e79", "#59a14f", "A"], ["b", "#b4451f", "#e8c547", "B"]] as const) {
    const asset = makeMediaAsset({ id, url: URL.createObjectURL(await gradientPng(from, to, label)), type: "image", name: id, duration: 0 });
    asset.sourceWidth = 1280;
    asset.sourceHeight = 720;
    assets.push(asset);
  }
  const clip = (id: string, start: number) =>
    makeClip({ id, mediaRef: id, mediaType: "image", sourceClipType: "image", startFrame: start, durationFrames: clipFrames, transform: makeTransform() });
  const timeline = makeTimeline({
    name: "Transitions", fps, width: 1920, height: 1080,
    tracks: [makeTrack({ type: "video", clips: [clip("a", 0), clip("b", clipFrames)] })],
  });
  const doc = makeEditorDocument();
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  doc.mediaAssets = assets;
  const editor = new Editor(doc);
  addTransition(editor, "a", "b", { durationFrames: 30 });
  return editor;
}

export default function TransitionsDevPage() {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  onMount(async () => {
    const e = await buildDemo();
    e.ui.currentFrame = clipFrames;
    (window as unknown as { transitionEditor?: Editor }).transitionEditor = e;
    setEditor(e);
  });
  return (
    <div style={{ display: "flex", height: "100%", gap: "var(--panel-gap)", padding: "var(--panel-gap)" }}>
      <div style={{ flex: "1", "min-width": "0" }}>
        <Show when={editor()} fallback={<div class="panel"><div class="panel-header">Building test media…</div></div>}>
          {(ed) => <PreviewView editor={ed()} />}
        </Show>
      </div>
      <Show when={editor()}>{(ed) => <SidePanel editor={ed()} />}</Show>
    </div>
  );
}

function SidePanel(props: { editor: Editor }) {
  const e = props.editor;
  const id = (): string | undefined => e.timeline.tracks[0]?.transitions?.[0]?.id;
  const addAdjustment = (): void => {
    const clipId = addAdjustmentLayer(e, { startFrame: 0, durationFrames: clipFrames * 2 });
    if (!clipId) return;
    e.perform("Add Adjustment Effect", () => {
      const adj = e.timeline.tracks[0]?.clips.find((c) => c.id === clipId);
      if (adj) adj.effects = [makeEffect({ type: "color.saturation", params: { amount: makeEffectParam({ value: 0 }) } })];
    });
    addMask(e, clipId, "ellipse", { path: makeEllipsePath(0.5, 0.5, 0.25, 0.4), feather: 60 });
    e.ui.selectedTransitionId = null;
  };
  return (
    <div class="panel" style={{ width: "300px" }}>
      <div class="panel-header">Transitions dev</div>
      <div class="panel-body" style={{ display: "flex", "flex-direction": "column", gap: "var(--sp-sm)", padding: "var(--sp-md)", overflow: "auto" }}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--sp-xs)" }}>
          <button onClick={() => e.undo()} disabled={!e.store.canUndo}>Undo</button>
          <button onClick={() => e.redo()} disabled={!e.store.canRedo}>Redo</button>
          <button onClick={addAdjustment}>Add adjustment (desaturate, masked)</button>
        </div>
        <label>
          Playhead {e.ui.currentFrame}
          <input
            type="range" min="0" max={clipFrames * 2 - 1} value={e.ui.currentFrame} style={{ width: "100%" }}
            onInput={(ev) => (e.ui.currentFrame = Number(ev.currentTarget.value))}
          />
        </label>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--sp-xs)" }}>
          <For each={transitionKinds}>
            {(kind) => (
              <button
                classList={{ on: findTransition(e, id() ?? "")?.transition.kind === kind }}
                onClick={() => {
                  const t = id();
                  if (t) updateTransition(e, t, { kind });
                }}
              >
                {transitionKindLabels[kind]}
              </button>
            )}
          </For>
        </div>
        <button onClick={() => (e.ui.selectedTransitionId = id() ?? null)}>Select transition</button>
        <TransitionSection editor={e} fallback={<div>No transition selected</div>} />
      </div>
    </div>
  );
}
