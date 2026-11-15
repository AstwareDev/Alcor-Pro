import {
  clipEndFrame,
  multicamMemberAnchorFrame,
  multicamMemberWithMediaRef,
  type Clip,
  type MulticamSource,
} from "../../model";
import type { Editor } from "../editor";
import type { TrimEdge } from "./linking";

// Pure multicam lookups and edit-restriction rules from EditorViewModel+Multicam.swift that the
// move / trim / ripple mutations depend on. Everything else in that file belongs to the multicam feature.

export function multicamGroupById(editor: Editor, id: string): MulticamSource | undefined {
  return editor.doc.multicamGroups.find((g) => g.id === id);
}

export function multicamGroupOf(editor: Editor, clip: Clip): MulticamSource | undefined {
  return clip.multicamGroupId === undefined ? undefined : multicamGroupById(editor, clip.multicamGroupId);
}

export function multicamClips(editor: Editor, groupId: string): { trackIndex: number; clip: Clip }[] {
  const out: { trackIndex: number; clip: Clip }[] = [];
  editor.timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) if (clip.multicamGroupId === groupId) out.push({ trackIndex, clip });
  });
  return out;
}

export interface ClipMove {
  clipId: string;
  toTrack: number;
  toFrame: number;
}

export function multicamMoveViolation(editor: Editor, moves: readonly ClipMove[]): string | null {
  const infos: { clip: Clip; toTrack: number; toFrame: number }[] = [];
  for (const m of moves) {
    const clip = editor.clipFor(m.clipId);
    if (clip) infos.push({ clip, toTrack: m.toTrack, toFrame: m.toFrame });
  }
  const movedIds = new Set(infos.map((i) => i.clip.id));
  const horizontal = infos.some((i) => i.clip.startFrame !== i.toFrame);
  const laneChange = infos.some(
    (i) =>
      i.clip.multicamGroupId !== undefined &&
      i.clip.mediaType !== "audio" &&
      editor.findClip(i.clip.id)?.trackIndex !== i.toTrack,
  );
  if (!horizontal && !laneChange) return null;
  if (laneChange) return "Can't move a multicam camera clip to another track — the group's program track stays fixed.";
  const groupIds = new Set(infos.flatMap((i) => (i.clip.multicamGroupId === undefined ? [] : [i.clip.multicamGroupId])));
  for (const gid of groupIds) {
    const leftBehind = multicamClips(editor, gid).filter((c) => !movedIds.has(c.clip.id));
    if (leftBehind.length > 0) {
      const name = multicamGroupById(editor, gid)?.name ?? "Multicam";
      return `Can't move part of multicam group "${name}" — its clips stay in sync and move together.`;
    }
  }
  return null;
}

export function multicamTrimBounds(editor: Editor, clip: Clip): { left: number; right: number } | null {
  const group = multicamGroupOf(editor, clip);
  const member = group ? multicamMemberWithMediaRef(group, clip.mediaRef) : undefined;
  if (!group || !member) return null;
  const fps = editor.timeline.fps;
  const own = multicamMemberAnchorFrame(member, clip, fps);
  let left = clip.trimStartFrame;
  let right = clip.trimEndFrame;
  for (const { clip: other } of multicamClips(editor, group.id)) {
    if (other.id === clip.id) continue;
    const m = multicamMemberWithMediaRef(group, other.mediaRef);
    if (!m || multicamMemberAnchorFrame(m, other, fps) === own) continue;
    if (clipEndFrame(other) <= clip.startFrame) left = Math.min(left, clip.startFrame - clipEndFrame(other));
    if (other.startFrame >= clipEndFrame(clip)) right = Math.min(right, other.startFrame - clipEndFrame(clip));
  }
  return { left: Math.max(0, left), right: Math.max(0, right) };
}

export function multicamRippleCohort(editor: Editor, clip: Clip, edge: TrimEdge): Clip[] {
  if (clip.multicamGroupId === undefined) return [clip];
  const boundary = edge === "left" ? clip.startFrame : clipEndFrame(clip);
  return multicamClips(editor, clip.multicamGroupId)
    .filter((item) => (edge === "left" ? item.clip.startFrame === boundary : clipEndFrame(item.clip) === boundary))
    .map((item) => item.clip);
}
