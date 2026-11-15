import { sub } from "./e2lib.mjs";
import fs from "fs";
const p = "src/model/speedRamp.ts";
let s = fs.readFileSync(p, "utf8");
const i = s.indexOf("  const k = clip.speed / speedTrackMean(raw, duration, 1);");
s = s.slice(0, i) + `  const k = clip.speed / speedTrackMean(raw, duration, 1);
  // Clamping to the speed range moves the mean, so correct the scale once.
  const k2 = (k * clip.speed) / speedTrackMean(scaled(raw, k), duration, 1);
  return scaled(raw, k2);
}

function scaled(track: KeyframeTrack<number>, k: number): KeyframeTrack<number> {
  const out = cloneKeyframeTrack(track);
  for (const kf of out.keyframes) kf.value = clampSpeed(kf.value * k);
  return out;
}
`;
s = s.replace("cloneKeyframeTrack, keyframeEase, keyframeTrackIsActive, makeKeyframe, makeKeyframeTrack, splitKeyframeTrackPoint,", "cloneKeyframeTrack, keyframeEase, keyframeTrackIsActive, makeKeyframe, makeKeyframeTrack,");
fs.writeFileSync(p, s);
