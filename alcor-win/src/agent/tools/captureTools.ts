import type { Editor } from "../../editor/editor";
import { generationHooks } from "../../generation/generationState";
import { mediaIo } from "../../media/io";
import { manifestEntryFor, projectPackageCoordinator } from "../../media/libraryCore";
import { mediaHooks } from "../../media/mediaHooks";
import { commitStagedProjectMedia, prepareMediaVisuals } from "../../media/mediaLibrary";
import { Defaults, joinPath, makeMediaAsset, mediaAssetIsGenerating, timelineTotalFrames, type MediaAsset } from "../../model";
import { newId } from "../../util/id";
import { jsonString, roundJSONFloatingPointNumbers } from "./jsonFormat";
import { renderSourceFramePng, renderTimelineFramePng, type RenderedPng } from "./renderTimelineFrame";
import { ToolError, decodeToolArgs } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+CaptureFrame.swift and the agent-facing part of EditorViewModel+FrameCapture.swift.

const captureFrameNameLimit = 200;

/** Renderers behind capture_frame; tests substitute them (no WebCodecs / WebGL outside the app). */
export const frameRenderers: {
  timeline: (editor: Editor, frame: number) => Promise<RenderedPng>;
  source: (asset: MediaAsset, sourceSeconds: number) => Promise<RenderedPng>;
} = { timeline: renderTimelineFramePng, source: renderSourceFramePng };

export type FrameCaptureSource =
  | { kind: "timeline"; frame: number }
  | { kind: "media"; mediaRef: string; sourceSeconds: number };

export interface FrameCaptureReceipt {
  asset: MediaAsset;
  width: number;
  height: number;
  timelineId: string | undefined;
  actualSourceSeconds: number | undefined;
}

/** `EditorViewModel.captureFrameToMedia`: renders the frame, stores it in the project and registers one undo step. */
export async function captureFrameToMedia(editor: Editor, source: FrameCaptureSource, requestedName?: string): Promise<FrameCaptureReceipt> {
  if (editor.projectPath === null) throw new ToolError("No project is open.");

  let defaultName: string;
  let capturedTimelineId: string | undefined;
  let rendered: RenderedPng;
  if (source.kind === "timeline") {
    const timeline = editor.timeline;
    const totalFrames = timelineTotalFrames(timeline);
    if (!(totalFrames > 0)) throw new ToolError("The timeline is empty.");
    if (!(source.frame >= 0 && source.frame < totalFrames)) {
      throw new ToolError(`Timeline frame ${source.frame} is outside 0..<${totalFrames}.`);
    }
    defaultName = `Frame ${source.frame}`;
    capturedTimelineId = timeline.id;
    rendered = await frameRenderers.timeline(editor, source.frame);
  } else {
    const media = editor.mediaAsset(source.mediaRef);
    if (!media) throw new ToolError(`Media asset not found: ${source.mediaRef}`);
    if (media.type !== "video") throw new ToolError(`Media asset ${source.mediaRef} is not a video.`);
    if (mediaAssetIsGenerating(media)) throw new ToolError(`Media asset ${source.mediaRef} is still preparing.`);
    if (media.generationStatus.kind === "failed") {
      throw new ToolError(`Media asset ${source.mediaRef} failed: ${media.generationStatus.message}`);
    }
    defaultName = `${media.name} frame`;
    rendered = await frameRenderers.source(media, source.sourceSeconds);
  }

  if (editor.projectPath === null) throw new ToolError("No project is open.");
  const io = await mediaIo();
  const stagedPath = joinPath(await io.tempDir(), `palmier-stage-${newId()}.png`);
  await io.mkdir(await io.tempDir());
  await io.writeBytes(stagedPath, rendered.bytes);

  const coordinator = projectPackageCoordinator(editor);
  try {
    coordinator.beginMutation();
  } catch (e) {
    await io.remove(stagedPath).catch(() => undefined);
    throw e;
  }
  let asset: MediaAsset;
  try {
    const filename = `frame-${newId().slice(0, 8).toLowerCase()}.png`;
    const committed = await commitStagedProjectMedia(editor, stagedPath, filename, { workAlreadyAdmitted: true });
    const draft = makeMediaAsset({ url: committed, type: "image", name: requestedName ?? defaultName, duration: Defaults.imageDurationSeconds });
    draft.sourceWidth = rendered.width;
    draft.sourceHeight = rendered.height;
    editor.perform("Capture Frame", () => {
      editor.doc.mediaAssets.push(draft);
      editor.doc.mediaManifest.entries.push(manifestEntryFor(editor, draft));
    });
    asset = editor.mediaAsset(draft.id) ?? draft;
  } finally {
    coordinator.endMutation();
  }
  mediaHooks.scheduleSearchIndex?.(asset);
  prepareMediaVisuals(asset);
  generationHooks.checkpointRequired?.(editor);

  return {
    asset,
    width: rendered.width,
    height: rendered.height,
    timelineId: capturedTimelineId,
    actualSourceSeconds: rendered.actualSourceSeconds,
  };
}

interface CaptureFrameInput {
  timelineFrame?: number;
  mediaRef?: string;
  sourceSeconds?: number;
  name?: string;
}

export async function captureFrame({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const input = decodeToolArgs<CaptureFrameInput>(args, "capture_frame", {
    timelineFrame: { spec: "int" },
    mediaRef: { spec: "string" },
    sourceSeconds: { spec: "double" },
    name: { spec: "string" },
  });

  const usesTimeline = input.timelineFrame !== undefined;
  const usesMedia = input.mediaRef !== undefined || input.sourceSeconds !== undefined;
  if (usesTimeline === usesMedia) {
    throw new ToolError("Provide exactly one capture mode: timelineFrame, or mediaRef with sourceSeconds.");
  }

  const name = input.name?.trim();
  if (name !== undefined) {
    if (name === "") throw new ToolError("name must not be empty.");
    if (Array.from(name).length > captureFrameNameLimit) throw new ToolError(`name must be ${captureFrameNameLimit} characters or fewer.`);
  }

  let source: FrameCaptureSource;
  if (input.timelineFrame !== undefined) {
    source = { kind: "timeline", frame: input.timelineFrame };
  } else {
    if (input.mediaRef === undefined || input.sourceSeconds === undefined) {
      throw new ToolError("mediaRef and sourceSeconds are both required for a source-video capture.");
    }
    source = { kind: "media", mediaRef: input.mediaRef, sourceSeconds: input.sourceSeconds };
  }

  const receipt = await captureFrameToMedia(editor, source, name);
  const payload: Record<string, unknown> = {
    status: "ready",
    mediaRef: receipt.asset.id,
    name: receipt.asset.name,
    type: receipt.asset.type,
    mimeType: "image/png",
    width: receipt.width,
    height: receipt.height,
  };
  if (source.kind === "timeline") {
    const capturedFrom: Record<string, unknown> = { timelineFrame: source.frame };
    if (receipt.timelineId !== undefined) capturedFrom.timelineId = receipt.timelineId;
    payload.capturedFrom = capturedFrom;
  } else {
    const capturedFrom: Record<string, unknown> = { mediaRef: source.mediaRef, sourceSeconds: source.sourceSeconds };
    if (receipt.actualSourceSeconds !== undefined) capturedFrom.actualSourceSeconds = receipt.actualSourceSeconds;
    payload.capturedFrom = capturedFrom;
  }
  return ok(jsonString(roundJSONFloatingPointNumbers(payload, 3)));
}
