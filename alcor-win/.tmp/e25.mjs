import { sub } from "./e2lib.mjs";
const t = "src/model/speedRamp.test.ts";
sub(t, `expect(clipSourceFramesAt(clip, 20)).toBeCloseTo(20, 6);
    expect(clipSourceFramesAt(clip, 60)).toBeCloseTo(20 + 80, 6);
    expect(clipSourceFramesAt(clip, 100)).toBeCloseTo(100 + 160, 6);`, `expect(clipSourceFramesAt(clip, 20)).toBeCloseTo(40, 6);
    expect(clipSourceFramesAt(clip, 60)).toBeCloseTo(40 + 80, 6);
    expect(clipSourceFramesAt(clip, 100)).toBeCloseTo(120 + 160, 6);`);
sub(t, `trimStart: 10, trimEnd: 40, speed: 1`, `trimStart: 10, trimEnd: 80, speed: 1`);
