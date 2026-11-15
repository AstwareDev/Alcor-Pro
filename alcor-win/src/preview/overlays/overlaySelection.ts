import type { Editor } from "../../editor/editor";
import type { Clip } from "../../model";

/** Port of `TransformOverlayView.selectedClip`: the first selected clip on a non-audio track. */
export function selectedVisualClip(editor: Editor): Clip | undefined {
  const ids = editor.ui.selectedClipIds;
  if (ids.size === 0) return undefined;
  for (const track of editor.timeline.tracks) {
    if (track.type === "audio") continue;
    for (const clip of track.clips) if (ids.has(clip.id) && clip.adjustment !== true) return clip;
  }
  return undefined;
}

/** Port of `CropOverlayView.selectedClip`: exactly one selected non-text clip on non-audio tracks, else none. */
export function selectedCropClip(editor: Editor): Clip | undefined {
  const ids = editor.ui.selectedClipIds;
  if (ids.size === 0) return undefined;
  let match: Clip | undefined;
  for (const track of editor.timeline.tracks) {
    if (track.type === "audio") continue;
    for (const clip of track.clips) {
      if (!ids.has(clip.id) || clip.mediaType === "text") continue;
      if (match) return undefined;
      match = clip;
    }
  }
  return match;
}
