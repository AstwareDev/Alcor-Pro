// Thumbnail rendering for the Library: looks run through the real WebGL compositor on a procedurally generated sample
// scene; text and titles go through the same text renderer the timeline uses.
import {
  makeClip, makeMediaAsset, makeTimeline, makeTrack, makeTransformFromTopLeft, textLayoutNaturalSize, type Effect, type TextMeasurer,
} from "../model";
import { buildFrameGraph } from "../preview/frameGraph";
import { Compositor, type TextureProvider } from "../preview/renderer";
import { canvasTextMeasurer, TextRenderer } from "../preview/textRenderer";
import type { CubeLUT } from "../preview/effects/lutLoader";
import { captionPreviewClip, drawCaptionPreviewFrame } from "../captions/captionPreviewRender";
import type { TitlePreset } from "./presetFormat";

export const thumbW = 192;
export const thumbH = 108;
const sampleW = 320;
const sampleH = 180;

let sample: HTMLCanvasElement | undefined;

/** A small landscape with sky, sun, water, a cabin, a face and colour/grey ramps: enough to judge a grade at a glance. */
export function sampleImage(): HTMLCanvasElement {
  if (sample) return sample;
  const c = document.createElement("canvas");
  c.width = sampleW;
  c.height = sampleH;
  const g = c.getContext("2d");
  if (!g) return c;
  const sky = g.createLinearGradient(0, 0, 0, 100);
  sky.addColorStop(0, "#3d6fb8");
  sky.addColorStop(0.55, "#e9a679");
  sky.addColorStop(1, "#f8dca4");
  g.fillStyle = sky;
  g.fillRect(0, 0, sampleW, 100);
  const sun = g.createRadialGradient(232, 88, 2, 232, 88, 46);
  sun.addColorStop(0, "rgba(255,248,214,1)");
  sun.addColorStop(0.25, "rgba(255,226,150,0.9)");
  sun.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = sun;
  g.fillRect(150, 30, 170, 100);
  const poly = (color: string, pts: number[][]): void => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
    for (const p of pts.slice(1)) g.lineTo(p[0] ?? 0, p[1] ?? 0);
    g.closePath();
    g.fill();
  };
  poly("#6a5f93", [[0, 100], [0, 70], [40, 52], [78, 78], [120, 48], [175, 84], [215, 62], [270, 90], [320, 66], [320, 100]]);
  poly("#3f7a4d", [[0, 108], [0, 88], [60, 80], [130, 92], [210, 82], [320, 94], [320, 108]]);
  const water = g.createLinearGradient(0, 100, 0, 150);
  water.addColorStop(0, "#2f8fa8");
  water.addColorStop(1, "#16465f");
  g.fillStyle = water;
  g.fillRect(0, 100, sampleW, 52);
  g.fillStyle = "rgba(255,226,150,0.55)";
  for (let i = 0; i < 7; i++) g.fillRect(232 - 22 + i * 3, 104 + i * 6, 44 - i * 6, 2);
  poly("#1f3a24", [[0, 152], [0, 112], [22, 126], [40, 110], [62, 136], [80, 152]]);
  g.fillStyle = "#b8412f";
  g.fillRect(118, 108, 34, 22);
  poly("#5b2a1e", [[114, 108], [135, 92], [156, 108]]);
  g.fillStyle = "#ffd36b";
  g.fillRect(128, 114, 8, 8);
  g.fillStyle = "#2c2f36";
  g.fillRect(0, 152, sampleW, 28);
  g.fillStyle = "#1b1d22";
  g.beginPath();
  g.ellipse(268, 168, 34, 22, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = "#d8a07e";
  g.beginPath();
  g.arc(268, 150, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#3a2a22";
  g.beginPath();
  g.arc(268, 144, 15.5, Math.PI, Math.PI * 2);
  g.fill();
  const ramp = ["#000000", "#333333", "#666666", "#999999", "#cccccc", "#ffffff", "#e53935", "#fdd835", "#43a047", "#00acc1", "#1e63e9", "#d81b8f"];
  ramp.forEach((color, i) => {
    g.fillStyle = color;
    g.fillRect(8 + i * 18, 160, 18, 12);
  });
  sample = c;
  return c;
}

const sampleAsset = (() => {
  const a = makeMediaAsset({ id: "library-sample", url: "sample", type: "image", name: "sample" });
  a.sourceWidth = sampleW;
  a.sourceHeight = sampleH;
  return a;
})();

/** Renders effect stacks over the sample scene with the production compositor. One shared GL context. */
export class LookPreviewRenderer {
  private readonly canvas = document.createElement("canvas");
  private readonly compositor: Compositor;
  private readonly provider: TextureProvider = {
    media: () => ({ source: sampleImage(), width: sampleW, height: sampleH, version: "sample", premultiplied: false }),
  };

  private loadLut: (path: string) => CubeLUT | undefined = () => undefined;

  constructor() {
    this.canvas.width = thumbW;
    this.canvas.height = thumbH;
    this.compositor = new Compositor(this.canvas, { loadLut: (path) => this.loadLut(path) });
  }

  /** Draws the stack into `target` (any size); returns false if the GL context is unavailable. */
  render(effects: readonly Effect[], target: HTMLCanvasElement, loadLut: (path: string) => CubeLUT | undefined): boolean {
    this.loadLut = loadLut;
    const clip = makeClip({
      mediaRef: sampleAsset.id, mediaType: "image", sourceClipType: "image", startFrame: 0, durationFrames: 30,
      ...(effects.length > 0 ? { effects: structuredClone([...effects]) } : {}),
    });
    const timeline = makeTimeline({ fps: 30, width: thumbW, height: thumbH, tracks: [makeTrack({ type: "video", clips: [clip] })] });
    const graph = buildFrameGraph({ timelines: [timeline], mediaAssets: [sampleAsset] }, timeline.id, 0);
    if (!this.compositor.render(graph, this.provider)) return false;
    const ctx = target.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(this.canvas, 0, 0, target.width, target.height);
    return true;
  }

  dispose(): void {
    this.compositor.dispose();
  }
}

let shared: LookPreviewRenderer | null | undefined;

/** Shared renderer, or null when WebGL2 is unavailable. */
export function lookRenderer(): LookPreviewRenderer | null {
  if (shared === undefined) {
    try {
      shared = new LookPreviewRenderer();
    } catch {
      shared = null;
    }
  }
  return shared;
}

// --- titles ---------------------------------------------------------------------------------------------------

const referenceCanvas = { width: 1920, height: 1080 };
let textRenderer: TextRenderer | undefined;

/** Draws a settled frame of every title item into `target`, over whatever is already there. */
export function drawTitlePreview(preset: TitlePreset, target: HTMLCanvasElement, measure: TextMeasurer = canvasTextMeasurer): void {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  textRenderer ??= new TextRenderer();
  const layer = document.createElement("canvas");
  layer.width = target.width;
  layer.height = target.height;
  const layerCtx = layer.getContext("2d");
  if (!layerCtx) return;
  for (const item of [...preset.items].sort((a, b) => b.layer - a.layer)) {
    const natural = textLayoutNaturalSize(item.text, item.style, referenceCanvas.width * 0.9, referenceCanvas.height, measure);
    const w = natural.width / referenceCanvas.width;
    const h = natural.height / referenceCanvas.height;
    const cx = item.box?.centerX ?? 0.5;
    const cy = item.box?.centerY ?? 0.5;
    const clip = captionPreviewClip({
      content: item.text,
      style: item.style,
      transform: makeTransformFromTopLeft({ x: cx - w / 2, y: cy - h / 2 }, w, h),
      preset: "none",
      highlight: undefined,
    });
    drawCaptionPreviewFrame(textRenderer, layerCtx, clip, 0, { width: layer.width, height: layer.height });
    ctx.drawImage(layer, 0, 0);
  }
}
