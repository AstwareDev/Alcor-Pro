import { mediaIo } from "../../media/io";
import {
  commitStagedProjectMedia, finalizeImportedAsset, importMediaAsset, isClipMediaGenerating, isClipMediaOffline, isMediaOffline,
  projectPackageCoordinator, updateManifestMetadata,
} from "../../media/library";
import {
  joinPath, makeClip, mediaAssetIsGenerating, makeMediaAsset, makeTimeline, makeTrack, matteEven,
  type Clip, type ClipType, type MediaAsset, type Timeline,
} from "../../model";
import { newId } from "../../util/id";
import type { VideoExportOptions } from "../../export/exportOptions";
import type { Editor } from "../editor";
import { linkedPartnerIds } from "./linking";
import { validSelectedTimelineRange } from "./timelineRange";

// Port of Editor/ViewModel/EditorViewModel+SaveAsMedia.swift. AVAssetExportSession is replaced by the export
// pipeline (WebCodecs): a one-clip scratch timeline renders to a staged file that is committed into
// `<project>/media` and imported as an asset, with a generating/rendering placeholder while it runs.

/** One render request: the timelines the export worker needs plus the options. */
export interface RenderJob {
  timelines: readonly Timeline[];
  timelineId: string;
  assets: readonly MediaAsset[];
  missingMediaRefs: readonly string[];
  options: VideoExportOptions;
}

export interface SaveAsMediaServices {
  render(job: RenderJob, destinationPath: string): Promise<void>;
}

export const saveAsMediaServices: SaveAsMediaServices = {
  async render(job, destinationPath) {
    const [{ exportVideoToFile }, { mediaUrl }] = await Promise.all([import("../../export/exportEngine"), import("../../media/mediaUrl")]);
    const assets = job.assets.map((a) => {
      const slim = makeMediaAsset({ id: a.id, url: mediaUrl(a.url), type: a.type, name: a.name, duration: a.duration });
      slim.hasAudio = a.hasAudio;
      if (a.sourceWidth !== undefined) slim.sourceWidth = a.sourceWidth;
      if (a.sourceHeight !== undefined) slim.sourceHeight = a.sourceHeight;
      if (a.sourceFPS !== undefined) slim.sourceFPS = a.sourceFPS;
      return slim;
    });
    await exportVideoToFile(
      {
        timelines: [...job.timelines], mediaAssets: assets, timelineId: job.timelineId,
        missingMediaRefs: [...job.missingMediaRefs], options: job.options,
      },
      destinationPath,
    );
  },
};

// MARK: - Extract audio eligibility

/** `canExtractAudio(from:)`. */
export function canExtractAudio(editor: Editor, asset: MediaAsset): boolean {
  return asset.type === "video" && asset.hasAudio && !mediaAssetIsGenerating(asset) && !isMediaOffline(editor, asset.id);
}

function isExtractableClip(editor: Editor, clip: Clip): boolean {
  return !isClipMediaOffline(editor, clip) && !isClipMediaGenerating(editor, clip);
}

/** The audio clip whose range "Save as Audio" would extract, or undefined when the clip has none. */
export function audioClipForExtraction(editor: Editor, clipId: string): Clip | undefined {
  const clip = editor.clipFor(clipId);
  if (!clip || clip.sourceClipType === "sequence" || clip.multicamGroupId !== undefined) return undefined;
  const partners = linkedPartnerIds(editor, clip.id).flatMap((id) => editor.clipFor(id) ?? []);
  if (clip.mediaType === "video") {
    const audio = partners.find((p) => p.mediaType === "audio");
    if (audio) return isExtractableClip(editor, audio) ? audio : undefined;
    const asset = editor.mediaAsset(clip.mediaRef);
    if (!asset || !canExtractAudio(editor, asset)) return undefined;
    return isExtractableClip(editor, clip) ? clip : undefined;
  }
  if (clip.mediaType === "audio" && partners.some((p) => p.mediaType === "video")) {
    return isExtractableClip(editor, clip) ? clip : undefined;
  }
  return undefined;
}

export function canExtractAudioFromClip(editor: Editor, clipId: string): boolean {
  return audioClipForExtraction(editor, clipId) !== undefined;
}

// MARK: - Scratch timelines

export interface ClipRange {
  mediaRef: string;
  mediaType: "video" | "audio";
  trimStartFrame: number;
  durationFrames: number;
  speed: number;
}

/**
 * A timeline holding only the clip's visible source range (trim and speed baked in; no effects, fades or volume),
 * at the project frame rate. Video keeps the source resolution and carries the source's audio.
 */
export function clipRangeTimeline(editor: Editor, range: ClipRange): Timeline {
  const asset = editor.mediaAsset(range.mediaRef);
  const fps = editor.timeline.fps;
  const clip = (mediaType: "video" | "audio"): Clip =>
    makeClip({
      mediaRef: range.mediaRef,
      mediaType,
      sourceClipType: asset?.type ?? mediaType,
      startFrame: 0,
      durationFrames: Math.max(1, range.durationFrames),
      trimStartFrame: range.trimStartFrame,
      speed: range.speed,
    });
  const tracks = [];
  let size = { width: editor.timeline.width, height: editor.timeline.height };
  if (range.mediaType === "video") {
    tracks.push(makeTrack({ type: "video", clips: [clip("video")] }));
    if (asset?.hasAudio) tracks.push(makeTrack({ type: "audio", clips: [clip("audio")] }));
    if (asset?.sourceWidth !== undefined && asset.sourceHeight !== undefined) size = matteEven(asset.sourceWidth, asset.sourceHeight);
  } else {
    tracks.push(makeTrack({ type: "audio", clips: [clip("audio")] }));
  }
  return makeTimeline({ name: "Scratch", fps, width: size.width, height: size.height, settingsConfigured: true, tracks });
}

function clipRangeOf(clip: Clip, mediaType: "video" | "audio"): ClipRange {
  return {
    mediaRef: clip.mediaRef, mediaType, trimStartFrame: clip.trimStartFrame, durationFrames: clip.durationFrames, speed: clip.speed,
  };
}

function renderOfScratch(editor: Editor, timeline: Timeline, audioOnly: boolean): RenderJob {
  return {
    timelines: [timeline],
    timelineId: timeline.id,
    assets: editor.mediaAssets,
    missingMediaRefs: [...editor.ui.missingMediaRefs],
    options: { codec: "H.264", resolution: "Match Timeline", includeAudio: true, ...(audioOnly ? { audioOnly: true } : {}) },
  };
}

// MARK: - Install

interface InstallRequest {
  name: string;
  type: "video" | "audio";
  folderId?: string;
  status: "generating" | "rendering";
  /** Renders into the staged file. */
  produce: (stagedPath: string) => Promise<void>;
}

const uniqueClipFilename = (type: ClipType): string => `clip-${newId().slice(0, 8)}.${type === "video" ? "mp4" : "m4a"}`;

/** Adds a placeholder asset, renders, commits the file into the project media folder and finalizes the asset. */
async function installRenderedMedia(editor: Editor, request: InstallRequest): Promise<MediaAsset | undefined> {
  const coordinator = projectPackageCoordinator(editor);
  try {
    coordinator.beginMutation();
  } catch {
    return undefined;
  }
  const io = await mediaIo();
  const filename = uniqueClipFilename(request.type);
  const mediaDir = editor.projectPath !== null ? joinPath(editor.projectPath, "media") : await io.tempDir();
  const placeholder = makeMediaAsset({ url: joinPath(mediaDir, filename), type: request.type, name: request.name });
  if (request.folderId !== undefined) placeholder.folderId = request.folderId;
  placeholder.generationStatus = { kind: request.status };
  importMediaAsset(editor, placeholder);
  let staged: string | undefined;
  try {
    const tempDir = await io.tempDir();
    await io.mkdir(tempDir);
    staged = joinPath(tempDir, `palmier-stage-${newId()}.${request.type === "video" ? "mp4" : "m4a"}`);
    await request.produce(staged);
    if (!editor.mediaAsset(placeholder.id)) return undefined;
    const destination = await commitStagedProjectMedia(editor, staged, filename, { workAlreadyAdmitted: true });
    editor.withoutRegistration(() => {
      const draft = editor.doc.mediaAssets.find((a) => a.id === placeholder.id);
      if (!draft) return;
      draft.url = destination;
      draft.generationStatus = { kind: "none" };
    });
    const committed = editor.mediaAsset(placeholder.id);
    if (committed) updateManifestMetadata(editor, [committed]);
    await finalizeImportedAsset(editor, placeholder.id);
    return editor.mediaAsset(placeholder.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    editor.withoutRegistration(() => {
      const draft = editor.doc.mediaAssets.find((a) => a.id === placeholder.id);
      if (draft) draft.generationStatus = { kind: "failed", message };
    });
    const failed = editor.mediaAsset(placeholder.id);
    if (failed) updateManifestMetadata(editor, [failed]);
    return undefined;
  } finally {
    if (staged !== undefined) await io.remove(staged).catch(() => undefined);
    coordinator.endMutation();
  }
}

function displayName(editor: Editor, mediaRef: string): string {
  return editor.mediaAsset(mediaRef)?.name ?? "Media";
}

// MARK: - Public actions

/** Library "Extract Audio": one `<name> (audio)` asset per eligible video asset, in the source's folder. */
export async function extractAudioFromAssets(
  editor: Editor,
  assetIds: readonly string[],
  services: SaveAsMediaServices = saveAsMediaServices,
): Promise<void> {
  for (const id of assetIds) {
    const asset = editor.mediaAsset(id);
    if (!asset || !canExtractAudio(editor, asset)) continue;
    const fps = editor.timeline.fps;
    const range: ClipRange = {
      mediaRef: id, mediaType: "audio", trimStartFrame: 0, durationFrames: Math.max(1, Math.ceil(asset.duration * fps)), speed: 1,
    };
    await installRenderedMedia(editor, {
      name: `${asset.name} (audio)`,
      type: "audio",
      ...(asset.folderId !== undefined ? { folderId: asset.folderId } : {}),
      status: "generating",
      produce: (staged) => services.render(renderOfScratch(editor, clipRangeTimeline(editor, range), true), staged),
    });
  }
}

/** Clip menu "Save as Audio". */
export async function extractAudioFromClip(
  editor: Editor,
  clipId: string,
  services: SaveAsMediaServices = saveAsMediaServices,
): Promise<void> {
  const clip = audioClipForExtraction(editor, clipId);
  if (!clip) return;
  const range = clipRangeOf(clip, "audio");
  const folderId = editor.mediaAsset(clip.mediaRef)?.folderId;
  await installRenderedMedia(editor, {
    name: `${displayName(editor, clip.mediaRef)} (audio)`,
    type: "audio",
    ...(folderId !== undefined ? { folderId } : {}),
    status: "generating",
    produce: (staged) => services.render(renderOfScratch(editor, clipRangeTimeline(editor, range), true), staged),
  });
}

/** Clip menu "Save as Media": the clip's trimmed, speed-baked source range as a new library asset. */
export async function saveClipAsMedia(
  editor: Editor,
  clipId: string,
  services: SaveAsMediaServices = saveAsMediaServices,
): Promise<void> {
  const clip = editor.clipFor(clipId);
  if (!clip || (clip.mediaType !== "video" && clip.mediaType !== "audio")) return;
  const mediaType = clip.mediaType;
  const range = clipRangeOf(clip, mediaType);
  await installRenderedMedia(editor, {
    name: `${displayName(editor, clip.mediaRef)} (clip)`,
    type: mediaType,
    status: "generating",
    produce: (staged) => services.render(renderOfScratch(editor, clipRangeTimeline(editor, range), mediaType === "audio"), staged),
  });
}

/** Range menu "Save Range as Media": the selected range of the active timeline, all tracks composited, as a video. */
export async function saveTimelineRangeAsMedia(editor: Editor, services: SaveAsMediaServices = saveAsMediaServices): Promise<void> {
  const range = validSelectedTimelineRange(editor);
  if (!range || range.endFrame - range.startFrame <= 0) return;
  const job: RenderJob = {
    timelines: editor.timelines,
    timelineId: editor.timeline.id,
    assets: editor.mediaAssets,
    missingMediaRefs: [...editor.ui.missingMediaRefs],
    options: {
      codec: "H.264", resolution: "Match Timeline", includeAudio: true,
      range: { startFrame: range.startFrame, endFrame: range.endFrame },
    },
  };
  await installRenderedMedia(editor, {
    name: "Timeline range",
    type: "video",
    status: "rendering",
    produce: (staged) => services.render(job, staged),
  });
}
