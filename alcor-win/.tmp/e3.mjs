import { sub } from "./e2lib.mjs";
const t = "src/model/timeline.ts";
sub(t, `  volumeTrack?: KeyframeTrack<number>;

  effects?: Effect[];`, `  volumeTrack?: KeyframeTrack<number>;

  /** Speed ramp: speed multiplier keyframes (clip-relative frames). \`speed\` then holds the ramp's mean. */
  speedTrack?: KeyframeTrack<number>;
  /** Mix adjacent source frames when playing slower than 1x (export). */
  frameBlending?: boolean;

  effects?: Effect[];`);
sub(t, `"cropTrack", "volumeTrack",
    "effects", "blendMode", "masks",`, `"cropTrack", "volumeTrack",
    "speedTrack", "frameBlending", "effects", "blendMode", "masks",`);
sub(t, `  setOptional(clip, "volumeTrack", clampedKeyframeTrack(clip, clip.volumeTrack));
  clipSetBlurKeyframeTrack(clip, clampedKeyframeTrack(`, `  setOptional(clip, "volumeTrack", clampedKeyframeTrack(clip, clip.volumeTrack));
  setOptional(clip, "speedTrack", clampedKeyframeTrack(clip, clip.speedTrack));
  clipSetBlurKeyframeTrack(clip, clampedKeyframeTrack(`);
sub(t, `  setOptional(clip, "volumeTrack", rescaledKeyframeTrack(clip, clip.volumeTrack, scale));`, `  setOptional(clip, "volumeTrack", rescaledKeyframeTrack(clip, clip.volumeTrack, scale));
  setOptional(clip, "speedTrack", rescaledKeyframeTrack(clip, clip.speedTrack, scale));`);
sub(t, `    volumeTrack: tryWith(c, "volumeTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    effects:`, `    volumeTrack: tryWith(c, "volumeTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    speedTrack: tryWith(c, "speedTrack", (v) => decodeKeyframeTrack(v, decodeDouble)),
    frameBlending: tryBool(c, "frameBlending"),
    effects:`);
