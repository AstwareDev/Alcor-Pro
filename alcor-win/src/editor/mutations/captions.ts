import {
  clipSetTextFillMode, fontCaseApply, makeClip, makeTrack, makeTransformFromTopLeft, multicamMaster,
  textLayoutNaturalSize, type Clip, type TextAnimation, type TextFillMode, type TextMeasurer, type TextStyle,
  type Transform, type WordTiming,
} from "../../model";
import type { FontCase } from "../../model";
import { canvasTextMeasurer } from "../../preview/textRenderer";
import type { Editor } from "../editor";
import { clearRegion } from "./clipMutations";
import { multicamGroupOf } from "./multicamRules";

// Port of Editor/ViewModel/EditorViewModel+Captions.swift (the timeline-facing parts) plus
// `TextClipSpec` / `placeTextClips` from EditorViewModel+MediaLibrary.swift. The transcription orchestration
// (prepareTranscript, generateCaptions, …) lives in src/captions/captionGeneration.ts.

export interface TextClipSpec {
  trackIndex: number;
  startFrame: number;
  durationFrames: number;
  content: string;
  style: TextStyle;
  /** When undefined the box is auto-fit to content and centered on the canvas. */
  transform?: Transform | undefined;
  captionGroupId?: string | undefined;
  /** Per-word timing (clip-relative frames) for karaoke animation. */
  words?: WordTiming[] | undefined;
  animation?: TextAnimation | undefined;
  fillMode?: TextFillMode | undefined;
}

export function makeTextClipSpec(
  p: Pick<TextClipSpec, "trackIndex" | "startFrame" | "durationFrames" | "content" | "style"> & Partial<TextClipSpec>,
): TextClipSpec {
  return { ...p };
}

// MARK: - CaptionCase

export const captionCases = ["auto", "upper", "lower"] as const;
export type CaptionCase = (typeof captionCases)[number];

function fontCaseOf(c: CaptionCase): FontCase {
  return c === "auto" ? "mixed" : c === "upper" ? "uppercase" : "lowercase";
}

export function captionCaseApply(c: CaptionCase, s: string): string {
  return fontCaseApply(fontCaseOf(c), s);
}

export function captionCaseLabel(c: CaptionCase): string {
  return c === "auto" ? "Auto" : c === "upper" ? "Uppercase" : "Lowercase";
}

// MARK: - Errors

export class CaptionError extends Error {
  readonly kind: "noSource" | "timelineChanged";
  constructor(kind: "noSource" | "timelineChanged") {
    super(kind === "noSource" ? "No audio clips to caption." : "The timeline changed while captions were being prepared. Try again.");
    this.name = "CaptionError";
    this.kind = kind;
  }
}

// MARK: - Caption groups

/** Text clip ids in a caption group, in timeline order. Empty if the group has no text clips. */
export function captionGroupTextClipIdsForGroup(editor: Editor, groupId: string): string[] {
  return editor.timeline.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.captionGroupId === groupId && c.mediaType === "text")
    .map((c) => c.id);
}

/** Text clip ids in the clip's caption group, or the clip's id if none. */
export function captionGroupTextClipIds(editor: Editor, clipId: string): string[] {
  const clip = editor.clipFor(clipId);
  if (!clip || clip.captionGroupId === undefined) return [clipId];
  const ids = captionGroupTextClipIdsForGroup(editor, clip.captionGroupId);
  return ids.length === 0 ? [clipId] : ids;
}

// MARK: - Targets

export function captionCanTranscribe(editor: Editor, clip: Clip): boolean {
  if (clip.mediaType !== "video" && clip.mediaType !== "audio") return false;
  const asset = editor.mediaAsset(clip.mediaRef);
  if (!asset) return true;
  return asset.type === "audio" || (asset.type === "video" && asset.hasAudio);
}

export function captionUsesVideoAudioExtraction(editor: Editor, clip: Clip): boolean {
  const assetType = editor.mediaAsset(clip.mediaRef)?.type;
  return assetType === "video" || (assetType === undefined && clip.mediaType === "video");
}

function linkGroupsWithAudio(clips: readonly Clip[]): Set<string> {
  const out = new Set<string>();
  for (const c of clips) if (c.mediaType === "audio" && c.linkGroupId !== undefined) out.add(c.linkGroupId);
  return out;
}

function captionTargetsIn(editor: Editor, pool: readonly Clip[], audioGroups: ReadonlySet<string>, allowAnyMulticamMic: boolean): Clip[] {
  return pool
    .filter((clip) => {
      if (!captionCanTranscribe(editor, clip)) return false;
      const group = multicamGroupOf(editor, clip);
      if (group) {
        return clip.mediaType === "audio" && (allowAnyMulticamMic || clip.mediaRef === multicamMaster(group)?.mediaRef);
      }
      if (clip.mediaType !== "video" || clip.linkGroupId === undefined) return true;
      return !audioGroups.has(clip.linkGroupId);
    })
    .sort((a, b) => a.startFrame - b.startFrame);
}

/** Clips to caption: the given ids (or every clip when empty), restricted to the audio side of linked pairs. */
export function captionTargets(editor: Editor, ids: readonly string[]): Clip[] {
  const clips = editor.timeline.tracks.flatMap((t) => t.clips);
  const selected = new Set(ids);
  const pool = ids.length === 0 ? clips : clips.filter((c) => selected.has(c.id));
  return captionTargetsIn(editor, pool, linkGroupsWithAudio(pool), ids.length > 0);
}

/**
 * Targets for a clip scope explicitly named by an agent tool. Like any explicit selection, this may choose any
 * multicam mic; it additionally rejects a linked video when its audio-side clip exists elsewhere on the timeline.
 */
export function transcriptionTargets(editor: Editor, clipIds: readonly string[]): Clip[] {
  const clips = editor.timeline.tracks.flatMap((t) => t.clips);
  const selected = new Set(clipIds);
  const pool = clips.filter((c) => selected.has(c.id));
  return captionTargetsIn(editor, pool, linkGroupsWithAudio(clips), true);
}

export function captionTargetsForTracks(editor: Editor, trackIds: ReadonlySet<string>): Clip[] {
  if (trackIds.size === 0) return [];
  const clips = editor.timeline.tracks.flatMap((t) => t.clips);
  const pool = editor.timeline.tracks.filter((t) => trackIds.has(t.id)).flatMap((t) => t.clips);
  return captionTargetsIn(editor, pool, linkGroupsWithAudio(clips), true);
}

// MARK: - Placement

/**
 * Batch placement of text clips (`placeTextClips`). The caller owns the undo action and track creation, so call this
 * inside `editor.perform`. Returns the created clip ids in spec order.
 */
export function placeTextClips(
  editor: Editor,
  specs: readonly TextClipSpec[],
  options: { clearExistingRegions?: boolean; measure?: TextMeasurer } = {},
): string[] {
  const { clearExistingRegions = true, measure = canvasTextMeasurer } = options;
  if (specs.length === 0) return [];
  const canvasW = editor.timeline.width;
  const canvasH = editor.timeline.height;
  const createdIds: (string | undefined)[] = specs.map(() => undefined);

  let orderedIndices: number[];
  if (clearExistingRegions) {
    const byTrack = new Map<number, number[]>();
    specs.forEach((s, i) => byTrack.set(s.trackIndex, [...(byTrack.get(s.trackIndex) ?? []), i]));
    orderedIndices = [...byTrack.values()].flatMap((indices) => indices.sort((a, b) => specs[a].startFrame - specs[b].startFrame));
  } else {
    orderedIndices = specs.map((_, i) => i);
  }

  for (const i of orderedIndices) {
    const spec = specs[i];
    if (!(spec.trackIndex >= 0 && spec.trackIndex < editor.timeline.tracks.length)) continue;
    const start = Math.max(0, spec.startFrame);
    const duration = Math.max(1, spec.durationFrames);
    if (clearExistingRegions) clearRegion(editor, spec.trackIndex, start, start + duration, { prune: false });
    // clearRegion can't remove tracks with prune off, so the index stays valid.
    let resolved: Transform;
    if (spec.transform) {
      resolved = structuredClone(spec.transform);
    } else {
      const natural = textLayoutNaturalSize(spec.content, spec.style, canvasW * 0.9, canvasH, measure);
      const w = natural.width / canvasW;
      const h = natural.height / canvasH;
      resolved = makeTransformFromTopLeft({ x: (1 - w) / 2, y: (1 - h) / 2 }, w, h);
    }
    const clip = makeClip({
      mediaRef: "",
      mediaType: "text",
      sourceClipType: "text",
      startFrame: start,
      durationFrames: duration,
      transform: resolved,
      textContent: spec.content,
      textStyle: structuredClone(spec.style),
      ...(spec.captionGroupId !== undefined ? { captionGroupId: spec.captionGroupId } : {}),
      ...(spec.words !== undefined ? { wordTimings: structuredClone(spec.words) } : {}),
      ...(spec.animation !== undefined ? { textAnimation: structuredClone(spec.animation) } : {}),
    });
    if (spec.fillMode !== undefined) clipSetTextFillMode(clip, spec.fillMode, spec.style.color);
    editor.timeline.tracks[spec.trackIndex].clips.push(clip);
    createdIds[i] = clip.id;
  }

  for (const i of new Set(specs.map((s) => s.trackIndex))) {
    if (i >= 0 && i < editor.timeline.tracks.length) editor.sortClips(i);
  }
  return createdIds.filter((id): id is string => id !== undefined);
}

/**
 * Inserts a new top video track holding the specs as text clips; one undo step. Nested inside an open action this
 * joins the outer one. Returns the created clip ids (empty, and nothing recorded, when there are no specs).
 */
export function placeCaptionTrack(
  editor: Editor,
  specs: readonly TextClipSpec[],
  actionName: string,
  options: { measure?: TextMeasurer } = {},
): string[] {
  // A spec can only land if its track exists once the new track is inserted.
  if (!specs.some((s) => s.trackIndex >= 0 && s.trackIndex <= editor.timeline.tracks.length)) return [];
  return editor.perform(actionName, () => {
    editor.timeline.tracks.unshift(makeTrack({ type: "video" }));
    return placeTextClips(editor, specs, { clearExistingRegions: false, ...options });
  });
}
