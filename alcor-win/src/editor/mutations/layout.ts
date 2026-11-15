import { cropVisibleHeightFraction, cropVisibleWidthFraction, makeCrop, makeTransformFromTopLeft, type Clip, type Crop, type LayoutFit, type LayoutRect, type Transform } from "../../model";
import type { Editor } from "../editor";
import { cropFittingAspect, mediaCanvasAspectForClip } from "./core";

/** Port of EditorViewModel+Layout.swift: where `clip` lands (transform + crop) inside a layout slot. */
export function layoutPlacement(
  editor: Editor,
  clip: Clip,
  rect: LayoutRect,
  fit: LayoutFit,
  anchorX = 0.5,
  anchorY = 0.5,
): { transform: Transform; crop: Crop } {
  const timeline = editor.timeline;
  const canvasAspect = timeline.width / Math.max(1, timeline.height);
  const slotPixelAspect = rect.h > 0 ? (rect.w / rect.h) * canvasAspect : canvasAspect;

  if (fit === "fill") {
    const crop = cropFittingAspect(editor, clip, slotPixelAspect, anchorX, anchorY);
    const vw = cropVisibleWidthFraction(crop);
    const vh = cropVisibleHeightFraction(crop);
    if (!(vw > 0 && vh > 0)) return { transform: makeTransformFromTopLeft({ x: rect.x, y: rect.y }, rect.w, rect.h), crop };
    const w = rect.w / vw;
    const h = rect.h / vh;
    return { transform: makeTransformFromTopLeft({ x: rect.x - crop.left * w, y: rect.y - crop.top * h }, w, h), crop };
  }

  const rel = mediaCanvasAspectForClip(editor, clip);
  if (rel === undefined || !(rel > 0)) {
    return { transform: makeTransformFromTopLeft({ x: rect.x, y: rect.y }, rect.w, rect.h), crop: makeCrop() };
  }
  let drawW = rect.w;
  let drawH = rect.h;
  if (rel * rect.h <= rect.w) {
    drawH = rect.h;
    drawW = rel * rect.h;
  } else {
    drawW = rect.w;
    drawH = rect.w / rel;
  }
  const ax = Math.min(1, Math.max(0, anchorX));
  const ay = Math.min(1, Math.max(0, anchorY));
  return {
    transform: makeTransformFromTopLeft({ x: rect.x + (rect.w - drawW) * ax, y: rect.y + (rect.h - drawH) * ay }, drawW, drawH),
    crop: makeCrop(),
  };
}
