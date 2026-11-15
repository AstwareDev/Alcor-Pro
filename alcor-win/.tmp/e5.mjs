import { sub } from "./e2lib.mjs";
sub("src/model/index.ts", `export * from "./projectFile";`, `export * from "./projectFile";
export * from "./speedRamp";`);
const sr = "src/model/speedRamp.ts";
sub(sr, `import { setOptional } from "./equality";`, `import { swiftRound } from "../util/math";
import { setOptional } from "./equality";`);
sub(sr, `const totalSource = Math.round(clip.durationFrames * clip.speed) + clip.trimStartFrame + clip.trimEndFrame;`, `const totalSource = swiftRound(clip.durationFrames * clip.speed) + clip.trimStartFrame + clip.trimEndFrame;`);
sub(sr, `Math.max(0, totalSource - Math.round(clip.durationFrames * mean) - clip.trimStartFrame)`, `Math.max(0, totalSource - swiftRound(clip.durationFrames * mean) - clip.trimStartFrame)`);
// split
const cs = "src/model/clipSplit.ts";
sub(cs, `  const leftSource = swiftRound(splitOffset * clip.speed);
  const rightSource = swiftRound((clip.durationFrames - splitOffset) * clip.speed);`, `  const leftSource = swiftRound(clipSourceFramesAt(clip, splitOffset));
  const rightSource = swiftRound(clipSourceFramesAt(clip, clip.durationFrames) - clipSourceFramesAt(clip, splitOffset));`);
sub(cs, `  assignSplit(left, right, "volumeTrack", splitKeyframeTrack(clip.volumeTrack, splitOffset, clip.volume, doubleInterpolator));`, `  assignSplit(left, right, "volumeTrack", splitKeyframeTrack(clip.volumeTrack, splitOffset, clip.volume, doubleInterpolator));
  if (clipHasSpeedRamp(clip)) {
    assignSplit(left, right, "speedTrack", splitKeyframeTrack(clip.speedTrack, splitOffset, clip.speed, doubleInterpolator));
    left.speed = speedTrackMean(left.speedTrack as KeyframeTrack<number>, left.durationFrames, clip.speed);
    right.speed = speedTrackMean(right.speedTrack as KeyframeTrack<number>, right.durationFrames, clip.speed);
  }`);
sub(cs, `type TrackKey = "opacityTrack" |`, `type TrackKey = "speedTrack" | "opacityTrack" |`);
sub(cs, `import { maskPathInterpolator,`, `import { clipHasSpeedRamp, clipSourceFramesAt, speedTrackMean } from "./speedRamp";
import { maskPathInterpolator,`);
