import type { Point, Size } from "../../model/geometry";
import type { Crop, Transform } from "../../model/timeline";
import { buildFrameGraph, type FrameLayer } from "../frameGraph";
import { textTiltCorners, textTiltCornersContains } from "../textTiltGeometry";
import { clipRectPx, rotateVector } from "./transformMath";
import type { Editor } from "../../editor/editor";

/** Layers at or below this opacity are not drawn visibly, so they cannot be picked (Swift: > 0.01). */
const minPickOpacity = 0.01;

function textHit(t: Transform, point: Point, size: Size): boolean {
  const rect = clipRectPx(t, size);
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const pivot = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  return textTiltCornersContains(textTiltCorners(rect, pivot, t, size), point);
}

function boxHit(t: Transform, crop: Crop, point: Point, size: Size): boolean {
  const rect = clipRectPx(t, size);
  if (!(rect.width > 0 && rect.height > 0)) return false;
  // Move the point into the clip's unrotated local space (origin at clip centre).
  const local = rotateVector({ x: point.x - (rect.x + rect.width / 2), y: point.y - (rect.y + rect.height / 2) }, -t.rotation);
  const halfW = rect.width / 2, halfH = rect.height / 2;
  return (
    local.x >= -halfW + crop.left * rect.width &&
    local.x <= halfW - crop.right * rect.width &&
    local.y >= -halfH + crop.top * rect.height &&
    local.y <= halfH - crop.bottom * rect.height
  );
}

/**
 * Topmost visible clip under `point` (overlay pixels, top-left origin). Layers come from the same frame graph the
 * compositor draws, so stacking, rotation, crop, fades and nesting match the picture. Nested clips resolve to their
 * carrier clip.
 */
export function hitTestLayers(layers: readonly FrameLayer[], point: Point, size: Size): string | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    let layer = layers[i] as FrameLayer;
    if (layer.kind === "adjustment") continue;
    if (layer.kind === "transition") {
      const side = layer.progress < 0.5 ? layer.from ?? layer.to : layer.to ?? layer.from;
      if (!side) continue;
      layer = side;
    }
    if (!(layer.opacity > minPickOpacity)) continue;
    const hit = layer.kind === "text" ? textHit(layer.transform, point, size) : boxHit(layer.transform, layer.crop, point, size);
    if (hit) return layer.clip.id;
  }
  return undefined;
}

/** `PreviewHitTester.clipID(at:viewSize:editor:)` at the playhead frame. */
export function previewClipIdAt(editor: Editor, point: Point, size: Size): string | undefined {
  if (!(size.width > 0 && size.height > 0)) return undefined;
  const doc = editor.store.committed;
  const graph = buildFrameGraph(doc, doc.activeTimelineId, editor.ui.currentFrame, { missingMediaRefs: editor.ui.missingMediaRefs });
  return hitTestLayers(graph.layers, point, size);
}
