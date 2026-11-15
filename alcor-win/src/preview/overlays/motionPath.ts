import { clipSizeAt, clipTopLeftAt, type Clip } from "../../model";
import type { Point, Size } from "../../model/geometry";

export interface MotionKeyframePoint {
  /** Clip-relative frame of the keyframe. */
  offset: number;
  /** Clip center in overlay pixels. */
  point: Point;
}

const maxPathSamples = 240;

/** The clip's center at an absolute timeline frame, in overlay pixels. */
export function centerPixelAt(clip: Clip, frame: number, size: Size): Point {
  const tl = clipTopLeftAt(clip, frame);
  const sz = clipSizeAt(clip, frame);
  return { x: (tl.x + sz.width / 2) * size.width, y: (tl.y + sz.height / 2) * size.height };
}

/** Polyline points ("x,y x,y ...") of the center over the clip, sampled per frame (capped), or "" when not animated. */
export function motionPathPoints(clip: Clip, size: Size): string {
  const track = clip.positionTrack;
  if (!track || track.keyframes.length < 2) return "";
  const first = track.keyframes[0]?.frame ?? 0;
  const last = track.keyframes[track.keyframes.length - 1]?.frame ?? 0;
  const span = Math.max(1, last - first);
  const steps = Math.min(span, maxPathSamples);
  let out = "";
  for (let i = 0; i <= steps; i++) {
    const p = centerPixelAt(clip, clip.startFrame + first + (span * i) / steps, size);
    out += `${i === 0 ? "" : " "}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  return out;
}

export function motionKeyframePoints(clip: Clip, size: Size): MotionKeyframePoint[] {
  const track = clip.positionTrack;
  if (!track) return [];
  return track.keyframes.map((k) => ({ offset: k.frame, point: centerPixelAt(clip, clip.startFrame + k.frame, size) }));
}

/** Top-left (normalized, the stored position value) that puts the clip's center at the pixel `p` for the keyframe at `frame`. */
export function topLeftForCenterPixel(clip: Clip, frame: number, p: Point, size: Size): { x: number; y: number } {
  const sz = clipSizeAt(clip, frame);
  return { x: p.x / size.width - sz.width / 2, y: p.y / size.height - sz.height / 2 };
}
