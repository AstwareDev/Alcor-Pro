import { sub } from "./e2lib.mjs";
sub("src/editor/mutations/clipMutations.ts", `  clipRescaleWordTimings,
  clipSetBlurKeyframeTrack,`, `  clipRescaleWordTimings,
  clipRetimeSpeedRamp,
  clipSetBlurKeyframeTrack,`);
