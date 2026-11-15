import type { Editor } from "../../editor/editor";
import { mediaUrl } from "../../media/mediaUrl";
import { makeMediaAsset, type MediaAsset } from "../../model/mediaAsset";
import {
  decodeSourceFrame, renderTimelineFrameCanvas, type DecodedSourceFrame, type OfflineFrame, type OfflineRenderSpec,
} from "../../preview/offlineRender";
import { applyInspectOverlay, bytesToBase64, encodeJPEG, encodePNG } from "./inspectFrameOverlay";

// Host side of inspect_timeline / capture_frame: offscreen Compositor render of the active timeline.

const inspectTimelineJPEGQuality = 0.7;

/** Plain-data snapshot of `editor`'s active timeline for the offline renderer (asset urls made fetchable). */
export function timelineRenderSpec(editor: Editor): OfflineRenderSpec {
  return {
    timelines: editor.timelines,
    mediaAssets: editor.mediaAssets.map((a) => slimAsset(a)),
    timelineId: editor.timeline.id,
    missingMediaRefs: [...editor.ui.missingMediaRefs],
  };
}

function slimAsset(a: MediaAsset): MediaAsset {
  const slim = makeMediaAsset({ id: a.id, url: mediaUrl(a.url), type: a.type, name: a.name, duration: a.duration });
  slim.hasAudio = a.hasAudio;
  if (a.sourceWidth !== undefined) slim.sourceWidth = a.sourceWidth;
  if (a.sourceHeight !== undefined) slim.sourceHeight = a.sourceHeight;
  if (a.sourceFPS !== undefined) slim.sourceFPS = a.sourceFPS;
  return slim;
}

/**
 * Raw composited frame of the active timeline (no overlay), canvas fitted to `longestEdge` (full size when
 * undefined). Throws when the frame can't be drawn. Use this for pixel analysis (inspect_color).
 */
export function renderTimelineFrameRaw(editor: Editor, frame: number, longestEdge?: number): Promise<OfflineFrame> {
  return renderTimelineFrameCanvas(timelineRenderSpec(editor), frame, longestEdge);
}

/**
 * `AgentHost.renderTimelineFrame`: the composited frame with the 0-1 grid and an `f<frame>` caption as base64 JPEG
 * (no `data:` prefix); null when it can't be rendered.
 */
export async function renderTimelineFrame(editor: Editor, frame: number, longestEdge: number): Promise<string | null> {
  try {
    const rendered = await renderTimelineFrameRaw(editor, frame, longestEdge);
    const labeled = applyInspectOverlay(rendered.canvas, `f${frame}`);
    return bytesToBase64(await encodeJPEG(labeled, inspectTimelineJPEGQuality));
  } catch {
    return null;
  }
}

export interface RenderedPng {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Source-relative seconds actually decoded (media captures only). */
  actualSourceSeconds?: number;
}

/** `FrameCaptureRenderer.timeline`: full-resolution PNG of one timeline frame. Throws with a user-facing message. */
export async function renderTimelineFramePng(editor: Editor, frame: number): Promise<RenderedPng> {
  const rendered = await renderTimelineFrameRaw(editor, frame).catch((e: unknown) => {
    throw new Error(`Could not render the frame: ${e instanceof Error ? e.message : String(e)}`);
  });
  return { bytes: await encodePNG(rendered.canvas), width: rendered.width, height: rendered.height };
}

/** `FrameCaptureRenderer.media`: PNG of the video's frame at `sourceSeconds`. Throws with a user-facing message. */
export async function renderSourceFramePng(asset: MediaAsset, sourceSeconds: number): Promise<RenderedPng> {
  const decoded: DecodedSourceFrame = await decodeSourceFrame(mediaUrl(asset.url), sourceSeconds);
  return {
    bytes: await encodePNG(decoded.canvas),
    width: decoded.width,
    height: decoded.height,
    actualSourceSeconds: decoded.actualSourceSeconds,
  };
}
