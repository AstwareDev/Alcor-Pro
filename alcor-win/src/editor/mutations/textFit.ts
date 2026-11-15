import { makeTextStyle, textLayoutNaturalSize, transformTopLeft, type Clip, type TextMeasurer } from "../../model";

/**
 * Port of fitTextClipToContentIfNeeded: resizes a text clip's box to its content, keeping the alignment edge fixed
 * and scaling scale keyframes with it. Mutates `clip`; returns true if it changed.
 */
export function fitTextClipToContent(clip: Clip, canvasW: number, canvasH: number, measure: TextMeasurer): boolean {
  if (clip.mediaType !== "text") return false;
  const style = clip.textStyle ?? makeTextStyle();
  const natural = textLayoutNaturalSize(clip.textContent ?? " ", style, canvasW * 0.9, canvasH, measure);
  const needW = natural.width / canvasW;
  const needH = natural.height / canvasH;
  const currentW = clip.transform.width;
  const currentH = clip.transform.height;
  if (Math.abs(needW - currentW) < 0.0001 && Math.abs(needH - currentH) < 0.0001) return false;
  const tl = transformTopLeft(clip.transform);
  const cy = tl.y + currentH / 2;
  const cx =
    style.alignment === "left" ? tl.x + needW / 2 : style.alignment === "right" ? tl.x + currentW - needW / 2 : tl.x + currentW / 2;
  if (clip.scaleTrack && currentW > 0 && currentH > 0) {
    for (const kf of clip.scaleTrack.keyframes) {
      kf.value.a *= needW / currentW;
      kf.value.b *= needH / currentH;
    }
  }
  clip.transform.centerX = cx;
  clip.transform.centerY = cy;
  clip.transform.width = needW;
  clip.transform.height = needH;
  return true;
}
