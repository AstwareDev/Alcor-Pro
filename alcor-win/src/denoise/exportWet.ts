import type { Editor } from "../editor/editor";
import type { ExportJobSpec } from "../export/exportTypes";
import { mediaUrl } from "../media/mediaUrl";
import { makeMediaAsset } from "../model/mediaAsset";
import { clipDenoiseAmount, clipHasDenoiseEnabled, type Clip } from "../model";
import { wetMediaRef } from "./denoiseMix";
import { bakeDenoisesForExport, wetPathFor } from "./denoiseState";

/**
 * `ExportService` pre-bake: every denoise-enabled clip of the exported timeline is baked first (failures export the
 * original audio), then the job spec gets the wet files as pseudo assets so the mixer can blend them like playback.
 */
export async function attachWetAudio(editor: Editor, spec: ExportJobSpec, signal?: AbortSignal): Promise<void> {
  const timeline = spec.timelines.find((t) => t.id === spec.timelineId);
  if (!timeline || spec.options.includeAudio === false) return;
  const clips: Clip[] = timeline.tracks.flatMap((t) => t.clips).filter((c) => clipHasDenoiseEnabled(c) && clipDenoiseAmount(c) > 0);
  if (clips.length === 0) return;
  await bakeDenoisesForExport(editor, clips, signal);
  const refs = new Set<string>();
  for (const clip of clips) {
    const path = wetPathFor(clip.mediaRef);
    if (path === undefined || refs.has(clip.mediaRef)) continue;
    refs.add(clip.mediaRef);
    spec.mediaAssets.push(makeMediaAsset({ id: wetMediaRef(clip.mediaRef), url: mediaUrl(path), type: "audio", name: "denoised", duration: 0 }));
  }
  spec.wetMediaRefs = [...refs];
}
