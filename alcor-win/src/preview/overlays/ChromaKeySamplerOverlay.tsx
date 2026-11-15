import { onCleanup, onMount } from "solid-js";
import type { Editor } from "../../editor/editor";
import { cancelChromaKeySampling, commitChromaKeySample } from "../../editor/mutations/chromaKey";
import type { Size } from "../../model/geometry";
import type { PlaybackEngine } from "../playback";
import { keyHueFromRGB } from "./chromaSample";

/**
 * Port of `ChromaKeySamplerOverlayView`: a crosshair surface over the canvas; a click samples a 9x9 patch of the
 * rendered frame and keys that hue. Escape (or a click on nothing keyable) leaves the eyedropper.
 */
export function ChromaKeySamplerOverlay(props: { editor: Editor; size: Size; engine?: () => PlaybackEngine | null | undefined }) {
  let surface: HTMLDivElement | undefined;

  const sample = (e: MouseEvent): void => {
    const clipId = props.editor.ui.chromaKeySamplingClipId;
    const rect = surface?.getBoundingClientRect();
    const engine = props.engine?.();
    if (clipId === null || !rect || !(rect.width > 0 && rect.height > 0) || !engine) return;
    const rgb = engine.sampleRenderedRGB((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    const hue = rgb ? keyHueFromRGB(rgb.r, rgb.g, rgb.b) : undefined;
    if (hue === undefined) {
      props.editor.showToast("Pick a more colorful spot to key.", "error");
      return;
    }
    commitChromaKeySample(props.editor, hue, clipId);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") cancelChromaKeySampling(props.editor);
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return <div class="ov-surface ov-chroma" ref={surface} onClick={sample} />;
}
