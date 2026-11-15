import { sub } from "./e2lib.mjs";
const m = "src/editor/mutations/clipMutations.ts";
sub(m, `  clipClampFadesToDuration(target);

  const rippleDelta`, `  clipClampFadesToDuration(target);
  clipRetimeSpeedRamp(target, basis, newSpeed, newDuration);

  const rippleDelta`);
