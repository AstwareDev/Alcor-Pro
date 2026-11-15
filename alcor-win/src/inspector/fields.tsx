import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import { Portal } from "solid-js/web";
import {
  VolumeScale,
  clipBlurRadius,
  clipContainsTimelineFrame,
  clipCropAt,
  clipHasActiveKeyframes,
  clipKeyframeFrames,
  clipLiveVolumeKfDb,
  clipRawOpacityAt,
  clipRotationAt,
  clipSizeAt,
  clipTextStyleAt,
  clipTopLeftAt,
  cropInset,
  cropMaximumInset,
  cropSetInset,
  textStyleScaledVisualStyle,
  type AnimatableProperty,
  type Clip,
  type CropEdge,
} from "../model";
import type { Editor } from "../editor/editor";
import { revertClipProperties, commitClipProperties } from "../editor/mutations/clipMutations";
import { seekToFrame } from "../editor/mutations/core";
import {
  applyBlur, applyCrop, applyOpacity, applyPositions, applyRotation, applyScale, applyTextSize, applyVolume,
  commitCrop, commitPositions, commitRotation, commitScalarProperty,
  toggleKeyframe,
} from "../editor/mutations/keyframes";
import { KeyframeControlStrip } from "../ui/KeyframeControlStrip";
import { RotationSnap, sharedValue } from "../ui/numberField";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";

/** Clips for `ids`, re-read whenever the document changes. */
export function useClips(editor: Editor, ids: Accessor<readonly string[]>): Accessor<Clip[]> {
  return createMemo(() => ids().flatMap((id) => editor.clipFor(id) ?? []));
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Memo over a list of ids that only notifies when the ids actually change. */
export function idsMemo(compute: () => readonly string[]): Accessor<readonly string[]> {
  return createMemo(compute, [], { equals: sameList });
}

interface ScalarConfig {
  min: number;
  max: number;
  multiplier: number;
  format: string;
  suffix: string;
  sensitivity: number;
  actionName: string;
}

function scalarConfig(property: AnimatableProperty, clips: readonly Clip[]): ScalarConfig {
  switch (property) {
    case "opacity": return { min: 0, max: 1, multiplier: 100, format: "%.0f", suffix: "%", sensitivity: 1, actionName: "Change Opacity" };
    case "rotation": return { min: -3600, max: 3600, multiplier: 1, format: "%.0f", suffix: "°", sensitivity: 1, actionName: "Change Rotation" };
    case "scale":
      return clips.length > 0 && clips.every((c) => c.mediaType === "text")
        ? { min: 12, max: 300, multiplier: 1, format: "%.0f", suffix: " pt", sensitivity: 1, actionName: "Change Text Size" }
        : { min: 0.01, max: Infinity, multiplier: 100, format: "%.0f", suffix: "%", sensitivity: 1, actionName: "Change Scale" };
    case "blur": return { min: 0, max: 100, multiplier: 1, format: "%.0f", suffix: " px", sensitivity: 1, actionName: "Change Blur" };
    case "volume":
      return { min: VolumeScale.floorDb, max: VolumeScale.ceilingDb, multiplier: 1, format: "%.1f", suffix: " dB", sensitivity: 0.3, actionName: "Change Volume" };
    default: return { min: 0, max: 1, multiplier: 1, format: "%.0f", suffix: "", sensitivity: 1, actionName: "Change Clip Property" };
  }
}

function scalarValue(editor: Editor, clip: Clip, property: AnimatableProperty): number {
  const frame = clipHasActiveKeyframes(clip, property) ? editor.ui.currentFrame : 0;
  switch (property) {
    case "opacity": return clipRawOpacityAt(clip, frame);
    case "rotation": return clipRotationAt(clip, frame);
    case "scale":
      return clip.mediaType === "text" ? textStyleScaledVisualStyle(clipTextStyleAt(clip, frame)).fontSize : clipSizeAt(clip, frame).width;
    case "blur": return clipBlurRadius(clip, frame);
    case "volume": return clipLiveVolumeKfDb(clip, frame) ?? VolumeScale.dbFromLinear(clip.volume);
    default: return 0;
  }
}

/** Port of `KeyframePropertyValueFields` (inspector style): value field(s) for one animatable property. */
export function KeyframePropertyFields(props: { editor: Editor; ids: Accessor<readonly string[]>; property: AnimatableProperty }) {
  const { editor, property } = props;
  const clips = useClips(editor, props.ids);
  let interactionIds: string[] | undefined;
  let interactionFrame: number | undefined;

  const begin = (): void => {
    if (editor.ui.isPlaying) editor.ui.isPlaying = false;
    interactionIds = clips().map((c) => c.id);
    interactionFrame = editor.ui.currentFrame;
  };
  const end = (): void => {
    interactionIds = undefined;
    interactionFrame = undefined;
  };
  const cancel = (): void => revertClipProperties(editor, interactionIds ?? props.ids());

  /** Ids to write to, or undefined when the playhead moved off an animated target mid-gesture. */
  const targets = (commit: boolean, actionName: string): string[] | undefined => {
    const ids = interactionIds ?? [...props.ids()];
    if (ids.length === 0) return undefined;
    const frame = interactionFrame ?? editor.ui.currentFrame;
    const animated = ids.some((id) => {
      const c = editor.clipFor(id);
      return c !== null && clipHasActiveKeyframes(c, property);
    });
    if (editor.ui.currentFrame !== frame && animated) {
      if (commit) commitClipProperties(editor, ids, () => undefined, actionName);
      return undefined;
    }
    return ids;
  };

  const cfg = createMemo(() => scalarConfig(property, clips()));

  const writeScalar = (value: number, commit: boolean): void => {
    const ids = targets(commit, cfg().actionName);
    if (!ids) return;
    if (property === "rotation") {
      if (commit) commitRotation(editor, ids, value);
      else applyRotation(editor, ids, value);
      return;
    }
    if (commit) {
      commitScalarProperty(editor, ids, property as "opacity" | "scale" | "blur" | "volume", value, cfg().actionName);
      return;
    }
    for (const id of ids) {
      const text = editor.clipFor(id)?.mediaType === "text";
      switch (property) {
        case "opacity": applyOpacity(editor, id, value); break;
        case "scale": if (text) applyTextSize(editor, id, value); else applyScale(editor, id, value); break;
        case "blur": applyBlur(editor, [id], value); break;
        case "volume": applyVolume(editor, id, value); break;
        default:
      }
    }
  };

  const writePosition = (value: number, axis: "x" | "y", commit: boolean): void => {
    const ids = targets(commit, "Change Position");
    if (!ids) return;
    const x = axis === "x" ? value : undefined;
    const y = axis === "y" ? value : undefined;
    if (commit) commitPositions(editor, ids, x, y);
    else applyPositions(editor, ids, x, y);
  };

  const posValue = (axis: "x" | "y"): number | undefined =>
    sharedValue(clips(), (c) => {
      const frame = clipHasActiveKeyframes(c, "position") ? editor.ui.currentFrame : 0;
      return clipTopLeftAt(c, frame)[axis];
    });

  const [cropOpen, setCropOpen] = createSignal<{ x: number; y: number } | null>(null);
  const writeCrop = (value: number, edge: CropEdge, commit: boolean): void => {
    if (editor.ui.cropAspectLock.kind !== "free") return;
    const ids = targets(commit, "Change Crop");
    const id = ids?.[0];
    const clip = id === undefined ? null : editor.clipFor(id);
    if (id === undefined || !clip) return;
    const crop = structuredClone(clipCropAt(clip, interactionFrame ?? editor.ui.currentFrame));
    cropSetInset(crop, value, edge);
    if (commit) commitCrop(editor, id, crop);
    else applyCrop(editor, id, crop);
  };

  return (
    <>
      <Show when={property === "position"}>
        <div class="field-pair">
          {(["x", "y"] as const).map((axis) => (
            <ScrubbableNumberField
              value={posValue(axis)}
              range={{ min: -10, max: 10 }}
              displayMultiplier={axis === "x" ? editor.timeline.width : editor.timeline.height}
              fieldWidth="var(--compact-field-w)"
              trailingLabel={axis.toUpperCase()}
              onChanged={(v) => writePosition(v, axis, false)}
              onInteractionStart={begin}
              onInteractionEnd={end}
              onCancel={cancel}
              onCommit={(v) => writePosition(v, axis, true)}
            />
          ))}
        </div>
      </Show>
      <Show when={property === "crop"}>
        <button
          type="button"
          class="editor-value-field crop-insets"
          classList={{ active: cropOpen() !== null }}
          onClick={(e) => {
            if (cropOpen()) return setCropOpen(null);
            if (editor.ui.isPlaying) editor.ui.isPlaying = false;
            const r = e.currentTarget.getBoundingClientRect();
            setCropOpen({ x: Math.max(4, r.right - 180), y: r.bottom + 4 });
          }}
        >
          Insets
        </button>
        <Show when={cropOpen()}>
          {(p) => (
            <Portal>
              <div class="crop-popover" style={{ left: `${p().x}px`, top: `${p().y}px` }}>
                <Show
                  when={editor.ui.cropAspectLock.kind === "free"}
                  fallback={
                    <>
                      <span class="hint">Use Freeform to edit individual crop insets.</span>
                      <button type="button" class="link-button" onClick={() => (editor.ui.cropAspectLock = { kind: "free" })}>Use Freeform</button>
                    </>
                  }
                >
                  {(["left", "top", "right", "bottom"] as const).map((edge) => {
                    const crop = (): ReturnType<typeof clipCropAt> | undefined => {
                      const c = clips()[0];
                      return c ? clipCropAt(c, clipHasActiveKeyframes(c, "crop") ? editor.ui.currentFrame : 0) : undefined;
                    };
                    return (
                      <div class="inspector-row">
                        <span class="inspector-row-label" style={{ width: "auto", flex: "1" }}>{edge[0]?.toUpperCase() + edge.slice(1)}</span>
                        <ScrubbableNumberField
                          value={((): number | undefined => { const c = crop(); return c ? cropInset(c, edge) : undefined; })()}
                          range={{ min: 0, max: ((): number => { const c = crop(); return c ? cropMaximumInset(c, edge) : 1; })() }}
                          displayMultiplier={100}
                          valueSuffix="%"
                          fieldWidth="var(--numeric-field-w)"
                          onChanged={(v) => writeCrop(v, edge, false)}
                          onInteractionStart={begin}
                          onInteractionEnd={end}
                          onCancel={cancel}
                          onCommit={(v) => writeCrop(v, edge, true)}
                        />
                      </div>
                    );
                  })}
                </Show>
              </div>
            </Portal>
          )}
        </Show>
      </Show>
      <Show when={property !== "position" && property !== "crop"}>
        <ScrubbableNumberField
          value={sharedValue(clips(), (c) => scalarValue(editor, c, property))}
          range={{ min: cfg().min, max: cfg().max }}
          displayMultiplier={cfg().multiplier}
          format={cfg().format}
          valueSuffix={cfg().suffix}
          dragSensitivity={cfg().sensitivity}
          fieldWidth="var(--numeric-field-w)"
          dragValueAdjustment={property === "rotation" ? RotationSnap.adjusted : undefined}
          displayTextOverride={property === "volume" ? (v) => (v <= VolumeScale.floorDb ? "-∞ dB" : undefined) : undefined}
          onChanged={(v) => writeScalar(v, false)}
          onInteractionStart={begin}
          onInteractionEnd={end}
          onCancel={cancel}
          onCommit={(v) => writeScalar(v, true)}
        />
      </Show>
    </>
  );
}

/** Port of `InspectorKeyframeControls`; only single selections get working controls. */
export function InspectorKeyframeControls(props: { editor: Editor; clipId: string | undefined; property: AnimatableProperty }) {
  const { editor, property } = props;
  const state = createMemo(() => {
    const id = props.clipId;
    const clip = id === undefined ? null : editor.clipFor(id);
    if (!clip) return null;
    const hasAny = clipHasActiveKeyframes(clip, property);
    const frame = editor.ui.currentFrame;
    const frames = clipKeyframeFrames(clip, property);
    return {
      inRange: clipContainsTimelineFrame(clip, frame),
      previous: frames.filter((f) => f < frame).reduce<number | undefined>((m, f) => (m === undefined || f > m ? f : m), undefined),
      next: frames.filter((f) => f > frame).reduce<number | undefined>((m, f) => (m === undefined || f < m ? f : m), undefined),
      on: frames.includes(frame),
      hasAny,
    };
  });
  return (
    <Show when={props.clipId !== undefined} fallback={<span style={{ width: "var(--keyframe-strip-w)", flex: "none" }} />}>
      <KeyframeControlStrip
        onPrevious={state()?.previous === undefined ? undefined : () => seekToFrame(editor, state()?.previous ?? 0)}
        onKeyframe={state()?.inRange ? () => toggleKeyframe(editor, props.clipId ?? "", property, editor.ui.currentFrame) : undefined}
        onNext={state()?.next === undefined ? undefined : () => seekToFrame(editor, state()?.next ?? 0)}
        isOnKeyframe={state()?.on ?? false}
        hasKeyframes={state()?.hasAny ?? false}
        unavailableKeyframeHelp="Move playhead inside the clip"
      />
    </Show>
  );
}

/** Port of `InspectorKeyframePropertyControl`. */
export function KeyframePropertyControl(props: { editor: Editor; ids: Accessor<readonly string[]>; property: AnimatableProperty }) {
  return (
    <>
      <KeyframePropertyFields editor={props.editor} ids={props.ids} property={props.property} />
      <InspectorKeyframeControls editor={props.editor} clipId={props.ids().length === 1 ? props.ids()[0] : undefined} property={props.property} />
    </>
  );
}
