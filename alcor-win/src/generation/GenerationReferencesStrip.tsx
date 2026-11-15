// Port of Inspector/Components/GenerationReferencesStrip.swift.
import { For, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { selectMediaPanelItemAndReveal } from "../editor/mutations/mediaPanel";
import type { GenerationInput, MediaAsset } from "../model";
import { catalogEntry } from "./providers/registry";
import { videoRequiresSourceVideo, videoSupportsReferences, isAudioEntry, isUpscaleEntry, isVideoEntry, audioInputs } from "./modelConfig";
import type { ThumbnailProvider } from "../mediapanel/thumbnailProvider";
import { RefCard } from "./RefControls";
import "./generation.css";

function primaryLabels(gen: GenerationInput): string[] {
  const m = catalogEntry(gen.model);
  if (isVideoEntry(m)) {
    if (videoRequiresSourceVideo(m)) return videoSupportsReferences(m) ? ["Source", "Reference"] : ["Source"];
    if (m.uiCapabilities.supportsFirstFrame) return m.uiCapabilities.supportsLastFrame ? ["First Frame", "Last Frame"] : ["First Frame"];
    return [];
  }
  return isUpscaleEntry(m) ? ["Source"] : [];
}

export function generationReferenceSlots(gen: GenerationInput, assets: readonly MediaAsset[]): [string, MediaAsset][] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const entry = catalogEntry(gen.model);
  const videoBase = isAudioEntry(entry) && audioInputs(entry).includes("video") ? "Source Video" : "Video Ref";
  const groups: [string[] | undefined, string, string[]][] = [
    [gen.imageURLAssetIds, "Reference", primaryLabels(gen)],
    [gen.referenceImageAssetIds, "Image Ref", []],
    [gen.referenceVideoAssetIds, videoBase, []],
    [gen.referenceAudioAssetIds, "Audio Ref", []],
  ];
  return groups.flatMap(([ids, base, primary]) =>
    (ids ?? []).flatMap((id, i): [string, MediaAsset][] => {
      const a = byId.get(id);
      if (!a) return [];
      return [[i < primary.length ? primary[i] : (ids?.length ?? 0) > 1 ? `${base} ${i + 1}` : base, a]];
    }),
  );
}

export const hasResolvableReferences = (gen: GenerationInput, assets: readonly MediaAsset[]): boolean => generationReferenceSlots(gen, assets).length > 0;

export function GenerationReferencesStrip(props: { editor: Editor; generationInput: GenerationInput; thumbnailProvider?: ThumbnailProvider }) {
  const slots = () => generationReferenceSlots(props.generationInput, props.editor.mediaAssets);
  return (
    <Show when={slots().length > 0}>
      <div class="gen-strip">
        <For each={slots()}>
          {([label, asset]) => (
            <div class="gen-strip-item" title={`${label} · ${asset.name}`} onClick={() => selectMediaPanelItemAndReveal(props.editor, asset.id)}>
              <RefCard asset={asset} provider={props.thumbnailProvider} />
              <span>{label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
