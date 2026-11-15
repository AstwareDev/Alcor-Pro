import {
  makeClip, makeTextAnimation, makeTimeline, makeTrack, presetRenderMode, type Clip, type RGBA, type TextAnimationPreset, type TextStyle,
  type Transform,
} from "../model";
import { buildFrameGraph } from "../preview/frameGraph";
import { TextRenderer } from "../preview/textRenderer";

// Port of CaptionPreviewRender.swift. Swift rasterises with TextFrameRenderer + CoreImage; here the same frame-graph
// text layer goes through the compositor's TextRenderer (Canvas 2D) and is drawn with the entrance transform.
// Text effects (blur etc.) don't apply to caption previews, so they're skipped.

export const captionPreviewClipId = "caption-preview";

export function captionPreviewLoopFrames(preset: TextAnimationPreset): number {
  return presetRenderMode(preset) === "entrance" ? 28 : 54;
}

/** A synthetic text clip for preview rendering. */
export function captionPreviewClip(p: {
  content: string;
  style: TextStyle;
  transform: Transform;
  preset: TextAnimationPreset;
  highlight: RGBA | undefined;
}): Clip {
  return makeClip({
    id: captionPreviewClipId,
    mediaRef: "",
    mediaType: "text",
    sourceClipType: "text",
    startFrame: 0,
    durationFrames: captionPreviewLoopFrames(p.preset),
    transform: p.transform,
    textContent: p.content,
    textStyle: p.style,
    textAnimation: makeTextAnimation({ preset: p.preset, ...(p.highlight ? { highlight: p.highlight } : {}) }),
  });
}

/** Draws `clip` at `frame` into a canvas context of `width` x `height` render pixels (cleared first). */
export function drawCaptionPreviewFrame(
  renderer: TextRenderer,
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  frame: number,
  size: { width: number; height: number },
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  if (!(size.width >= 1 && size.height >= 1)) return;
  const timeline = makeTimeline({ fps: 30, width: size.width, height: size.height, tracks: [makeTrack({ type: "video", clips: [clip] })] });
  const graph = buildFrameGraph({ timelines: [timeline] }, timeline.id, frame);
  const layer = graph.layers[0];
  if (!layer || layer.kind !== "text") return;
  const raster = renderer.raster(layer, size);
  if (!raster) return;
  const entrance = layer.text.entrance;
  const cx = raster.box.x + raster.box.width / 2;
  const cy = raster.box.y + raster.box.height / 2;
  const s = entrance.scale;
  ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity * entrance.opacity));
  ctx.setTransform(s, 0, 0, s, cx - s * cx, cy - s * cy + entrance.dy * size.height);
  ctx.drawImage(raster.source as CanvasImageSource, raster.rect.x, raster.rect.y);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
