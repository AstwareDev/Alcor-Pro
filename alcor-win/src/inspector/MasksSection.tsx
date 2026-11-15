import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import {
  clipContainsTimelineFrame, clipTypeIsVisual, maskExpansionAt, maskExpansionRange, maskFeatherAt, maskFeatherMax, maskKeyframeFrames,
  maskModes, maskOpacityAt, maskTrack, type Clip, type Mask, type MaskMode, type MaskProperty, type MaskTool,
} from "../model";
import type { Editor } from "../editor/editor";
import { seekToFrame } from "../editor/mutations/core";
import {
  applyMask, cancelMask, commitMask, duplicateMask, removeMask, renameMask, reorderMask, resetMaskProperty, toggleMaskKeyframe,
  type MaskPatch,
} from "../editor/mutations/masks";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { KeyframeControlStrip } from "../ui/KeyframeControlStrip";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { useClips } from "./fields";
import "./masksSection.css";

const modeLabels: Record<MaskMode, string> = { add: "Add", subtract: "Subtract", intersect: "Intersect", difference: "Difference" };

const tools: { tool: MaskTool; label: string }[] = [
  { tool: "rectangle", label: "Rectangle" },
  { tool: "ellipse", label: "Ellipse" },
  { tool: "pen", label: "Pen" },
];

const toolHint: Record<MaskTool, string> = {
  rectangle: "Drag in the preview to draw a rectangle mask.",
  ellipse: "Drag in the preview to draw an ellipse mask.",
  pen: "Click in the preview to place points, drag to curve. Click the first point to close.",
};

/** Masks of the single selected visual clip: tool buttons, one row per mask, details for the selected mask. */
export function MasksSection(props: { editor: Editor; ids: Accessor<readonly string[]> }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const [expanded, setExpanded] = createSignal(true);
  const clip = createMemo((): Clip | undefined => {
    const c = props.ids().length === 1 ? clips()[0] : undefined;
    return c && clipTypeIsVisual(c.mediaType) ? c : undefined;
  });
  // Top of the stack first, like the preview shows it.
  const rows = createMemo(() => [...(clip()?.masks ?? [])].reverse());
  const toggleTool = (tool: MaskTool): void => {
    editor.ui.maskTool = editor.ui.maskTool === tool ? null : tool;
  };

  return (
    <Show when={clip()}>
      {(c) => (
        <EditorPanelGroup title="Masks" expanded={expanded()} onToggle={() => setExpanded(!expanded())}>
          <div class="mask-tools">
            <For each={tools}>
              {(t) => (
                <button
                  type="button"
                  class="mask-tool-button"
                  classList={{ on: editor.ui.maskTool === t.tool }}
                  aria-pressed={editor.ui.maskTool === t.tool}
                  title={toolHint[t.tool]}
                  onClick={() => toggleTool(t.tool)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <Show when={editor.ui.maskTool}>{(tool) => <div class="mask-hint">{toolHint[tool()]}</div>}</Show>
          <Show when={rows().length === 0 && !editor.ui.maskTool}>
            <div class="mask-hint">Pick a tool, then draw on the preview.</div>
          </Show>
          <For each={rows()}>{(mask) => <MaskRow editor={editor} clipId={c().id} maskId={mask.id} />}</For>
        </EditorPanelGroup>
      )}
    </Show>
  );
}

function MaskRow(props: { editor: Editor; clipId: string; maskId: string }) {
  const { editor } = props;
  const mask = createMemo(() => editor.clipFor(props.clipId)?.masks?.find((m) => m.id === props.maskId));
  const selected = (): boolean => editor.ui.selectedMaskId === props.maskId;
  const [renaming, setRenaming] = createSignal(false);

  const finishRename = (text: string): void => {
    setRenaming(false);
    renameMask(editor, props.clipId, props.maskId, text);
  };

  return (
    <Show when={mask()}>
      {(m) => (
        <div class="mask-row" classList={{ selected: selected() }}>
          <div class="mask-row-head" onClick={() => { editor.ui.selectedMaskId = selected() ? null : props.maskId; }}>
            <Show
              when={renaming()}
              fallback={
                <span class="mask-name" title="Double-click to rename" onDblClick={(e) => { e.stopPropagation(); setRenaming(true); }}>
                  {m().name}
                </span>
              }
            >
              <input
                class="mask-name-input"
                value={m().name}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => finishRename(e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") finishRename(e.currentTarget.value);
                  else if (e.key === "Escape") setRenaming(false);
                }}
              />
            </Show>
            <span class="mask-row-actions" onClick={(e) => e.stopPropagation()}>
              <button type="button" class="mask-link" title="Move up in the stack" onClick={() => reorderMask(editor, props.clipId, props.maskId, indexOf(editor, props, 1))}>Up</button>
              <button type="button" class="mask-link" title="Move down in the stack" onClick={() => reorderMask(editor, props.clipId, props.maskId, indexOf(editor, props, -1))}>Down</button>
              <button type="button" class="mask-link" title="Duplicate mask" onClick={() => duplicateMask(editor, props.clipId, props.maskId)}>Duplicate</button>
              <button type="button" class="mask-link danger" title="Delete mask" onClick={() => removeMask(editor, props.clipId, props.maskId)}>Delete</button>
            </span>
          </div>
          <Show when={selected()}>
            <MaskDetails editor={editor} clipId={props.clipId} mask={m} />
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Index in the mask stack after moving by `step` display rows (display is reversed, so +1 = up = higher index). */
function indexOf(editor: Editor, p: { clipId: string; maskId: string }, step: number): number {
  const masks = editor.clipFor(p.clipId)?.masks ?? [];
  return masks.findIndex((m) => m.id === p.maskId) + step;
}

interface NumberFieldSpec {
  label: string;
  property: Exclude<MaskProperty, "path">;
  range: { min: number; max: number };
  multiplier?: number;
  format: string;
  suffix?: string;
  value: (m: Mask, offset: number) => number;
  fallback: number;
}

const numberFields: NumberFieldSpec[] = [
  { label: "Feather", property: "feather", range: { min: 0, max: maskFeatherMax }, format: "%.0f", suffix: " px", value: maskFeatherAt, fallback: 0 },
  { label: "Expansion", property: "expansion", range: maskExpansionRange, format: "%.0f", suffix: " px", value: maskExpansionAt, fallback: 0 },
  { label: "Opacity", property: "opacity", range: { min: 0, max: 1 }, multiplier: 100, format: "%.0f", suffix: "%", value: maskOpacityAt, fallback: 1 },
];

function MaskDetails(props: { editor: Editor; clipId: string; mask: Accessor<Mask> }) {
  const { editor } = props;
  const patch = (p: MaskPatch): void => commitMask(editor, props.clipId, props.mask().id, p);
  return (
    <div class="mask-details">
      <InspectorRow label="Mode" fixedHeight reservesKeyframeControls>
        <DropdownMenuButton
          items={() => maskModes.map((mode) => ({
            kind: "item" as const, label: modeLabels[mode], checked: props.mask().mode === mode, onSelect: () => patch({ mode }),
          }))}
          title="How this mask combines with the masks below"
        >
          <EditorMenuValue text={modeLabels[props.mask().mode]} />
        </DropdownMenuButton>
      </InspectorRow>
      <InspectorRow label="Invert" fixedHeight reservesKeyframeControls>
        <label class="mask-check">
          <input type="checkbox" checked={props.mask().inverted} onChange={(e) => patch({ inverted: e.currentTarget.checked })} />
        </label>
      </InspectorRow>
      <For each={numberFields}>{(spec) => <MaskNumberRow editor={editor} clipId={props.clipId} mask={props.mask} spec={spec} />}</For>
      <InspectorRow
        label="Shape"
        help="Edit the shape on the preview. Keyframes store the whole outline."
        modified={maskTrack(props.mask(), "path") !== undefined}
        onReset={() => resetMaskProperty(editor, props.clipId, props.mask().id, "path")}
      >
        <span class="mask-shape-note">{props.mask().path.vertices.length} points</span>
        <MaskKeyframes editor={editor} clipId={props.clipId} mask={props.mask} property="path" />
      </InspectorRow>
    </div>
  );
}

function MaskNumberRow(props: { editor: Editor; clipId: string; mask: Accessor<Mask>; spec: NumberFieldSpec }) {
  const { editor, spec } = props;
  const clip = (): Clip | undefined => editor.clipFor(props.clipId) ?? undefined;
  const offset = (): number => editor.ui.currentFrame - (clip()?.startFrame ?? 0);
  const animated = (): boolean => (maskTrack(props.mask(), spec.property)?.keyframes.length ?? 0) > 0;
  const inRange = (): boolean => {
    const c = clip();
    return c !== undefined && clipContainsTimelineFrame(c, editor.ui.currentFrame);
  };
  const write = (v: number, commit: boolean): void => {
    const p: MaskPatch = { [spec.property]: v };
    // An animated property edited while the playhead is outside the clip has nowhere to write.
    if (animated() && !inRange()) return;
    if (commit) commitMask(editor, props.clipId, props.mask().id, p);
    else applyMask(editor, props.clipId, props.mask().id, p);
  };
  return (
    <InspectorRow
      label={spec.label}
      modified={animated() || props.mask()[spec.property] !== spec.fallback}
      onReset={() => resetMaskProperty(editor, props.clipId, props.mask().id, spec.property)}
    >
      <ScrubbableNumberField
        value={spec.value(props.mask(), offset())}
        range={spec.range}
        displayMultiplier={spec.multiplier}
        format={spec.format}
        valueSuffix={spec.suffix}
        fieldWidth="var(--numeric-field-w)"
        onInteractionStart={() => { if (editor.ui.isPlaying) editor.ui.isPlaying = false; }}
        onChanged={(v) => write(v, false)}
        onCancel={() => cancelMask(editor, props.clipId)}
        onCommit={(v) => write(v, true)}
      />
      <MaskKeyframes editor={editor} clipId={props.clipId} mask={props.mask} property={spec.property} />
    </InspectorRow>
  );
}

function MaskKeyframes(props: { editor: Editor; clipId: string; mask: Accessor<Mask>; property: MaskProperty }) {
  const { editor } = props;
  const state = createMemo(() => {
    const clip = editor.clipFor(props.clipId);
    if (!clip) return null;
    const frame = editor.ui.currentFrame;
    const frames = maskKeyframeFrames(props.mask(), props.property).map((f) => f + clip.startFrame);
    return {
      inRange: clipContainsTimelineFrame(clip, frame),
      previous: frames.filter((f) => f < frame).reduce<number | undefined>((m, f) => (m === undefined || f > m ? f : m), undefined),
      next: frames.filter((f) => f > frame).reduce<number | undefined>((m, f) => (m === undefined || f < m ? f : m), undefined),
      on: frames.includes(frame),
      any: frames.length > 0,
    };
  });
  return (
    <KeyframeControlStrip
      onPrevious={state()?.previous === undefined ? undefined : () => seekToFrame(editor, state()?.previous ?? 0)}
      onKeyframe={state()?.inRange ? () => toggleMaskKeyframe(editor, props.clipId, props.mask().id, props.property, editor.ui.currentFrame) : undefined}
      onNext={state()?.next === undefined ? undefined : () => seekToFrame(editor, state()?.next ?? 0)}
      isOnKeyframe={state()?.on ?? false}
      hasKeyframes={state()?.any ?? false}
      unavailableKeyframeHelp="Move playhead inside the clip"
    />
  );
}
