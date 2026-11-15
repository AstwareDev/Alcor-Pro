import type { Editor } from "../editor";
import { expandToLinkGroup } from "./linking";

export type SelectForwardScope = "track" | "allTracks";

export function selectPreviewClip(editor: Editor, clipId: string): void {
  editor.ui.selectedGap = null;
  editor.ui.selectedTimelineMarkerIds = new Set();
  if (editor.ui.selectedClipIds.has(clipId)) return;
  editor.ui.selectedClipIds = expandToLinkGroup(editor, new Set([clipId]));
}

export function selectForwardFromCurrentSelection(editor: Editor, scope: SelectForwardScope): void {
  const anchorId = forwardSelectionAnchorId(editor);
  if (anchorId === undefined) return;
  selectForward(editor, anchorId, scope);
}

export function selectForward(editor: Editor, clipId: string, scope: SelectForwardScope): void {
  const anchorLoc = editor.findClip(clipId);
  if (!anchorLoc) return;
  const tracks = editor.timeline.tracks;
  const anchorClip = tracks[anchorLoc.trackIndex].clips[anchorLoc.clipIndex];
  const ids = new Set<string>();

  tracks.forEach((track, trackIndex) => {
    if (scope !== "allTracks" && trackIndex !== anchorLoc.trackIndex) return;
    for (const clip of track.clips) if (clip.startFrame >= anchorClip.startFrame) ids.add(clip.id);
  });

  editor.ui.selectedClipIds = expandToLinkGroup(editor, ids);
  editor.ui.selectedGap = null;
  editor.ui.selectedTimelineRange = null;
  editor.ui.selectedTimelineMarkerIds = new Set();
}

function forwardSelectionAnchorId(editor: Editor): string | undefined {
  const candidates: { trackIndex: number; id: string; startFrame: number }[] = [];
  editor.timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (editor.ui.selectedClipIds.has(clip.id)) candidates.push({ trackIndex, id: clip.id, startFrame: clip.startFrame });
    }
  });
  candidates.sort((a, b) => (a.startFrame === b.startFrame ? a.trackIndex - b.trackIndex : a.startFrame - b.startFrame));
  return candidates[0]?.id;
}
