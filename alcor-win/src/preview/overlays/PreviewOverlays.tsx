import { Match, Show, Switch, createMemo } from "solid-js";
import { slipPreview } from "../slipPreview";
import { SlipTwoUpView } from "../SlipTwoUpView";
import { CanvasViewingOverlay } from "./CanvasViewingOverlay";
import { CaptionPreviewOverlay } from "../../captions/CaptionPreviewOverlay";
import { captionPreviewConfiguration, captionPreviewEnabled } from "../../captions/previewState";
import type { Editor } from "../../editor/editor";
import type { Size } from "../../model/geometry";
import type { PlaybackEngine } from "../playback";
import { ChromaKeySamplerOverlay } from "./ChromaKeySamplerOverlay";
import { CropOverlay } from "./CropOverlay";
import { MaskOverlay, maskOverlayActive } from "./MaskOverlay";
import { MotionPathOverlay } from "./MotionPathOverlay";
import { TransformOverlay } from "./TransformOverlay";
import "./overlays.css";

export interface PreviewOverlaysProps {
  editor: Editor;
  /** Timeline size in pixels. */
  canvas: Size;
  /** Displayed canvas size in CSS pixels (fit size x zoom). */
  size: Size;
  /** The playback engine, for eyedropper sampling of the rendered frame. */
  engine?: () => PlaybackEngine | null | undefined;
}

type Mode = "chroma" | "crop" | "mask" | "caption" | "transform";

/** Port of the overlay stack in `PreviewContainerView.canvas`: eyedropper, else crop, else caption placement, else transform. */
export function PreviewOverlays(props: PreviewOverlaysProps) {
  const ui = props.editor.ui;
  const mode = createMemo((): Mode => {
    if (ui.chromaKeySamplingClipId !== null) return "chroma";
    if (ui.cropEditingActive) return "crop";
    if (maskOverlayActive(props.editor)) return "mask";
    if (captionPreviewEnabled() && captionPreviewConfiguration() !== null) return "caption";
    return "transform";
  });
  return (
    <>
    <CanvasViewingOverlay size={props.size} />
    <Switch>
      <Match when={mode() === "chroma"}>
        <ChromaKeySamplerOverlay editor={props.editor} size={props.size} engine={props.engine} />
      </Match>
      <Match when={mode() === "crop"}>
        <CropOverlay editor={props.editor} size={props.size} />
      </Match>
      <Match when={mode() === "mask"}>
        <MaskOverlay editor={props.editor} size={props.size} />
      </Match>
      <Match when={mode() === "caption"}>
        <CaptionPreviewOverlay canvas={props.canvas} size={props.size} />
      </Match>
      <Match when={mode() === "transform"}>
        <TransformOverlay editor={props.editor} size={props.size} />
      </Match>
    </Switch>
    <Show when={mode() === "transform"}>
      <MotionPathOverlay editor={props.editor} size={props.size} />
    </Show>
    <Show when={slipPreview()}>{(state) => <SlipTwoUpView state={state()} />}</Show>
    </>
  );
}
