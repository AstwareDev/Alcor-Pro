import { sub } from "./e2lib.mjs";
const k = "src/editor/mutations/keyframes.ts";
sub(k, `// MARK: - Drag-to-move keyframe`, `export interface KeyframeRef {
  clipId: string;
  property: AnimatableProperty;
  /** Absolute timeline frame. */
  frame: number;
}

/** Eases several keyframes at once (across clips and properties) as one undo entry. */
export function setInterpolations(editor: Editor, refs: readonly KeyframeRef[], interpolation: Interpolation, bezier?: BezierHandles): void {
  const clipIds = [...new Set(refs.map((r) => r.clipId))];
  if (clipIds.length === 0) return;
  commitClipProperties(
    editor,
    clipIds,
    (clip) => {
      for (const r of refs) if (r.clipId === clip.id) clipSetInterpolation(clip, r.property, r.frame, interpolation, bezier);
    },
    "Change Interpolation",
  );
}

/** Keyframes F9 acts on: those at the playhead on the selected clips, else every keyframe of the selected clips. */
export function selectedKeyframeRefs(editor: Editor): KeyframeRef[] {
  const atPlayhead: KeyframeRef[] = [];
  const all: KeyframeRef[] = [];
  const frame = editor.ui.currentFrame;
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      if (!editor.ui.selectedClipIds.has(clip.id)) continue;
      for (const property of animatableProperties) {
        for (const f of clipKeyframeFrames(clip, property)) {
          const ref = { clipId: clip.id, property, frame: f };
          all.push(ref);
          if (f === frame) atPlayhead.push(ref);
        }
      }
    }
  }
  return atPlayhead.length > 0 ? atPlayhead : all;
}

/** After Effects F9: easy ease on the selected keyframes. Returns false when there is nothing to ease. */
export function easyEaseSelectedKeyframes(editor: Editor): boolean {
  const refs = selectedKeyframeRefs(editor);
  if (refs.length === 0) return false;
  setInterpolations(editor, refs, "easeInOut");
  return true;
}

// MARK: - Drag-to-move keyframe`);
sub(k, `import {
  VolumeScale,`, `import {
  VolumeScale,
  animatableProperties,`);
