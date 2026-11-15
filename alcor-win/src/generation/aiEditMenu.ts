// Port of Edit/AIEditMenu.swift: the "AI Edit" submenu for a media asset and for a timeline clip.
import type { Editor } from "../editor/editor";
import {
  aiAudioTransformKinds, aiEditActions, aiEditAllowed, beginAIAudioTransform, beginAICreateVideo, beginAIEdit, beginAILipSync,
  beginAIReframe, beginAIRerun, beginAIUpscale, beginAIVideoAudio, seedGenerationPanel,
} from "../editor/mutations/aiEdit";
import type { MediaAsset } from "../model";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { upscaleModelsFor } from "./catalog";
import { audioTransformCopy, availableAudioTransforms, type AudioTransformEditKind } from "./edit/audioTransformEditKind";
import { availableEditActions, editActionGroup, type EditAction } from "./edit/editAction";
import {
  audioTransformSeed, createVideoSeed, editSeed, lipSyncSeed, reframeSeed, upscaleSeed, videoAudioSeed,
} from "./edit/editSubmitter";
import { videoToAudioKinds, type VideoToAudioEditKind } from "./edit/videoToAudioEditKind";
import { upscaleSupports } from "./modelConfig";

interface MenuActions {
  upscale(): void;
  edit(): void;
  rerun(): void;
  lipSync(): void;
  reframe(): void;
  createVideo(asReference: boolean): void;
  videoAudio(kind: VideoToAudioEditKind): void;
  audioTransform(kind: AudioTransformEditKind): void;
}

const item = (label: string, onSelect: () => void): ContextMenuItem => ({ kind: "item", label, onSelect });

function buildMenu(mediaType: MediaAsset["type"], actions: readonly EditAction[], transforms: readonly AudioTransformEditKind[], run: MenuActions): ContextMenuItem[] {
  if (actions.length === 0 && transforms.length === 0) return [];
  if (!aiEditAllowed()) return [{ kind: "item", label: "AI Edit (add an API key in Settings)", disabled: true }];
  const enhance = actions.filter((a) => editActionGroup(a, mediaType) === "enhance");
  const audio = actions.filter((a) => editActionGroup(a, mediaType) === "audio");
  const sub: ContextMenuItem[] = [];
  if (enhance.length > 0) {
    sub.push({ kind: "item", label: "AI Enhance", disabled: true });
    if (enhance.includes("upscale")) sub.push(item("Upscale…", run.upscale));
    if (enhance.includes("edit")) sub.push(item("Edit…", run.edit));
    if (enhance.includes("rerun")) sub.push(item("Rerun", run.rerun));
    if (enhance.includes("lipSync")) sub.push(item("Lip Sync…", run.lipSync));
    if (enhance.includes("reframe")) sub.push(item("Reframe…", run.reframe));
    if (enhance.includes("createVideo")) {
      sub.push({ kind: "item", label: "Create Video", submenu: [item("Set as first frame", () => run.createVideo(false)), item("Set as reference", () => run.createVideo(true))] });
    }
  }
  if (audio.length > 0 || transforms.length > 0) {
    if (sub.length > 0) sub.push({ kind: "divider" });
    sub.push({ kind: "item", label: "AI Audio", disabled: true });
    if (audio.includes("rerun")) sub.push(item("Rerun", run.rerun));
    for (const kind of transforms) sub.push(item(audioTransformCopy[kind].menuTitle, () => run.audioTransform(kind)));
    if (audio.includes("generateMusic")) sub.push(item(videoToAudioKinds.music.menuTitle, () => run.videoAudio("music")));
    if (audio.includes("generateSFX")) sub.push(item(videoToAudioKinds.sfx.menuTitle, () => run.videoAudio("sfx")));
  }
  return [{ kind: "item", label: "AI Edit", submenu: sub }];
}

/** Media-panel context menu section for one asset (no clip: nothing is replaced or placed). */
export function aiEditAssetMenuItems(editor: Editor, asset: MediaAsset): ContextMenuItem[] {
  const seed = (stored: ReturnType<typeof editSeed>): void => { if (stored) seedGenerationPanel(editor, asset, stored); };
  return buildMenu(asset.type, availableEditActions(asset), availableAudioTransforms(asset), {
    upscale: () => {
      if (asset.type !== "image" && asset.type !== "video") return;
      const model = upscaleModelsFor(asset.type).find((m) => upscaleSupports(m, asset));
      if (model) seed(upscaleSeed(asset, model));
    },
    edit: () => seed(editSeed(asset)),
    rerun: () => seed(asset.generationInput ? structuredClone(asset.generationInput) : undefined),
    lipSync: () => seed(lipSyncSeed(asset)),
    reframe: () => seed(reframeSeed(asset)),
    createVideo: (asReference) => seed(createVideoSeed(asset, asReference)),
    videoAudio: (kind) => seed(videoAudioSeed(asset, kind)),
    audioTransform: (kind) => seed(audioTransformSeed(asset, kind)),
  });
}

/**
 * Timeline clip context-menu section: `clipMenuSectionProviders.push(aiEditClipMenuProvider(editor))`.
 * Actions are clip-aware (trimmed range sent, source replaced on completion where applicable).
 */
export function aiEditClipMenuProvider(editor: Editor): (clipId: string) => ContextMenuItem[] {
  return (clipId) => {
    const clip = editor.clipFor(clipId);
    const asset = clip ? editor.mediaAsset(clip.mediaRef) : undefined;
    if (!clip || !asset) return [];
    return buildMenu(asset.type, aiEditActions(editor, clipId), aiAudioTransformKinds(editor, clipId), {
      upscale: () => beginAIUpscale(editor, clipId),
      edit: () => beginAIEdit(editor, clipId),
      rerun: () => beginAIRerun(editor, clipId),
      lipSync: () => beginAILipSync(editor, clipId),
      reframe: () => beginAIReframe(editor, clipId),
      createVideo: (asReference) => beginAICreateVideo(editor, clipId, asReference),
      videoAudio: (kind) => beginAIVideoAudio(editor, clipId, kind),
      audioTransform: (kind) => beginAIAudioTransform(editor, clipId, kind),
    });
  };
}
