import { createSignal } from "solid-js";
import type { Editor } from "../editor/editor";
import { linkedPartnerIds } from "../editor/mutations/linking";
import { mediaUrl } from "../media/mediaUrl";
import { clipSourceFramesConsumed, type Clip } from "../model";
import { swiftRound } from "../util/math";

/** Port of `SlipPreviewState`: the viewer two-up published while a slip drag is active. */
export interface SlipPreviewState {
  /** Fetchable media url. */
  url: string;
  inSourceFrame: number;
  outSourceFrame: number;
  fps: number;
}

const [slipPreview, setSlipPreviewSignal] = createSignal<SlipPreviewState | null>(null, {
  equals: (a, b) => a === b || (a !== null && b !== null && a.url === b.url && a.inSourceFrame === b.inSourceFrame && a.outSourceFrame === b.outSourceFrame && a.fps === b.fps),
});

/** The in-flight slip's two-up state; null when no slip drag is running. */
export { slipPreview };
export const setSlipPreview = (state: SlipPreviewState | null): void => { setSlipPreviewSignal(state); };

/**
 * `slipPreviewState(for:deltaFrames:linked:)`: the previewed in/out source frames of the slipped clip, or of its
 * linked video partner when the grab is on audio. Null when there is no video to show.
 */
export function slipPreviewState(editor: Editor, clip: Clip, deltaFrames: number, linked: boolean): SlipPreviewState | null {
  let display: Clip = clip;
  if (display.mediaType !== "video" || display.sourceClipType === "sequence") {
    if (!linked) return null;
    const partner = linkedPartnerIds(editor, clip.id)
      .map((id) => editor.clipFor(id))
      .find((c): c is Clip => c != null && c.mediaType === "video" && c.sourceClipType !== "sequence");
    if (!partner) return null;
    display = partner;
  }
  const asset = editor.mediaAsset(display.mediaRef);
  if (!asset) return null;
  const sourceDelta = swiftRound(deltaFrames * display.speed);
  const applied = Math.max(-display.trimEndFrame, Math.min(display.trimStartFrame, sourceDelta));
  const inFrame = display.trimStartFrame - applied;
  const outFrame = inFrame + Math.max(0, clipSourceFramesConsumed(display) - 1);
  return { url: mediaUrl(asset.url), inSourceFrame: inFrame, outSourceFrame: outFrame, fps: editor.timeline.fps };
}
