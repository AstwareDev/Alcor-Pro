import { createSignal } from "solid-js";
import type { RGBA, TextAnimationPreset, TextStyle } from "../model";
import type { Point2 } from "./captionPreviewPlacement";

// EditorViewModel.captionPreviewConfiguration / captionPreviewEnabled / captionPreviewCenterChange. The editor class
// is fixed, so the caption preview state is module-level (there is one preview and one captions tab).

export interface CaptionPreviewConfiguration {
  text: string;
  style: TextStyle;
  center: Point2;
  preset: TextAnimationPreset;
  highlight: RGBA | undefined;
}

const [configuration, setConfiguration] = createSignal<CaptionPreviewConfiguration | null>(null);
const [enabled, setEnabled] = createSignal(true);
let centerChange: ((center: Point2) => void) | null = null;

/** Reactive. */
export const captionPreviewConfiguration = configuration;
export const setCaptionPreviewConfiguration = setConfiguration;
/** Reactive. */
export const captionPreviewEnabled = enabled;
export const setCaptionPreviewEnabled = setEnabled;

export function setCaptionPreviewCenterChange(handler: ((center: Point2) => void) | null): void {
  centerChange = handler;
}

export function notifyCaptionPreviewCenterChange(center: Point2): void {
  centerChange?.(center);
}
