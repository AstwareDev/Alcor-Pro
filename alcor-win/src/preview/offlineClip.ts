import { clipContainsTimelineFrame, clipOpacityAt, mediaAssetIsGenerating, type Clip } from "../model";
import type { Editor } from "../editor/editor";
import { isMediaOffline, isMediaUnprocessable, unprocessableMediaRefs } from "../media/libraryCore";

/** `TimelineFrameState` of PreviewContainerView: what the preview shows for the clips under the playhead. */
export type TimelineFrameState =
  | { kind: "covered" }
  | { kind: "generating" }
  | { kind: "offline"; clip: Clip }
  | { kind: "none" };

/** The first offline clip visible at `frame`, unless another visible clip with usable media covers the frame. */
export function timelineFrameState(editor: Editor, frame: number): TimelineFrameState {
  const hasOffline =
    editor.ui.offlineMediaRefs.size > 0 || unprocessableMediaRefs(editor).size > 0 || editor.ui.missingMediaRefs.size > 0;
  const generating = new Set(editor.mediaAssets.filter(mediaAssetIsGenerating).map((a) => a.id));
  if (!hasOffline && generating.size === 0) return { kind: "none" };
  let offline: Clip | undefined;
  let anyGenerating = false;
  for (const track of editor.timeline.tracks) {
    if (track.type === "audio" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.mediaType === "text") continue;
      if (!clipContainsTimelineFrame(clip, frame) || !(clipOpacityAt(clip, frame) > 0.01)) continue;
      if (generating.has(clip.mediaRef)) anyGenerating = true;
      else if (isMediaOffline(editor, clip.mediaRef)) offline ??= clip;
      else return { kind: "covered" };
    }
  }
  if (anyGenerating) return { kind: "generating" };
  return offline ? { kind: "offline", clip: offline } : { kind: "none" };
}

export interface OfflineOverlay {
  assetId: string;
  path: string | undefined;
  isUnprocessable: boolean;
}

/** The offline card for the playhead frame, or undefined when nothing visible is offline. */
export function offlineOverlayAt(editor: Editor, frame: number): OfflineOverlay | undefined {
  const state = timelineFrameState(editor, frame);
  if (state.kind !== "offline") return undefined;
  const ref = state.clip.mediaRef;
  return { assetId: ref, path: editor.mediaAsset(ref)?.url, isUnprocessable: isMediaUnprocessable(editor, ref) };
}
