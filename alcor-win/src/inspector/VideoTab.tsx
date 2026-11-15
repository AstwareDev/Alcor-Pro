import ArrowLeftRight from "lucide-solid/icons/arrow-left-right";
import ArrowUpDown from "lucide-solid/icons/arrow-up-down";
import Crop from "lucide-solid/icons/crop";
import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import {
  blendModeDisplayName,
  blendModes,
  cropAspectLockLabel,
  cropAspectLockLockedTo,
  cropAspectLockPixelAspect,
  cropAspectLockPresets,
  cropAspectRatioPixelAspect,
  deepEqual,
  clipHasSpeedRamp,
  speedRampPresets,
  makeCrop,
  makeTransform,
  type Clip,
  type CropAspectLock,
  type CropAspectRatio,
} from "../model";
import type { Editor } from "../editor/editor";
import {
  applyClipProperties, applyClipSpeed, commitClipProperties, commitClipProperty, commitClipSpeed, dragState, revertClipProperties,
} from "../editor/mutations/clipMutations";
import { cropFittingAspect, displayedCropAspectRatio, fitTransformForClip } from "../editor/mutations/core";
import { commitCrop } from "../editor/mutations/keyframes";
import { applySpeedRampPreset, setFrameBlending } from "../editor/mutations/speedRamp";
import { CropAspectFields } from "../ui/CropAspectFields";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, IconToggleButton, InspectorRow } from "../ui/EditorPanel";
import { sharedValue } from "../ui/numberField";
import { Toggle } from "../ui/Toggle";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { InspectorKeyframeControls, KeyframePropertyControl, useClips } from "./fields";
import { MasksSection } from "./MasksSection";
import { clipDefaults, valuesModified } from "./resetState";

type Ids = Accessor<readonly string[]>;

export function VideoTab(props: { editor: Editor; visualIds: Ids; retimableIds: Ids }) {
  return (
    <>
      <TransformSection editor={props.editor} ids={props.visualIds} />
      <MasksSection editor={props.editor} ids={props.visualIds} />
      <ImageAdjustmentSection editor={props.editor} ids={props.visualIds} />
      <SpeedSection editor={props.editor} ids={props.retimableIds} />
    </>
  );
}

function TransformSection(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const [expanded, setExpanded] = createSignal(true);
  const clips = useClips(editor, props.ids);
  const commit = (name: string, modify: (c: Clip) => void): void => commitClipProperties(editor, props.ids(), modify, name);
  const single = createMemo(() => (props.ids().length === 1 ? clips()[0] : undefined));

  const resetTransform = (clip: Clip): void => {
    const d = clipDefaults();
    clip.transform = fitTransformForClip(editor, clip);
    clip.opacity = d.opacity;
    delete clip.opacityTrack;
    delete clip.positionTrack;
    delete clip.scaleTrack;
    delete clip.rotationTrack;
    clip.fadeInFrames = d.fadeInFrames;
    clip.fadeOutFrames = d.fadeOutFrames;
    clip.fadeInInterpolation = d.fadeInInterpolation;
    clip.fadeOutInterpolation = d.fadeOutInterpolation;
  };

  const animated = (label: string, property: "position" | "scale" | "rotation" | "opacity", reset: (c: Clip) => void) => (
    <InspectorRow label={label} modified={valuesModified(clips(), reset)} onReset={() => commit(`Reset ${label}`, reset)}>
      <KeyframePropertyControl editor={editor} ids={props.ids} property={property} />
    </InspectorRow>
  );

  return (
    <EditorPanelGroup
      title="Transform"
      expanded={expanded()}
      onToggle={() => setExpanded(!expanded())}
      modified={valuesModified(clips(), resetTransform)}
      onReset={() => commit("Reset Transform", resetTransform)}
    >
      {animated("Position", "position", (c) => {
        c.transform.centerX = makeTransform().centerX;
        c.transform.centerY = makeTransform().centerY;
        delete c.positionTrack;
      })}
      {animated("Scale", "scale", (c) => {
        const fitted = fitTransformForClip(editor, c);
        c.transform.width = fitted.width;
        c.transform.height = fitted.height;
        delete c.scaleTrack;
      })}
      {animated("Rotation", "rotation", (c) => {
        c.transform.rotation = makeTransform().rotation;
        delete c.rotationTrack;
      })}
      {animated("Opacity", "opacity", (c) => {
        c.opacity = clipDefaults().opacity;
        delete c.opacityTrack;
      })}
      <CropRow editor={editor} single={single} />
      <FlipRow clips={clips} commit={commit} />
      <BlendRow clips={clips} commit={commit} />
    </EditorPanelGroup>
  );
}

function resetCrop(c: Clip): void {
  c.crop = makeCrop();
  delete c.cropTrack;
}

function resetFlip(c: Clip): void {
  const d = makeTransform();
  c.transform.flipHorizontal = d.flipHorizontal;
  c.transform.flipVertical = d.flipVertical;
}

function resetBlend(c: Clip): void {
  delete c.blendMode;
}

function sameLock(a: CropAspectLock, b: CropAspectLock): boolean {
  return deepEqual(a, b);
}

function CropRow(props: { editor: Editor; single: Accessor<Clip | undefined> }) {
  const { editor } = props;
  const editing = (): boolean => editor.ui.cropEditingActive && props.single() !== undefined;
  const disabled = (): boolean => props.single() === undefined;

  const applyPreset = (preset: CropAspectLock, clip: Clip): void => {
    const currentRatio = displayedCropAspectRatio(editor, clip, false);
    const currentAspect = currentRatio ? cropAspectRatioPixelAspect(currentRatio) : undefined;
    editor.ui.cropAspectLock = preset;
    if (preset.kind === "free") return;
    if (preset.kind === "original") return commitCrop(editor, clip.id, makeCrop());
    const target = cropAspectLockPixelAspect(preset);
    if (target === undefined) return;
    if (currentAspect !== undefined && Math.abs(currentAspect - target) <= 1e-4) return;
    commitCrop(editor, clip.id, cropFittingAspect(editor, clip, target));
  };
  const menuItems = () => {
    const clip = props.single();
    if (!clip) return [];
    return cropAspectLockPresets.map((preset) => ({
      kind: "item" as const,
      label: cropAspectLockLabel(preset),
      checked: sameLock(preset, editor.ui.cropAspectLock),
      onSelect: () => applyPreset(preset, clip),
    }));
  };
  const ratio = (): CropAspectRatio | undefined => {
    const clip = props.single();
    return clip ? displayedCropAspectRatio(editor, clip) : undefined;
  };

  return (
    <div style={{ opacity: disabled() ? 0.4 : 1 }}>
      <InspectorRow
        label="Crop"
        fixedHeight
        modified={(() => {
          const clip = props.single();
          return clip !== undefined && (editor.ui.cropAspectLock.kind !== "free" || valuesModified([clip], resetCrop));
        })()}
        onReset={() => {
          const clip = props.single();
          if (!clip) return;
          editor.ui.cropAspectLock = { kind: "free" };
          commitClipProperty(editor, clip.id, resetCrop);
        }}
      >
        <IconToggleButton
          on={editing()}
          disabled={disabled()}
          help={disabled() ? "Crop applies to one clip at a time" : editing() ? "Stop editing crop on canvas" : "Edit crop on canvas"}
          onClick={() => (editor.ui.cropEditingActive = !editor.ui.cropEditingActive)}
        >
          <Crop size={12} stroke-width={2} />
        </IconToggleButton>
        <Show
          when={editing() && ratio()}
          fallback={
            <DropdownMenuButton items={menuItems} disabled={disabled()} title="Choose a crop aspect">
              <span class="crop-menu-label">
                {cropAspectLockLabel(editor.ui.cropAspectLock)}
                <span class="chev">⌄</span>
              </span>
            </DropdownMenuButton>
          }
        >
          {(r) => (
            <>
              <CropAspectFields ratio={r()} onCommit={(next) => {
                const clip = props.single();
                if (clip) applyPreset(cropAspectLockLockedTo(next), clip);
              }} />
              <DropdownMenuButton items={menuItems} title="Choose a crop aspect">
                <span class="editor-value-field crop-chev">⌄</span>
              </DropdownMenuButton>
            </>
          )}
        </Show>
        <InspectorKeyframeControls editor={editor} clipId={props.single()?.id} property="crop" />
      </InspectorRow>
    </div>
  );
}

function FlipRow(props: { clips: Accessor<Clip[]>; commit: (name: string, m: (c: Clip) => void) => void }) {
  const h = (): boolean => props.clips()[0]?.transform.flipHorizontal ?? false;
  const v = (): boolean => props.clips()[0]?.transform.flipVertical ?? false;
  return (
    <InspectorRow
      label="Flip"
      fixedHeight
      reservesKeyframeControls
      modified={valuesModified(props.clips(), resetFlip)}
      onReset={() => props.commit("Reset Flip", resetFlip)}
    >
      <IconToggleButton on={h()} help={h() ? "Remove horizontal flip" : "Flip horizontally"} onClick={() => {
        const next = !h();
        props.commit("Flip Horizontal", (c) => { c.transform.flipHorizontal = next; });
      }}>
        <ArrowLeftRight size={12} stroke-width={2} />
      </IconToggleButton>
      <IconToggleButton on={v()} help={v() ? "Remove vertical flip" : "Flip vertically"} onClick={() => {
        const next = !v();
        props.commit("Flip Vertical", (c) => { c.transform.flipVertical = next; });
      }}>
        <ArrowUpDown size={12} stroke-width={2} />
      </IconToggleButton>
    </InspectorRow>
  );
}

function BlendRow(props: { clips: Accessor<Clip[]>; commit: (name: string, m: (c: Clip) => void) => void }) {
  const current = (): string => props.clips()[0]?.blendMode ?? "normal";
  const mixed = (): boolean => props.clips().length > 1 && !props.clips().every((c) => (c.blendMode ?? "normal") === current());
  return (
    <InspectorRow label="Blend" fixedHeight reservesKeyframeControls modified={valuesModified(props.clips(), resetBlend)} onReset={() => props.commit("Reset Blend Mode", resetBlend)}>
      <DropdownMenuButton
        items={() =>
          blendModes.map((m) => ({
            kind: "item" as const,
            label: blendModeDisplayName(m),
            checked: !mixed() && current() === m,
            onSelect: () =>
              props.commit("Blend Mode", (c) => {
                if (m === "normal") delete c.blendMode;
                else c.blendMode = m;
              }),
          }))
        }
      >
        <EditorMenuValue text={mixed() ? "—" : blendModeDisplayName((current() as typeof blendModes[number]))} />
      </DropdownMenuButton>
    </InspectorRow>
  );
}

function resetEdge(c: Clip, key: "edgeSoftness" | "edgeRounding"): void {
  c[key] = clipDefaults()[key];
}

function resetEdges(c: Clip): void {
  resetEdge(c, "edgeSoftness");
  resetEdge(c, "edgeRounding");
}

function ImageAdjustmentSection(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const [expanded, setExpanded] = createSignal(true);
  const clips = useClips(editor, props.ids);
  const row = (label: string, key: "edgeSoftness" | "edgeRounding") => (
    <InspectorRow label={label} fixedHeight modified={valuesModified(clips(), (c) => resetEdge(c, key))} onReset={() => commitClipProperties(editor, props.ids(), (c) => resetEdge(c, key), `Reset ${label}`)}>
      <ScrubbableNumberField
        value={sharedValue(clips(), (c) => c[key])}
        range={{ min: 0, max: 1 }}
        displayMultiplier={100}
        valueSuffix="%"
        fieldWidth="var(--numeric-field-w)"
        onChanged={(v) => applyClipProperties(editor, props.ids(), (c) => { c[key] = v; })}
        onCancel={() => revertClipProperties(editor, props.ids())}
        onCommit={(v) => commitClipProperties(editor, props.ids(), (c) => { c[key] = v; }, `Change ${label}`)}
      />
    </InspectorRow>
  );
  return (
    <EditorPanelGroup
      title="Image Adjustment"
      expanded={expanded()}
      onToggle={() => setExpanded(!expanded())}
      modified={valuesModified(clips(), resetEdges)}
      onReset={() => commitClipProperties(editor, props.ids(), resetEdges, "Reset Image Adjustment")}
    >
      {row("Edge Softness", "edgeSoftness")}
      {row("Edge Rounding", "edgeRounding")}
    </EditorPanelGroup>
  );
}

/** Port of `speedSection`. */
export function SpeedSection(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const cancel = (): void => {
    const state = dragState(editor);
    const before = state.preDragTimeline;
    if (!before) return;
    editor.withoutRegistration(() => {
      editor.doc.timelines[editor.activeTimelineIndex] = structuredClone(before);
    });
    state.preDragTimeline = undefined;
    state.dragBefore.clear();
  };
  return (
    <Show when={clips().length > 0}>
      <EditorPanelGroup title="Playback">
        <InspectorRow label="Speed" modified={clips().some((c) => c.speed !== clipDefaults().speed)} onReset={() => commitClipSpeed(editor, [...props.ids()], clipDefaults().speed)}>
          <ScrubbableNumberField
            value={sharedValue(clips(), (c) => c.speed)}
            range={{ min: 0.25, max: 4 }}
            format="%.2f"
            valueSuffix="x"
            dragSensitivity={0.01}
            fieldWidth="var(--numeric-field-w)"
            onChanged={(v) => props.ids().forEach((id) => applyClipSpeed(editor, id, v))}
            onCancel={cancel}
            onCommit={(v) => commitClipSpeed(editor, [...props.ids()], v)}
          />
        </InspectorRow>
        <InspectorRow label="Speed ramp" modified={clips().some(clipHasSpeedRamp)} onReset={() => applySpeedRampPreset(editor, [...props.ids()], undefined)}>
          <DropdownMenuButton
            items={() => [
              { kind: "item", label: "None", checked: !clips().some(clipHasSpeedRamp), onSelect: () => applySpeedRampPreset(editor, [...props.ids()], undefined) },
              { kind: "divider" },
              ...speedRampPresets.map((p) => ({
                kind: "item" as const,
                label: p.name,
                onSelect: () => applySpeedRampPreset(editor, [...props.ids()], p.id),
              })),
            ]}
          >
            <EditorMenuValue text={clips().some(clipHasSpeedRamp) ? "Ramped" : "None"} />
          </DropdownMenuButton>
        </InspectorRow>
        <InspectorRow label="Frame blending" modified={clips().some((c) => c.frameBlending === true)} onReset={() => setFrameBlending(editor, [...props.ids()], false)}>
          <Toggle
            label="Frame blending"
            title="Mix adjacent frames when slower than 1x (applied in export)"
            checked={clips().length > 0 && clips().every((c) => c.frameBlending === true)}
            onChange={(on) => setFrameBlending(editor, [...props.ids()], on)}
          />
        </InspectorRow>
      </EditorPanelGroup>
    </Show>
  );
}
