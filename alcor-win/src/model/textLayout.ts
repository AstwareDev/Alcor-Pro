import type { Size } from "./geometry";
import {
  textStyleDisplayText, textStyleGlyphBorderPadding, textStyleScaledVisualStyle, type TextStyle,
} from "./textStyle";

export const textLayoutShadowPadding = 12;
export const textLayoutReferenceCanvasHeight = 1080;

/**
 * Text measurement is platform-bound (CoreText on macOS). The caller supplies a measurer that returns the
 * bounding size of `text` laid out with `style` (already scaled by `fontScale`) at `renderSize` points,
 * wrapped at `maxWidth`.
 */
export type TextMeasurer = (text: string, style: TextStyle, renderSize: number, maxWidth: number) => Size;

/** Swift `Character.isNewline` for the final grapheme. */
function endsWithNewline(text: string): boolean {
  const last = Array.from(text).pop();
  return last !== undefined && /^(\r\n|[\n\v\f\r\u0085\u2028\u2029])$/.test(last);
}

/** CoreText omits a final empty line unless measurement includes a zero-width glyph. */
export function textLayoutMeasurementText(text: string): string {
  return endsWithNewline(text) ? text + "\u200B" : text;
}

/** Natural bounding size of a rendered text clip, shared between the layer controller and clip placement. */
export function textLayoutNaturalSize(
  content: string,
  style0: TextStyle,
  maxWidth: number,
  canvasHeight: number,
  measure: TextMeasurer,
): Size {
  const visualScale = style0.fontScale;
  const style = textStyleScaledVisualStyle(style0);
  const displayText = textStyleDisplayText(style, content);
  const measured = displayText === "" ? " " : displayText;
  const canvasScale = canvasHeight / textLayoutReferenceCanvasHeight;
  const renderSize = style.fontSize * canvasScale;
  const proposedMaxWidth = maxWidth * visualScale;
  const scaledMaxWidth = Number.isFinite(proposedMaxWidth) ? proposedMaxWidth : Number.MAX_VALUE;
  const bounding = measure(textLayoutMeasurementText(measured), style, renderSize, scaledMaxWidth);
  // Four reference pixels absorb canvas→preview scale rounding.
  const slack = Math.max(0, visualScale) * 4;
  const shadowBlur = Math.max(0, style.shadow.blur);
  const shadowX = style.shadow.enabled
    ? Math.max(textLayoutShadowPadding * visualScale, shadowBlur + Math.abs(style.shadow.offsetX)) * canvasScale * 2
    : 0;
  const shadowY = style.shadow.enabled
    ? Math.max(textLayoutShadowPadding * visualScale, shadowBlur + Math.abs(style.shadow.offsetY)) * canvasScale * 2
    : 0;
  const borderPad = style.border.enabled ? textStyleGlyphBorderPadding(style, renderSize) * 2 : 0;
  const backgroundPadX = style.background.enabled ? Math.max(0, style.background.paddingX) * canvasScale * 2 : 0;
  const backgroundPadY = style.background.enabled ? Math.max(0, style.background.paddingY) * canvasScale * 2 : 0;
  return {
    width: Math.max(1, Math.ceil(bounding.width) + shadowX + borderPad + backgroundPadX + slack),
    height: Math.max(1, Math.ceil(bounding.height) + shadowY + borderPad + backgroundPadY + slack),
  };
}
