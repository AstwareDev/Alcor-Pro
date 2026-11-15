import { createMemo, createSignal, For } from "solid-js";
import {
  makeTextStyle, makeTransform, presetDisplayName, textAnimationPerLinePresets, textAnimationPerWordPresets, type RGBA,
  type TextAnimationPreset,
} from "../model";
import { AnimatedCaptionCanvas } from "./AnimatedCaptionCanvas";
import { captionPreviewClip, captionPreviewLoopFrames } from "./captionPreviewRender";
import "./captions.css";

const cellWidth = 84;
const cellHeight = 48;
const sample = "Aa Bb Cc";

/** Port of `CaptionPresetCell`: animates on hover or when selected, otherwise a settled poster frame. */
function CaptionPresetCell(props: { preset: TextAnimationPreset; selected: boolean; highlight: RGBA | undefined; onSelect: () => void }) {
  const [hovering, setHovering] = createSignal(false);
  const clip = createMemo(() =>
    captionPreviewClip({
      content: sample,
      style: makeTextStyle({ fontSize: 300 }),
      transform: makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.92, height: 0.55 }),
      preset: props.preset,
      highlight: props.highlight,
    }),
  );
  return (
    <button
      type="button"
      class="cap-preset-cell"
      classList={{ selected: props.selected }}
      aria-pressed={props.selected}
      aria-label={presetDisplayName(props.preset)}
      onClick={props.onSelect}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <span class="cap-preset-thumb">
        <AnimatedCaptionCanvas
          clip={clip}
          width={() => cellWidth}
          height={() => cellHeight}
          animating={() => props.preset !== "none" && (hovering() || props.selected)}
          posterFrame={() => captionPreviewLoopFrames(props.preset) - 1}
        />
      </span>
      <span class="cap-preset-name">{presetDisplayName(props.preset)}</span>
    </button>
  );
}

/** Port of `CaptionPresetGallery`: animation preset picker rendered by the same text renderer the compositor uses. */
export function CaptionPresetGallery(props: {
  selection: TextAnimationPreset;
  highlight?: RGBA | undefined;
  onSelect: (preset: TextAnimationPreset) => void;
}) {
  const section = (title: string, presets: readonly TextAnimationPreset[]) => (
    <div class="cap-preset-section">
      <span class="cap-preset-title">{title}</span>
      <div class="cap-preset-grid">
        <For each={presets}>
          {(preset) => (
            <CaptionPresetCell preset={preset} selected={props.selection === preset} highlight={props.highlight} onSelect={() => props.onSelect(preset)} />
          )}
        </For>
      </div>
    </div>
  );
  return (
    <div class="cap-preset-gallery">
      {section("Per line", ["none", ...textAnimationPerLinePresets])}
      {section("Per word", textAnimationPerWordPresets)}
    </div>
  );
}
